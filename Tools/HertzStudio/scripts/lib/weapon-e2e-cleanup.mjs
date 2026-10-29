/**
 * Fail-closed cleanup for W04 browser-E2E weapon catalog entries.
 * Operates by exact weapon ID only — never by display-name row order.
 */

export const E2E_WEAPON_NAME_PREFIX = "E2E Left Pistol";

export function makeE2eWeaponName(runId) {
  const id = String(runId || "").trim();
  if (!id) throw new Error("runId required for E2E weapon name");
  return `${E2E_WEAPON_NAME_PREFIX} ${id}`;
}

export function isE2eWeaponName(displayName) {
  const name = String(displayName || "");
  return name === E2E_WEAPON_NAME_PREFIX || name.startsWith(`${E2E_WEAPON_NAME_PREFIX} `);
}

/**
 * Decide cleanup path from a weapon snapshot + dependency list.
 * @returns {"already_gone"|"direct_delete"|"unity_delete_then_catalog"|"wait_jobs"|"blocked"}
 */
export function decideCleanupPath({ weapon, dependencies = [] } = {}) {
  if (!weapon || weapon.missing) return "already_gone";
  const kinds = new Set((dependencies || []).map((d) => d.kind));
  if (kinds.has("loadout_left") || kinds.has("loadout_right")) return "blocked";
  if (kinds.has("sync_job") || kinds.has("unity_sync_state")) return "wait_jobs";
  if (kinds.has("unity_mapping")) return "unity_delete_then_catalog";
  const mapping =
    weapon.unitySync?.assetGuid ||
    weapon.unitySync?.assetPath ||
    weapon.mapping?.assetGuid ||
    weapon.mapping?.assetPath;
  if (mapping) return "unity_delete_then_catalog";
  return "direct_delete";
}

function depKinds(dependencies) {
  return [...new Set((dependencies || []).map((d) => d.kind))].sort();
}

async function readJson(apiFetch, path, opts) {
  const res = await apiFetch(path, opts);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, json };
}

/**
 * Cleanup one E2E weapon by exact ID through authenticated Studio APIs.
 *
 * @param {object} args
 * @param {string} args.weaponId
 * @param {(path:string, opts?:object) => Promise<Response>} args.apiFetch
 * @param {(args:{assetGuid?:string,assetPath?:string,weaponId:string}) => Promise<{exists?:boolean,ok?:boolean,disconnected?:boolean}>} [args.resolveUnityAsset]
 * @param {(ms:number)=>Promise<void>} [args.sleep]
 * @param {()=>number} [args.now]
 * @param {number} [args.timeoutMs]
 * @param {number} [args.pollMs]
 * @param {string[]} [args.protectWeaponIds] — must remain untouched
 */
export async function cleanupE2eWeaponById({
  weaponId,
  apiFetch,
  resolveUnityAsset = null,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  timeoutMs = 90000,
  pollMs = 1500,
  protectWeaponIds = [],
} = {}) {
  if (!weaponId) {
    return { ok: false, error: "weaponId required", proof: null };
  }
  if (typeof apiFetch !== "function") {
    return { ok: false, error: "apiFetch required", proof: null };
  }

  const protectedBefore = {};
  for (const id of protectWeaponIds) {
    const snap = await readJson(apiFetch, `/api/weapons/${id}`);
    protectedBefore[id] = snap.ok ? snap.json : { missing: true, status: snap.status };
  }

  const deadline = now() + timeoutMs;
  let hadMapping = false;
  let lastGuid = null;
  let lastPath = null;
  let unityDeleteAttempts = 0;
  const maxUnityDeleteAttempts = 3;
  let path = null;
  let lastDeleteError = null;
  let usedUnityDelete = false;

  while (now() < deadline) {
    const get = await readJson(apiFetch, `/api/weapons/${weaponId}`);
    if (get.status === 404 || (get.json && get.json.error && /not found/i.test(get.json.error))) {
      path = path || "already_gone";
      break;
    }
    if (!get.ok) {
      return {
        ok: false,
        error: `GET weapon ${weaponId} failed HTTP ${get.status}`,
        proof: null,
      };
    }

    const weapon = get.json;
    const depsRes = await readJson(apiFetch, `/api/weapons/${weaponId}/dependencies`);
    const dependencies = depsRes.json?.dependencies || [];
    // If we already queued a Unity delete, stay on that path until catalog is removed.
    path = usedUnityDelete
      ? "unity_delete_then_catalog"
      : decideCleanupPath({ weapon, dependencies });

    if (path === "blocked") {
      return {
        ok: false,
        error: `cleanup blocked for ${weaponId}; remaining dependencies: ${depKinds(dependencies).join(",") || "unknown"}`,
        proof: null,
      };
    }

    if (path === "wait_jobs") {
      await sleep(pollMs);
      continue;
    }

    if (path === "unity_delete_then_catalog") {
      hadMapping = true;
      lastGuid = lastGuid || weapon.unitySync?.assetGuid || null;
      lastPath = lastPath || weapon.unitySync?.assetPath || null;
      const stillMapped = (dependencies || []).some((d) => d.kind === "unity_mapping");
      const busy = (dependencies || []).some(
        (d) => d.kind === "sync_job" || d.kind === "unity_sync_state",
      );

      // Re-enqueue when idle but mapping remains (prior delete job may have failed).
      if (stillMapped && !busy) {
        if (weapon.unitySync?.state === "failed" && weapon.unitySync?.lastError) {
          lastDeleteError = weapon.unitySync.lastError;
        }
        if (unityDeleteAttempts >= maxUnityDeleteAttempts) {
          return {
            ok: false,
            error: `Unity delete failed for ${weaponId} after ${unityDeleteAttempts} attempts: ${lastDeleteError || "mapping remains"}`,
            proof: null,
          };
        }
        const delUnity = await readJson(apiFetch, `/api/weapons/${weaponId}/unity-delete`, {
          method: "POST",
          body: JSON.stringify({}),
          headers: { "content-type": "application/json" },
        });
        if (!delUnity.ok && delUnity.json?.code !== "no_unity_mapping") {
          return {
            ok: false,
            error: `Unity delete enqueue failed for ${weaponId}: ${delUnity.json?.error || delUnity.status}`,
            proof: null,
          };
        }
        unityDeleteAttempts += 1;
        usedUnityDelete = true;
        await sleep(pollMs);
        continue;
      }

      if (stillMapped || busy) {
        await sleep(pollMs);
        continue;
      }
      // Mapping cleared (or was cleared by Unity ack) — remove catalog with unity_deleted.
      const catalogDel = await readJson(
        apiFetch,
        `/api/weapons/${weaponId}?unassignLoadout=1&unityResolution=unity_deleted`,
        { method: "DELETE" },
      );
      if (!catalogDel.ok && catalogDel.status !== 404) {
        // Mapping may have cleared between polls — retry loop.
        if (catalogDel.json?.code === "dependency_blocked") {
          await sleep(pollMs);
          continue;
        }
        return {
          ok: false,
          error: `Catalog delete after Unity ack failed for ${weaponId}: ${catalogDel.json?.error || catalogDel.status}`,
          proof: null,
        };
      }
      path = "unity_delete_then_catalog";
      break;
    }

    // direct_delete (never used after a Unity-delete attempt)
    const catalogDel = await readJson(apiFetch, `/api/weapons/${weaponId}?unassignLoadout=1`, {
      method: "DELETE",
    });
    if (!catalogDel.ok && catalogDel.status !== 404) {
      if (catalogDel.json?.code === "dependency_blocked") {
        await sleep(pollMs);
        continue;
      }
      return {
        ok: false,
        error: `Direct catalog delete failed for ${weaponId}: ${catalogDel.json?.error || catalogDel.status}`,
        proof: null,
      };
    }
    path = "direct_delete";
    break;
  }

  if (now() >= deadline && path !== "already_gone") {
    const depsRes = await readJson(apiFetch, `/api/weapons/${weaponId}/dependencies`);
    const kinds = depKinds(depsRes.json?.dependencies || []);
    return {
      ok: false,
      error: `cleanup timeout for ${weaponId}; remaining dependencies: ${kinds.join(",") || "none/unknown"}`,
      proof: null,
    };
  }

  // Verify gone.
  const gone = await readJson(apiFetch, `/api/weapons/${weaponId}`);
  const catalogGone = gone.status === 404 || Boolean(gone.json?.error);
  if (!catalogGone) {
    return { ok: false, error: `weapon ${weaponId} still in catalog after cleanup`, proof: null };
  }

  const list = await readJson(apiFetch, "/api/weapons");
  const weapons = list.json?.weapons || [];
  const mappingStill = weapons.some(
    (w) =>
      w.id === weaponId ||
      (w.unitySync?.assetGuid && lastGuid && w.unitySync.assetGuid === lastGuid),
  );
  // Mapping lives on weapon entry; also check dependencies on a probe via list of IDs is enough.
  // Active jobs: ask dependencies endpoint (404 is fine) / scan jobs if API exposes them — use list weapons only.
  let activeJobsRemain = false;
  // Re-check deps on missing weapon should 404.
  const depsGone = await readJson(apiFetch, `/api/weapons/${weaponId}/dependencies`);
  if (depsGone.ok && (depsGone.json?.dependencies || []).length) {
    activeJobsRemain = (depsGone.json.dependencies || []).some(
      (d) => d.kind === "sync_job" || d.kind === "unity_sync_state" || d.kind === "unity_mapping",
    );
  }

  let unityGone = true;
  if (hadMapping && typeof resolveUnityAsset === "function" && (lastGuid || lastPath)) {
    const resolved = await resolveUnityAsset({
      assetGuid: lastGuid,
      assetPath: lastPath,
      weaponId,
    });
    if (resolved?.disconnected) {
      return {
        ok: false,
        error: `Unity resolve unavailable while verifying delete for ${weaponId}`,
        proof: null,
      };
    }
    unityGone = resolved?.exists !== true && resolved?.ok !== true;
  }

  for (const id of protectWeaponIds) {
    const snap = await readJson(apiFetch, `/api/weapons/${id}`);
    const before = protectedBefore[id];
    if (before?.missing) {
      if (snap.ok) {
        return {
          ok: false,
          error: `protected weapon ${id} unexpectedly appeared`,
          proof: null,
        };
      }
      continue;
    }
    if (!snap.ok || snap.json?.id !== id) {
      return {
        ok: false,
        error: `protected weapon ${id} missing or changed after cleanup`,
        proof: null,
      };
    }
  }

  const proof = {
    weaponId,
    catalogGone: true,
    mappingGone: !mappingStill && !activeJobsRemain,
    unityDefinitionGone: unityGone,
    noActiveDeleteOrSyncJob: !activeJobsRemain,
    path,
    usedRetainUnity: false,
    deletedModelAsset: false,
  };

  const ok =
    proof.catalogGone &&
    proof.mappingGone &&
    proof.unityDefinitionGone &&
    proof.noActiveDeleteOrSyncJob &&
    !proof.usedRetainUnity &&
    !proof.deletedModelAsset;

  return {
    ok,
    error: ok ? null : `cleanup verification failed for ${weaponId}`,
    proof,
  };
}

/**
 * Combine primary E2E failure with cleanup failure for reporting.
 */
export function combineE2eAndCleanupErrors(primaryError, cleanupError) {
  if (!primaryError && !cleanupError) return null;
  if (primaryError && cleanupError) {
    return `E2E failed: ${primaryError}; cleanup failed: ${cleanupError}`;
  }
  return primaryError || cleanupError;
}
