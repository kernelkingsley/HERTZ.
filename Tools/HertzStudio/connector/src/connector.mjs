import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isUnityHealthReachable } from "./unityHealth.mjs";
import { probeHeadsets } from "./headsetStatus.mjs";

export { isUnityHealthReachable };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Studio root: Tools/HertzStudio */
const ROOT = path.resolve(__dirname, "../..");
const CONFIG_PATH = path.join(ROOT, "data/connector-config.json");
const BRIDGE_TOKEN_PATH = path.join(ROOT, "data/secrets/bridge-token.json");
const PID_PATH = path.join(ROOT, "data/connector.pid");
const IDENTITY_PATH = path.join(ROOT, "data/connector.identity.json");
const W07_DELIVERY_PROOF_PATH = path.join(ROOT, "data/w07-connector-delivery-proof.json");
function boundedMilliseconds(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

const POLL_MS = boundedMilliseconds(process.env.HERTZ_POLL_MS, 1500, 250, 10000);
const HEADSET_POLL_MS = boundedMilliseconds(process.env.HERTZ_HEADSET_POLL_MS, 7500, 5000, 10000);
// Health must fail quickly so independent ADB polling continues when Unity owns a zombie socket.
const UNITY_HEALTH_TIMEOUT_MS = boundedMilliseconds(
  process.env.HERTZ_UNITY_HEALTH_TIMEOUT_MS,
  3500,
  500,
  10000,
);
// Mutating/export operations may legitimately wait on Unity's main thread; keep their bound wider.
const UNITY_REQUEST_TIMEOUT_MS = boundedMilliseconds(
  process.env.HERTZ_UNITY_REQUEST_TIMEOUT_MS,
  20000,
  1000,
  120000,
);

/**
 * Unity project root is two levels above Tools/HertzStudio (…/HERTZ),
 * verified by Assets + ProjectSettings presence.
 */
export function resolveUnityProjectRoot(studioRoot = ROOT) {
  const candidate = path.resolve(studioRoot, "../..");
  const assets = path.join(candidate, "Assets");
  const settings = path.join(candidate, "ProjectSettings");
  if (!fs.existsSync(assets) || !fs.existsSync(settings)) {
    throw new Error(
      `Unity project root not found near ${candidate}. Expected Assets/ and ProjectSettings/.`,
    );
  }
  return candidate;
}

function acquireSingleInstance() {
  fs.mkdirSync(path.dirname(PID_PATH), { recursive: true });
  if (fs.existsSync(PID_PATH)) {
    const prev = Number(fs.readFileSync(PID_PATH, "utf8").trim());
    if (Number.isFinite(prev) && prev > 0) {
      try {
        process.kill(prev, 0);
        throw new Error(
          `Another HERTZ connector is already running (PID ${prev}). Stop it first: npm run stop:connector`,
        );
      } catch (err) {
        if (err.code !== "ESRCH" && !/not running|ESRCH/i.test(err.message) && err.message.includes("already running")) {
          throw err;
        }
        // Stale pid file
      }
    }
  }
  fs.writeFileSync(PID_PATH, String(process.pid), "utf8");
  const identity = {
    pid: process.pid,
    nonce: randomUUID(),
    startedAt: new Date().toISOString(),
    studioRoot: ROOT,
    argv1: process.argv[1] || "",
    script: "connector.mjs",
  };
  fs.writeFileSync(IDENTITY_PATH, JSON.stringify(identity, null, 2), "utf8");
  const release = () => {
    try {
      if (fs.existsSync(PID_PATH) && Number(fs.readFileSync(PID_PATH, "utf8").trim()) === process.pid) {
        fs.unlinkSync(PID_PATH);
      }
    } catch {
      /* ignore */
    }
    try {
      if (fs.existsSync(IDENTITY_PATH)) {
        const cur = JSON.parse(fs.readFileSync(IDENTITY_PATH, "utf8"));
        if (cur.pid === process.pid && cur.nonce === identity.nonce) fs.unlinkSync(IDENTITY_PATH);
      }
    } catch {
      /* ignore */
    }
  };
  process.on("exit", release);
  process.on("SIGINT", () => {
    release();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    release();
    process.exit(0);
  });
}

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return null;
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  let tokenBridgePort = null;
  if (fs.existsSync(BRIDGE_TOKEN_PATH)) {
    const raw = fs.readFileSync(BRIDGE_TOKEN_PATH, "utf8").replace(/^\uFEFF/, "");
    const bridge = JSON.parse(raw);
    if (!config.bridgeToken && bridge.bridgeToken) {
      config.bridgeToken = bridge.bridgeToken;
    }
    const port = Number(bridge.bridgePort);
    if (Number.isFinite(port) && port >= 1024 && port <= 65535) {
      tokenBridgePort = port;
    }
  }
  config.apiBaseUrl = config.apiBaseUrl || process.env.HERTZ_API_URL || "http://127.0.0.1:8787";
  // Prefer explicit env, then live bridge-token port (survives 8791 zombie failover), then config.
  config.unityBridgeUrl =
    process.env.HERTZ_UNITY_BRIDGE_URL ||
    (tokenBridgePort ? `http://127.0.0.1:${tokenBridgePort}` : null) ||
    config.unityBridgeUrl ||
    "http://127.0.0.1:8791";
  return config;
}

async function api(config, pathname, { method = "GET", body } = {}) {
  const res = await fetch(`${config.apiBaseUrl}${pathname}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-hertz-connector-token": config.connectorToken,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${pathname}`);
  return data;
}

export async function requestUnity(
  config,
  pathname,
  { method = "GET", body, timeoutMs = UNITY_REQUEST_TIMEOUT_MS } = {},
) {
  const headers = { "Content-Type": "application/json" };
  if (config.bridgeToken) {
    headers["x-hertz-bridge-token"] = config.bridgeToken;
  }
  const res = await fetch(`${config.unityBridgeUrl}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

const unity = requestUnity;

async function ack(config, body) {
  await api(config, "/api/connector/ack", { method: "POST", body });
}

async function handleAssetImport(config, command) {
  const asset = command.asset;
  if (!asset?.id) {
    await api(config, "/api/connector/ack-asset", {
      method: "POST",
      body: { requestId: command.requestId, ok: false, error: "Missing asset payload" },
    });
    return;
  }

  const fileRes = await fetch(`${config.apiBaseUrl}/api/connector/assets/${asset.id}/file`, {
    headers: { "x-hertz-connector-token": config.connectorToken },
  });
  if (!fileRes.ok) {
    await api(config, "/api/connector/ack-asset", {
      method: "POST",
      body: { requestId: command.requestId, ok: false, error: `Blob download failed (${fileRes.status})` },
    });
    return;
  }

  const buf = Buffer.from(await fileRes.arrayBuffer());
  const ext = asset.fileFormat ? `.${asset.fileFormat}` : ".bin";
  const projectRoot = resolveUnityProjectRoot(ROOT);
  // Stage outside Assets so Unity does not auto-import mid-copy / retry.
  // Library/HertzStudioIncoming/<assetId>/<requestId>/ — project-local, gitignored via Library/.
  const requestId = command.requestId;
  const packageRoot = path.join(projectRoot, "Library/HertzStudioIncoming", asset.id, requestId);
  fs.mkdirSync(packageRoot, { recursive: true });
  // Keep real entrypoint filename (e.g. scene.gltf) so glTF URIs stay valid; do not use displayName.
  const rawEntry =
    asset.entrypointFileName ||
    (asset.fileFormat ? `scene.${asset.fileFormat}` : "asset.bin");
  const entryName = path.basename(String(rawEntry)).replace(/[^\w.\-]+/g, "_") || `asset${ext}`;
  const finalExt = ext.startsWith(".") ? ext : `.${ext || "bin"}`;
  const finalEntryName = path.extname(entryName) ? entryName : `${entryName}${finalExt}`;
  const absFile = path.join(packageRoot, finalEntryName);
  fs.writeFileSync(absFile, buf);

  const deps = Array.isArray(asset.unity?.dependencies) ? asset.unity.dependencies : [];
  const stagedDeps = [];
  for (const dep of deps) {
    if (!dep?.blobName) continue;
    const rel = String(dep.relativePath || path.basename(dep.blobName)).replace(/\\/g, "/");
    if (!rel || rel.includes("..") || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
      continue;
    }
    const depAbs = path.resolve(packageRoot, rel);
    if (!depAbs.startsWith(path.resolve(packageRoot) + path.sep)) continue;
    const depRes = await fetch(
      `${config.apiBaseUrl}/api/connector/assets/${asset.id}/dependency/${encodeURIComponent(dep.blobName)}`,
      { headers: { "x-hertz-connector-token": config.connectorToken } },
    );
    if (!depRes.ok) continue;
    const depBuf = Buffer.from(await depRes.arrayBuffer());
    fs.mkdirSync(path.dirname(depAbs), { recursive: true });
    fs.writeFileSync(depAbs, depBuf);
    stagedDeps.push({
      relativePath: rel,
      sourcePath: path.relative(projectRoot, depAbs).replace(/\\/g, "/"),
      fileName: path.basename(rel),
    });
  }

  const relativeSource = path.relative(projectRoot, absFile).replace(/\\/g, "/");
  const accept = await unity(config, "/assets/import", {
    method: "POST",
    body: {
      requestId,
      assetId: asset.id,
      fileName: finalEntryName,
      displayName: asset.displayName || path.basename(finalEntryName, path.extname(finalEntryName)),
      sourcePath: relativeSource,
      createPrefab: asset.assetType === "model_3d" || asset.assetType === "animation",
      dependencies: stagedDeps,
    },
  });

  let terminal = accept.data;
  // Pollable result: never treat main-thread timeout as failure while the same request is in flight.
  if (
    accept.status === 202 ||
    terminal?.status === "accepted" ||
    terminal?.status === "in_progress"
  ) {
    terminal = await pollImportStatus(config, requestId, {
      timeoutMs: Number(process.env.HERTZ_IMPORT_POLL_MS || 300000),
      intervalMs: Number(process.env.HERTZ_IMPORT_POLL_INTERVAL_MS || 1500),
    });
  } else if (accept.status === 504 || /timed out/i.test(String(terminal?.error || ""))) {
    terminal = await pollImportStatus(config, requestId, {
      timeoutMs: Number(process.env.HERTZ_IMPORT_POLL_MS || 300000),
      intervalMs: Number(process.env.HERTZ_IMPORT_POLL_INTERVAL_MS || 1500),
    });
  }

  const applied = terminal?.status === "applied";
  let placedScenePath = null;
  let placeError = null;
  let placedGlobalObjectId = null;
  let placedUnityRevision = null;
  let placeCode = null;
  let blockingScenes = null;
  if (applied && command.scenePath) {
    const placement = command.placement;
    if (!placement || placement.confirmSave !== true || placement.assetId !== asset.id || placement.scenePath !== command.scenePath) {
      placeError = "Missing or mismatched immutable placement confirmation.";
    } else {
    const place = await placeAssetInUnity(config, {
      requestId: `${requestId}:place`,
      assetId: asset.id,
      scenePath: command.scenePath,
      prefabPath: terminal?.prefabPath || null,
      importedPath: terminal?.importedPath || null,
      displayName: asset.displayName,
      position: placement.position,
      rotation: placement.rotation,
      scale: placement.scale,
      expectedUnityRevision: placement.expectedUnityRevision,
      confirmSave: placement.confirmSave,
    });
    if (place.ok) {
      placedScenePath = place.scenePath || command.scenePath;
      placedGlobalObjectId = place.globalObjectId || null;
      placedUnityRevision = place.unityRevision;
    } else {
      placeError = place.error || "Place in scene failed after import.";
      placeCode = place.code || null;
      blockingScenes = place.blockingScenes || null;
    }
    }
  }

  await api(config, "/api/connector/ack-asset", {
    method: "POST",
    body: {
      requestId,
      ok: applied,
      error: terminal?.message || terminal?.error,
      importedPath: terminal?.importedPath || null,
      prefabPath: terminal?.prefabPath || null,
      placedScenePath,
      placeError,
      globalObjectId: placedGlobalObjectId,
      unityRevision: placedUnityRevision,
      placeCode,
      blockingScenes,
    },
  });
  console.log(
    `Asset import ${requestId}: ${applied ? "Applied" : "Failed"} → ${terminal?.importedPath || terminal?.error || ""}` +
      (placedScenePath ? ` · placed in ${placedScenePath}` : placeError ? ` · place failed: ${placeError}` : ""),
  );
}

async function placeAssetInUnity(config, {
  requestId,
  assetId,
  scenePath,
  prefabPath,
  importedPath,
  displayName,
  position,
  rotation,
  scale,
  expectedUnityRevision,
  confirmSave,
}) {
  const body = {
    requestId,
    assetId,
    scenePath,
    prefabPath: prefabPath || null,
    importedPath: importedPath || null,
    displayName: displayName || null,
    confirmSave,
  };
  if (position) body.position = position;
  if (rotation) body.rotation = rotation;
  if (scale) body.scale = scale;
  if (Number.isFinite(expectedUnityRevision)) body.expectedUnityRevision = expectedUnityRevision;

  const result = await unity(config, "/assets/place", {
    method: "POST",
    body,
  });
  const data = result.data || {};
  const ok = result.ok && data.status === "applied";
  const code = data.code || null;
  return {
    ok,
    scenePath: data.scenePath || scenePath,
    error: data.message || data.error || (!ok ? `HTTP ${result.status}` : null),
    code,
    blockingScenes: data.blockingScenes || null,
    globalObjectId: data.globalObjectId || null,
    unityRevision: data.unityRevision,
    deduplicated: Boolean(data.deduplicated),
    data,
  };
}

async function handlePlaceInScene(config, command) {
  const asset = command.asset;
  if (!asset?.id) {
    await api(config, "/api/connector/ack-asset", {
      method: "POST",
      body: { requestId: command.requestId, ok: false, error: "Missing asset on place job." },
    });
    return;
  }
  if (!command.scenePath) {
    await api(config, "/api/connector/ack-asset", {
      method: "POST",
      body: { requestId: command.requestId, ok: false, error: "scenePath required." },
    });
    return;
  }
  const placement = command.placement;
  if (!placement || placement.confirmSave !== true || placement.assetId !== asset.id || placement.scenePath !== command.scenePath) {
    await api(config, "/api/connector/ack-asset", {
      method: "POST",
      body: { requestId: command.requestId, ok: false, error: "Missing or mismatched immutable placement confirmation." },
    });
    return;
  }

  const place = await placeAssetInUnity(config, {
    requestId: command.requestId,
    assetId: asset.id,
    scenePath: command.scenePath,
    prefabPath: asset.unity?.prefabPath || null,
    importedPath: asset.unity?.importedPath || null,
    displayName: asset.displayName,
    position: placement.position,
    rotation: placement.rotation,
    scale: placement.scale,
    expectedUnityRevision: placement.expectedUnityRevision,
    confirmSave: placement.confirmSave,
  });

  await api(config, "/api/connector/ack-asset", {
    method: "POST",
    body: {
      requestId: command.requestId,
      ok: place.ok,
      error: place.error,
      importedPath: asset.unity?.importedPath || null,
      prefabPath: asset.unity?.prefabPath || null,
      placedScenePath: place.ok ? place.scenePath : null,
      placeError: place.ok ? null : place.error,
      globalObjectId: place.globalObjectId || null,
      unityRevision: place.unityRevision,
      placeCode: place.code || null,
      blockingScenes: place.blockingScenes || null,
      deduplicated: place.deduplicated || false,
    },
  });
  console.log(
    `Place ${command.requestId}: ${place.ok ? (place.deduplicated ? "Deduped" : "Applied") : "Failed"} → ${place.scenePath || place.error || ""}`,
  );
}

async function pollImportStatus(config, requestId, { timeoutMs = 300000, intervalMs = 1500 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = await unity(config, `/assets/import-status?requestId=${encodeURIComponent(requestId)}`, {
      method: "GET",
    });
    const data = status.data || {};
    if (data.status === "applied" || data.status === "failed" || data.status === "conflict") {
      return data;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { status: "failed", error: `Import poll timed out after ${timeoutMs}ms`, requestId };
}

async function handleWeaponSync(config, command) {
  const payload = command.payload || {};
  if (!payload.weaponId || !payload.payloadHash) {
    await api(config, "/api/connector/ack-weapon", {
      method: "POST",
      body: {
        requestId: command.requestId,
        ok: false,
        error: "Missing weapon sync payload (weaponId/payloadHash).",
      },
    });
    return;
  }

  // Never invent GUID/path — only forward Unity bridge response.
  // Omit null modelPrefabPath/expectedAssetGuid so Unity ReadString does not
  // treat the next JSON key name as a string value.
  const unityBody = {
    requestId: command.requestId,
    weaponId: payload.weaponId,
    displayName: payload.displayName,
    role: payload.role,
    enabled: payload.enabled,
    frequencyFlipRequired: payload.frequencyFlipRequired,
    version: payload.version,
    payloadHash: payload.payloadHash,
    assetPath: payload.assetPath,
    tuning: payload.tuning,
  };
  if (payload.modelPrefabPath) unityBody.modelPrefabPath = payload.modelPrefabPath;
  if (payload.expectedAssetGuid) unityBody.expectedAssetGuid = payload.expectedAssetGuid;

  const result = await unity(config, "/weapons/sync", {
    method: "POST",
    body: unityBody,
  });

  const applied = result.ok && result.data?.status === "applied";
  const conflict = result.status === 409 || result.data?.status === "conflict";
  await api(config, "/api/connector/ack-weapon", {
    method: "POST",
    body: {
      requestId: command.requestId,
      ok: applied,
      conflict,
      error: result.data?.error || result.data?.message || (applied ? null : `Unity HTTP ${result.status}`),
      assetGuid: applied ? result.data.assetGuid : null,
      assetPath: applied ? result.data.assetPath : null,
      observedPayloadHash: applied ? result.data.observedPayloadHash : null,
      observedVersion: applied ? result.data.observedVersion : null,
      unityRevision: result.data?.unityRevision,
      modelImported: result.data?.modelImported,
      definitionSynced: result.data?.definitionSynced,
      anchorsValid: result.data?.anchorsValid,
      runtimeDeployApplied: result.data?.runtimeDeployApplied,
      runtimePlayable: result.data?.runtimePlayable,
      missingAnchors: result.data?.missingAnchors,
      prefabPath: result.data?.prefabPath,
    },
  });
  console.log(
    `Weapon sync ${command.requestId}: ${conflict ? "Conflict" : applied ? "Applied" : "Failed"} (HTTP ${result.status})`,
  );
}

async function handleCharacterCommand(config, command) {
  const payload = command.payload || {};
  const type = command.type;
  let path = "/characters/sync-model";
  if (type === "sync_enemy_profile") path = "/characters/sync-profile";
  if (type === "deploy_character_runtime") path = "/characters/deploy";
  if (type === "delete_character_definition" || type === "delete_enemy_profile") path = "/characters/delete";

  const body = {
    requestId: command.requestId,
    ...payload,
  };
  const result = await unity(config, path, { method: "POST", body });
  const applied = result.ok && result.data?.status === "applied";
  const conflict = result.status === 409 || result.data?.status === "conflict";
  await api(config, "/api/connector/ack-character", {
    method: "POST",
    body: {
      requestId: command.requestId,
      ok: applied,
      conflict,
      error: result.data?.error || result.data?.message || (applied ? null : `Unity HTTP ${result.status}`),
      assetGuid: applied ? result.data.assetGuid : null,
      assetPath: applied ? result.data.assetPath : null,
      observedPayloadHash: applied ? result.data.observedPayloadHash : null,
      observedVersion: applied ? result.data.observedVersion : null,
      unityRevision: result.data?.unityRevision,
      scenePath: applied ? result.data.scenePath : null,
      sceneGuid: applied ? result.data.sceneGuid : null,
      managedObjectIds: applied ? result.data.managedObjectIds : null,
    },
  });
  console.log(`Character ${type} ${command.requestId}: ${applied ? "Applied" : "Failed"} (HTTP ${result.status})`);
}

async function handleSoundSync(config, command) {
  const payload = command.payload || {};
  if (!payload.payloadHash) {
    await api(config, "/api/connector/ack-sound", {
      method: "POST",
      body: {
        requestId: command.requestId,
        ok: false,
        error: "Missing sound sync payloadHash.",
      },
    });
    return;
  }

  const result = await unity(config, "/sound/sync", {
    method: "POST",
    body: {
      requestId: command.requestId,
      ...payload,
    },
  });
  const applied = result.ok && result.data?.status === "applied";
  const conflict = result.status === 409 || result.data?.status === "conflict";
  const acknowledgement = await api(config, "/api/connector/ack-sound", {
    method: "POST",
    body: {
      requestId: command.requestId,
      ok: applied,
      conflict,
      error: result.data?.error || result.data?.message || (applied ? null : `Unity HTTP ${result.status}`),
      assetGuid: applied ? result.data.assetGuid : null,
      assetPath: applied ? result.data.assetPath : null,
      observedPayloadHash: applied ? result.data.observedPayloadHash : null,
      unityRevision: result.data?.unityRevision,
    },
  });
  const observedPayloadHash = result.data?.observedPayloadHash || null;
  if (
    applied &&
    acknowledgement.ok &&
    observedPayloadHash === payload.payloadHash
  ) {
    const receipt = {
      schemaVersion: 1,
      proof: "w07-connector-delivery",
      ok: true,
      source: "live_studio_connector",
      requestId: command.requestId,
      payloadHash: payload.payloadHash,
      observedPayloadHash,
      unityApplied: true,
      apiAcknowledged: true,
      unityRevision: result.data?.unityRevision ?? null,
      generatedAt: new Date().toISOString(),
    };
    const temporaryPath = `${W07_DELIVERY_PROOF_PATH}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryPath, W07_DELIVERY_PROOF_PATH);
  }
  console.log(
    `Sound sync ${command.requestId}: ${conflict ? "Conflict" : applied ? "Applied" : "Failed"} (HTTP ${result.status})`,
  );
}

async function handleWeaponDelete(config, command) {
  const payload = command.payload || {};
  if (!payload.weaponId) {
    await api(config, "/api/connector/ack-weapon", {
      method: "POST",
      body: {
        requestId: command.requestId,
        ok: false,
        error: "Missing weapon delete payload (weaponId).",
      },
    });
    return;
  }

  const result = await unity(config, "/weapons/delete", {
    method: "POST",
    body: {
      requestId: command.requestId,
      weaponId: payload.weaponId,
      expectedAssetGuid: payload.expectedAssetGuid,
      assetPath: payload.assetPath,
    },
  });

  const applied = result.ok && result.data?.status === "applied";
  const conflict = result.status === 409 || result.data?.status === "conflict";
  await api(config, "/api/connector/ack-weapon", {
    method: "POST",
    body: {
      requestId: command.requestId,
      ok: applied,
      conflict,
      error: result.data?.error || result.data?.message || (applied ? null : `Unity HTTP ${result.status}`),
      assetGuid: result.data?.assetGuid || null,
      assetPath: result.data?.assetPath || null,
    },
  });
  console.log(
    `Weapon delete ${command.requestId}: ${conflict ? "Conflict" : applied ? "Applied" : "Failed"} (HTTP ${result.status})`,
  );
}

async function handleWeaponDeploy(config, command) {
  const payload = command.payload || {};
  if (!payload.weaponId || !payload.scenePath || !payload.sceneGuid) {
    await api(config, "/api/connector/ack-weapon", {
      method: "POST",
      body: {
        requestId: command.requestId,
        ok: false,
        error: "Missing weapon deploy payload (weaponId/scenePath/sceneGuid).",
      },
    });
    return;
  }

  const result = await unity(config, "/weapons/deploy", {
    method: "POST",
    body: {
      requestId: command.requestId,
      weaponId: payload.weaponId,
      role: payload.role,
      scenePath: payload.scenePath,
      sceneGuid: payload.sceneGuid,
      expectedUnityRevision: payload.expectedUnityRevision,
      confirmSave: payload.confirmSave !== false,
      assetGuid: payload.assetGuid,
      assetPath: payload.assetPath,
      managedObjectId: payload.managedObjectId,
      version: payload.version,
      payloadHash: payload.payloadHash,
      tuning: payload.tuning,
      displayName: payload.displayName,
      enabled: payload.enabled,
      frequencyFlipRequired: payload.frequencyFlipRequired,
    },
  });

  const applied = result.ok && result.data?.status === "applied";
  const conflict = result.status === 409 || result.data?.status === "conflict";
  await api(config, "/api/connector/ack-weapon", {
    method: "POST",
    body: {
      requestId: command.requestId,
      ok: applied,
      conflict,
      error: result.data?.error || result.data?.message || (applied ? null : `Unity HTTP ${result.status}`),
      // Reuse assetGuid field for managedObjectId so Studio can record deploy identity.
      assetGuid: applied ? result.data.managedObjectId || result.data.assetGuid : null,
      assetPath: applied ? result.data.scenePath || result.data.assetPath : null,
      scenePath: applied ? result.data.scenePath : null,
      sceneGuid: applied ? result.data.sceneGuid : null,
      observedPayloadHash: applied ? payload.payloadHash : null,
      observedVersion: applied ? payload.version : null,
      unityRevision: result.data?.unityRevision,
      modelImported: result.data?.modelImported,
      definitionSynced: result.data?.definitionSynced,
      anchorsValid: result.data?.anchorsValid,
      runtimeDeployApplied: result.data?.runtimeDeployApplied,
      runtimePlayable: result.data?.runtimePlayable,
      missingAnchors: result.data?.missingAnchors,
      prefabPath: result.data?.prefabPath,
    },
  });
  console.log(
    `Weapon deploy ${command.requestId}: ${conflict ? "Conflict" : applied ? "Applied" : "Failed"} (HTTP ${result.status})`,
  );
}

async function handleCommand(config, command) {
  if (command.type === "import_asset") {
    await handleAssetImport(config, command);
    return;
  }

  if (command.type === "place_in_scene") {
    await handlePlaceInScene(config, command);
    return;
  }

  if (command.type === "sync_weapon_definition") {
    await handleWeaponSync(config, command);
    return;
  }

  if (command.type === "delete_weapon_definition") {
    await handleWeaponDelete(config, command);
    return;
  }

  if (command.type === "deploy_weapon_runtime") {
    await handleWeaponDeploy(config, command);
    return;
  }

  if (command.type === "sync_sound_board") {
    await handleSoundSync(config, command);
    return;
  }

  if (
    command.type === "sync_character_model" ||
    command.type === "sync_enemy_profile" ||
    command.type === "delete_character_definition" ||
    command.type === "delete_enemy_profile"
  ) {
    await handleCharacterCommand(config, command);
    return;
  }

  if (
    command.type === "apply_positions" ||
    command.type === "apply_transform_edits" ||
    command.type === "apply_scene_commands"
  ) {
    const result = await unity(config, "/scene/apply", {
      method: "POST",
      body: {
        requestId: command.requestId,
        draftVersion: command.draftVersion,
        baseUnityRevision: command.baseUnityRevision,
        scenePath: command.scenePath,
        schemaVersion: command.schemaVersion || 1,
        operations: command.operations || [],
        edits: command.edits,
      },
    });
    const conflict = result.status === 409 || result.data.status === "conflict";
    const applied = result.ok && result.data.status === "applied";
    await ack(config, {
      requestId: command.requestId,
      ok: applied,
      conflict,
      unityRevision: result.data.unityRevision,
      error: result.data.message || result.data.error,
      sceneExport: result.data.sceneExport || null,
      bindings: Array.isArray(result.data.bindings) ? result.data.bindings : [],
    });
    console.log(
      `Ack ${command.requestId}: ${conflict ? "Conflict" : applied ? "Applied" : "Failed"} (HTTP ${result.status})`,
    );
    return;
  }

  if (command.type === "undo_last_apply") {
    const result = await unity(config, "/scene/undo", {
      method: "POST",
      body: { requestId: command.requestId },
    });
    await ack(config, {
      requestId: command.requestId,
      ok: result.ok && result.data.status === "applied",
      conflict: result.status === 409,
      unityRevision: result.data.unityRevision,
      error: result.data.message || result.data.error,
    });
    return;
  }

  if (command.type === "save_scene") {
    const result = await unity(config, "/scene/save", {
      method: "POST",
      body: { requestId: command.requestId, scenePath: command.scenePath },
    });
    await ack(config, {
      requestId: command.requestId,
      ok: result.ok && result.data.status === "applied",
      conflict: result.status === 409,
      unityRevision: result.data.unityRevision,
      error: result.data.message || result.data.error,
    });
    return;
  }

  await ack(config, {
    requestId: command.requestId,
    ok: false,
    error: `Unsupported command type: ${command.type}`,
  });
}

async function loop() {
  acquireSingleInstance();
  const config = readConfig();
  if (!config?.connectorToken) {
    throw new Error("No connector config. Run: npm run pair -w connector -- <CODE>");
  }
  if (!config.bridgeToken) {
    throw new Error("Missing bridgeToken. Re-pair the connector so the Editor bridge can authenticate.");
  }

  const projectRoot = resolveUnityProjectRoot(ROOT);
  console.log(`Connector → API ${config.apiBaseUrl}; Unity ${config.unityBridgeUrl}; project ${projectRoot}`);
  let lastImportedRevision = null;
  let lastImportedSchema = 0;
  let lastImportedFingerprint = null;
  let lastScenesReportAt = 0;
  /** Avoid re-exporting every poll for the same force request id. */
  let lastHandledForceRequestId = null;
  /** Avoid infinite schema_upgrade polls when Unity still serves an older schema. */
  let schemaUpgradeExhausted = false;
  let lastHeadsetProbeAt = 0;

  async function importActiveSceneExport(reason = "revision_change", forceExportRequestId = null) {
    const qs = forceExportRequestId
      ? `?forceExportRequestId=${encodeURIComponent(forceExportRequestId)}`
      : "";
    const exported = await unity(config, `/scene/export${qs}`);
    if (!exported.ok) {
      if (exported.status === 401) {
        console.error("Unity export unauthorized — re-pair to refresh bridge token.");
      }
      return false;
    }
    const snapshot = {
      ...exported.data,
      forceExportRequestId: forceExportRequestId || exported.data.forceExportRequestId || null,
    };
    const importedResult = await api(config, "/api/connector/import-scene", {
      method: "POST",
      body: {
        snapshot,
        forceExportRequestId: forceExportRequestId || null,
      },
    });
    lastImportedRevision = exported.data.unityRevision ?? lastImportedRevision;
    lastImportedSchema = Number(exported.data.exportSchemaVersion) || 0;
    lastImportedFingerprint = exported.data.contentFingerprint || null;
    console.log(
      `Imported scene ${exported.data.sceneName || exported.data.scenePath} rev ${exported.data.unityRevision}` +
        ` schema ${lastImportedSchema}` +
        ` (${reason})` +
        (forceExportRequestId ? ` forceReq ${forceExportRequestId.slice(0, 8)}…` : "") +
        (importedResult.forceSatisfied ? " forceOK" : "") +
        (importedResult.draft ? ` (draft ${importedResult.draft.id})` : ""),
    );
    return true;
  }

  for (;;) {
    let unityReachable = false;
    let unityRevision = 0;
    let scenePath = "";
    let forceSceneExport = false;
    let forceExportRequestId = null;
    let xrRuntime = { loaderActive: false, displayRunning: false, hmdPresent: false, loaderName: null, runtimeName: null, deviceName: null };

    try {
      const health = await unity(config, "/health", { timeoutMs: UNITY_HEALTH_TIMEOUT_MS });
      if (isUnityHealthReachable(health)) {
        unityReachable = true;
        unityRevision = health.data.unityRevision || 0;
        scenePath = health.data.scenePath || "";
        if (health.data.xr && typeof health.data.xr === "object") {
          xrRuntime = { ...xrRuntime, ...health.data.xr, observedAt: new Date().toISOString() };
        }

        // Refresh Studio's scene picker list periodically while the bridge is up.
        if (Date.now() - lastScenesReportAt > 8000) {
          const listed = await unity(config, "/scenes", { method: "GET" });
          if (listed.ok && Array.isArray(listed.data?.scenes)) {
            await api(config, "/api/connector/report-scenes", {
              method: "POST",
              body: {
                scenes: listed.data.scenes,
                activeScenePath: listed.data.activeScenePath || scenePath || null,
                activeSceneName: listed.data.activeSceneName || null,
              },
            });
            lastScenesReportAt = Date.now();
          }
        }
      }
    } catch {
      unityReachable = false;
    }

    if (Date.now() - lastHeadsetProbeAt >= HEADSET_POLL_MS) {
      try {
        const adb = await probeHeadsets({ config, projectRoot });
        await api(config, "/api/connector/report-headset", {
          method: "POST",
          body: { adb, openxr: xrRuntime, unityConnected: unityReachable },
        });
        lastHeadsetProbeAt = Date.now();
      } catch (headsetError) {
        console.log("Headset probe/report: " + (headsetError.message || headsetError));
        lastHeadsetProbeAt = Date.now();
      }
    }

    try {
      const qs = new URLSearchParams({
        unityReachable: unityReachable ? "1" : "0",
        unityRevision: String(unityRevision),
      });
      if (scenePath) qs.set("scenePath", scenePath);
      const poll = await api(config, `/api/connector/poll?${qs}`);
      forceSceneExport = Boolean(poll.forceSceneExport);
      forceExportRequestId = poll.forceExportRequestId || null;

      if (unityReachable) {
        if (forceSceneExport) schemaUpgradeExhausted = false;
        if (lastImportedRevision != null && lastImportedRevision !== unityRevision) {
          schemaUpgradeExhausted = false;
        }
        const schemaStale =
          lastImportedSchema > 0 && lastImportedSchema < 3 && !schemaUpgradeExhausted;
        const forceAlreadyHandled =
          forceSceneExport &&
          forceExportRequestId &&
          forceExportRequestId === lastHandledForceRequestId;
        // Force export is idempotent per requestId: import once with that id; do not re-export every poll.
        const needExport =
          (!forceAlreadyHandled && forceSceneExport) ||
          lastImportedRevision !== unityRevision ||
          lastImportedRevision == null ||
          schemaStale;
        if (needExport) {
          const reason = forceSceneExport && !forceAlreadyHandled
            ? poll.forceSceneExportReason || "force"
            : lastImportedRevision !== unityRevision || lastImportedRevision == null
              ? "revision_change"
              : "schema_upgrade";
          const ok = await importActiveSceneExport(
            reason,
            forceSceneExport && !forceAlreadyHandled ? forceExportRequestId : null,
          );
          if (ok && reason === "schema_upgrade" && lastImportedSchema < 3) {
            // Unity has not upgraded yet — do not hammer /scene/export every poll.
            schemaUpgradeExhausted = true;
          }
          if (ok && lastImportedSchema >= 3) {
            schemaUpgradeExhausted = false;
          }
          if (ok && forceSceneExport && forceExportRequestId && !forceAlreadyHandled) {
            lastHandledForceRequestId = forceExportRequestId;
            try {
              await api(config, "/api/connector/ack-force-scene-export", {
                method: "POST",
                body: { forceExportRequestId },
              });
            } catch {
              /* import-scene clears pending when request id matches */
            }
          }
        }
      }

      if (poll.command && unityReachable) {
        await handleCommand(config, poll.command);
      } else if (poll.command && !unityReachable) {
        console.log(`Command ${poll.command.requestId} waiting — Unity bridge offline`);
      }

      const assetPoll = await api(config, "/api/connector/poll-assets");
      if (assetPoll.command && unityReachable) {
        await handleCommand(config, assetPoll.command);
      } else if (assetPoll.command && !unityReachable) {
        console.log(`Asset job ${assetPoll.command.requestId} waiting — Unity bridge offline`);
      }

      const weaponPoll = await api(config, "/api/connector/poll-weapons");
      if (weaponPoll.command && unityReachable) {
        await handleCommand(config, weaponPoll.command);
      } else if (weaponPoll.command && !unityReachable) {
        console.log(`Weapon sync ${weaponPoll.command.requestId} waiting — Unity bridge offline`);
      }

      const characterPoll = await api(config, "/api/connector/poll-characters");
      if (characterPoll.command && unityReachable) {
        await handleCommand(config, characterPoll.command);
      } else if (characterPoll.command && !unityReachable) {
        console.log(`Character sync ${characterPoll.command.requestId} waiting — Unity bridge offline`);
      }

      const soundPoll = await api(config, "/api/connector/poll-sound");
      if (soundPoll.command && unityReachable) {
        await handleCommand(config, soundPoll.command);
      } else if (soundPoll.command && !unityReachable) {
        console.log(`Sound sync ${soundPoll.command.requestId} waiting — Unity bridge offline`);
      }

      // W06: pull pending analytics capture from Editor bridge when present.
      if (unityReachable) {
        try {
          const pending = await unity(config, "/analytics/pending-capture", { method: "GET" });
          if (pending.ok && pending.data?.capture && Array.isArray(pending.data.capture.events)) {
            const up = await api(config, "/api/connector/analytics/upload", {
              method: "POST",
              body: pending.data.capture,
            });
            console.log(
              `Analytics upload: imported=${up.imported ?? "?"} duplicates=${up.duplicates ?? "?"}`,
            );
            await unity(config, "/analytics/ack-capture", {
              method: "POST",
              body: { captureId: pending.data.captureId || null },
            });
          }
        } catch (analyticsErr) {
          // Bridge may not expose analytics yet — non-fatal.
          const msg = String(analyticsErr.message || analyticsErr);
          if (!/404|ECONNREFUSED|fetch failed/i.test(msg)) {
            console.log(`Analytics poll: ${msg}`);
          }
        }
      }
    } catch (err) {
      console.error(`Poll error: ${err.message}`);
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain || process.env.HERTZ_CONNECTOR_FORCE_START === "1") {
  loop().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
