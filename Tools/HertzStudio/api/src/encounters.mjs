/**
 * W12 Encounters — resolve real profiles/prefabs; Unity revision + runtime commands.
 */
import { randomUUID } from "node:crypto";
import { loadStore, saveStore } from "./store.mjs";
import { assertStudioTargetScene, scenePathsEqual } from "./sceneIdentity.mjs";
import { postUnityBridge } from "./unityBridgeClient.mjs";
import { getAsset } from "./assets/catalog.mjs";
import { getEnemyProfile } from "./characters.mjs";

function ensure(store) {
  if (!store.encounters) store.encounters = { definitions: {}, runtime: {} };
  if (!store.encounters.definitions) store.encounters.definitions = {};
  if (!store.encounters.runtime) store.encounters.runtime = {};
  return store;
}

function resolveEnemyProfile(_store, profileId) {
  return getEnemyProfile(profileId);
}

export function listEncounters({ scenePath } = {}) {
  const store = ensure(loadStore());
  let list = Object.values(store.encounters.definitions);
  if (scenePath) list = list.filter((e) => scenePathsEqual(e.scenePath, scenePath));
  return { encounters: list };
}

export async function upsertEncounter(body = {}) {
  const store = ensure(loadStore());
  const scenePath = assertStudioTargetScene(body.scenePath);
  const expectedUnityRevision =
    body.expectedUnityRevision != null ? Number(body.expectedUnityRevision) : null;
  if (expectedUnityRevision == null || !Number.isFinite(expectedUnityRevision)) {
    const err = new Error("expectedUnityRevision from Unity scene inventory is required.");
    err.code = "revision_required";
    throw err;
  }

  const spawns = Array.isArray(body.spawns) ? body.spawns : [];
  for (const s of spawns) {
    if (!Number.isFinite(s.delaySeconds) || s.delaySeconds < 0) {
      const err = new Error("Spawn delaySeconds must be >= 0.");
      err.code = "invalid_timing";
      throw err;
    }
    if (!Number.isFinite(s.count) || s.count < 1 || s.count > 100) {
      const err = new Error("Spawn count must be 1..100.");
      err.code = "invalid_count";
      throw err;
    }
    if (!s.enemyProfileId && !s.prefabAssetId) {
      const err = new Error("Each spawn needs enemyProfileId or prefabAssetId.");
      err.code = "missing_reference";
      throw err;
    }
    if (s.enemyProfileId) {
      const profile = resolveEnemyProfile(store, s.enemyProfileId);
      if (!profile) {
        const err = new Error(`Unknown enemyProfileId ${s.enemyProfileId}.`);
        err.code = "missing_reference";
        throw err;
      }
      if (profile.unitySync?.state !== "applied" || !profile.unitySync?.assetPath) {
        const err = new Error(`Enemy profile ${profile.displayName} must be synced to Unity first.`);
        err.code = "missing_reference";
        throw err;
      }
    }
    if (s.prefabAssetId) {
      const asset = getAsset(s.prefabAssetId);
      if (!asset) {
        const err = new Error(`Unknown prefabAssetId ${s.prefabAssetId}.`);
        err.code = "missing_reference";
        throw err;
      }
      if (asset.state !== "unity_imported" && asset.unity?.readiness !== "ready") {
        const err = new Error(`Prefab ${s.prefabAssetId} is not unity_imported.`);
        err.code = "missing_reference";
        throw err;
      }
    }
  }

  const bridge = await postUnityBridge(
    "/encounters/validate",
    {
      scenePath,
      sceneGuid: body.sceneGuid || null,
      expectedUnityRevision,
      spawns: spawns.map((s) => ({
        delaySeconds: Number(s.delaySeconds) || 0,
        count: Number(s.count) || 1,
        spacingMeters: Number.isFinite(s.spacingMeters) ? Number(s.spacingMeters) : 1,
        enemyProfileId: s.enemyProfileId || null,
        prefabAssetId: s.prefabAssetId || null,
        prefabUnityPath: s.prefabAssetId ? getAsset(s.prefabAssetId)?.unity?.prefabPath || getAsset(s.prefabAssetId)?.unity?.assetPath : null,
        behaviorProfileId: s.behaviorProfileId || s.enemyProfileId || null,
        behaviorProfileUnityPath: s.enemyProfileId ? resolveEnemyProfile(store, s.enemyProfileId)?.unitySync?.assetPath || null : null,
        position: s.position || { x: 0, y: 0, z: 0 },
        trigger: s.trigger || "on_start",
      })),
    },
    { timeoutMs: 20000 },
  );
  if (!bridge.ok) {
    const err = new Error(bridge.error || bridge.data?.message || "Unity encounter validation failed.");
    err.code = bridge.data?.code || (bridge.status === 0 ? "unity_offline" : "unity_validate_failed");
    throw err;
  }
  if (bridge.data?.affectsTrackedXr === true) {
    const err = new Error("Encounter would affect tracked XR/camera objects.");
    err.code = "xr_protected";
    throw err;
  }

  const id = body.id && store.encounters.definitions[body.id] ? body.id : randomUUID();
  const existing = store.encounters.definitions[id];
  if (body.expectedVersion != null && existing && Number(body.expectedVersion) !== Number(existing.version)) {
    const err = new Error(`Stale encounter version: expected ${body.expectedVersion}, have ${existing.version}.`);
    err.code = "stale_version";
    throw err;
  }

  const def = {
    id,
    displayName: String(body.displayName || "Encounter").slice(0, 80),
    scenePath,
    sceneGuid: body.sceneGuid || null,
    unityRevision: bridge.data?.unityRevision ?? expectedUnityRevision,
    version: existing ? (Number(existing.version) || 1) + 1 : 1,
    spawns: spawns.map((s) => ({
      id: s.id || randomUUID(),
      delaySeconds: Number(s.delaySeconds) || 0,
      count: Number(s.count) || 1,
      spacingMeters: Number.isFinite(s.spacingMeters) ? Number(s.spacingMeters) : 1,
      enemyProfileId: s.enemyProfileId || null,
      prefabAssetId: s.prefabAssetId || null,
      behaviorProfileId: s.behaviorProfileId || null,
      position: s.position || { x: 0, y: 0, z: 0 },
      trigger: s.trigger || "on_start",
      objectId: s.objectId || null,
    })),
    startCondition: body.startCondition || "manual",
    completionCondition: body.completionCondition || "all_cleared",
    unityAssetPath: bridge.data?.encounterAssetPath || null,
    source: "unity_validated",
    updatedAt: new Date().toISOString(),
  };

  if (body.applyToUnity === true) {
    const apply = await postUnityBridge(
      "/encounters/apply",
      { ...def, expectedUnityRevision, saveScene: true },
      { timeoutMs: 30000 },
    );
    if (!apply.ok) {
      const err = new Error(apply.error || "Unity encounter apply failed.");
      err.code = apply.data?.code || "unity_apply_failed";
      throw err;
    }
    def.unityRevision = apply.data?.unityRevision ?? def.unityRevision;
    def.unityAssetPath = apply.data?.encounterAssetPath || def.unityAssetPath;
    def.applied = true;
  }

  store.encounters.definitions[id] = def;
  saveStore(store);
  return def;
}

export async function resetEncounterRuntime(encounterId, body = {}) {
  const store = ensure(loadStore());
  const def = store.encounters.definitions[encounterId];
  if (!def) {
    const err = new Error("Encounter not found.");
    err.code = "unknown_id";
    throw err;
  }
  const requestId = String(body.requestId || "").trim() || `encounter-reset-${encounterId}-${def.version}`;
  const existing = store.encounters.runtime[requestId];
  if (existing) {
    return { ok: true, deduplicated: true, ...existing };
  }
  const command = body.command === "spawn" || body.command === "start" ? body.command : "reset";
  const bridge = await postUnityBridge(
    "/encounters/runtime",
    {
      encounterId,
      version: def.version,
      requestId,
      command,
      scenePath: def.scenePath,
      sceneGuid: def.sceneGuid || null,
    },
    { timeoutMs: 20000 },
  );
  if (!bridge.ok) {
    const err = new Error(bridge.error || "Unity encounter runtime command failed.");
    err.code = bridge.data?.code || (bridge.status === 0 ? "unity_offline" : "unity_runtime_failed");
    throw err;
  }
  const ack = {
    ok: true,
    encounterId,
    version: def.version,
    requestId,
    command,
    clearedRuntimeCount: bridge.data?.clearedRuntimeCount,
    spawnedRuntimeCount: bridge.data?.spawnedRuntimeCount,
    markerCount: bridge.data?.markerCount,
    unityAck: bridge.data || null,
    note:
      command === "reset"
        ? "Versioned runtime reset applied in Unity — cleared *_Runtime instances under the managed encounter root; markers retained."
        : "Versioned runtime spawn applied in Unity — enemy agents instantiated at encounter markers.",
    at: new Date().toISOString(),
  };
  store.encounters.runtime[requestId] = ack;
  saveStore(store);
  return ack;
}
