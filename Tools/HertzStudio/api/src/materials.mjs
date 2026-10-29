/**
 * W08 Materials & Lighting — Unity-authoritative inspect/apply.
 * Browser never asserts Terrain / scene revision / shared dependency version.
 */
import { randomUUID } from "node:crypto";
import { loadStore, saveStore } from "./store.mjs";
import { assertStudioTargetScene, scenePathsEqual } from "./sceneIdentity.mjs";
import { postUnityBridge } from "./unityBridgeClient.mjs";
import { getAsset } from "./assets/catalog.mjs";

function ensure(store) {
  if (!store.materials) {
    store.materials = { assignments: {}, undo: [], lights: {}, hdri: null, jobs: [] };
  }
  if (!store.materials.assignments) store.materials.assignments = {};
  if (!Array.isArray(store.materials.undo)) store.materials.undo = [];
  if (!Array.isArray(store.materials.jobs)) store.materials.jobs = [];
  return store;
}

export function listMaterialAssignments({ scenePath } = {}) {
  const store = ensure(loadStore());
  let list = Object.values(store.materials.assignments);
  if (scenePath) {
    list = list.filter((a) => scenePathsEqual(a.scenePath, scenePath));
  }
  return {
    assignments: list,
    hdri: store.materials.hdri,
    lights: store.materials.lights || {},
    note: "Browser preview differs from Unity/URP. Quest-friendly defaults: no expensive realtime GI. Terrain/revision facts come from Unity.",
  };
}

/**
 * Inspect a target in Unity. Returns authoritative Terrain status, slots, shared deps, revision.
 */
export async function listMaterialTargets(body = {}) {
  const scenePath = assertStudioTargetScene(body.scenePath);
  const bridge = await postUnityBridge(
    "/materials/targets",
    { scenePath, sceneGuid: body.sceneGuid || null },
    { timeoutMs: 15000 },
  );
  if (!bridge.ok) {
    const err = new Error(bridge.error || "Unity material target discovery failed.");
    err.code = bridge.status === 0 ? "unity_offline" : bridge.data?.code || "unity_targets_failed";
    throw err;
  }
  return {
    scenePath,
    sceneGuid: body.sceneGuid || null,
    unityRevision: bridge.data?.unityRevision,
    targets: Array.isArray(bridge.data?.targets) ? bridge.data.targets : [],
    source: "unity_bridge",
  };
}
export async function inspectMaterialTarget(body = {}) {
  const scenePath = assertStudioTargetScene(body.scenePath);
  const targetObjectId = String(body.targetObjectId || "").trim();
  if (!targetObjectId) {
    const err = new Error("targetObjectId required.");
    err.code = "invalid_request";
    throw err;
  }
  const bridge = await postUnityBridge(
    "/materials/inspect",
    {
      scenePath,
      sceneGuid: body.sceneGuid || null,
      targetObjectId,
      materialSlot: Number.isFinite(body.materialSlot) ? Number(body.materialSlot) : 0,
    },
    { timeoutMs: 15000 },
  );
  if (!bridge.ok) {
    const err = new Error(bridge.error || "Unity material inspect failed.");
    err.code = bridge.status === 0 ? "unity_offline" : "unity_inspect_failed";
    err.bridge = bridge;
    throw err;
  }
  const data = bridge.data || {};
  return {
    scenePath,
    unityRevision: data.unityRevision,
    targetObjectId: data.targetObjectId || targetObjectId,
    isActualTerrain: data.isActualTerrain === true,
    rendererPresent: data.rendererPresent === true,
    materialSlotCount: Number(data.materialSlotCount) || 0,
    materialSlot: Number(data.materialSlot) || 0,
    sharedMaterial: data.sharedMaterial === true,
    dependencyVersion: data.dependencyVersion || null,
    dependencyUsers: Array.isArray(data.dependencyUsers) ? data.dependencyUsers : [],
    currentMaterialPath: data.currentMaterialPath || null,
    currentMaterialGuid: data.currentMaterialGuid || null,
    source: "unity_bridge",
  };
}

/**
 * Apply surface via Unity. Ignores client isActualTerrain / sceneRevision as authority.
 */
export async function applySurfaceAssignment(body = {}) {
  const scenePath = assertStudioTargetScene(body.scenePath);
  const targetObjectId = String(body.targetObjectId || "").trim();
  if (!targetObjectId) {
    const err = new Error("targetObjectId required.");
    err.code = "invalid_request";
    throw err;
  }

  // Client may request terrain_layer, but Unity decides if target is Terrain.
  const requestedKind = body.targetKind || "renderer_slot";
  if (body.isActualTerrain === true && requestedKind !== "terrain_layer") {
    // Ignore browser Terrain assertions for non-terrain requests.
  }

  const assetId = body.assetId || null;
  let unityTexturePath = body.unityTexturePath || null;
  let unityMaterialPath = body.unityMaterialPath || null;
  if (assetId) {
    const asset = getAsset(assetId);
    if (!asset) {
      const err = new Error("Asset Library id not found.");
      err.code = "unknown_asset";
      throw err;
    }
    if (asset.state !== "unity_imported" && asset.unity?.readiness !== "ready") {
      const err = new Error("Asset must be unity_imported before material apply.");
      err.code = "not_unity_imported";
      throw err;
    }
    unityTexturePath = asset.unity?.assetPath || asset.unity?.prefabPath || unityTexturePath;
    unityMaterialPath = asset.unity?.materialPath || unityMaterialPath;
  }

  const expectedUnityRevision =
    body.expectedUnityRevision != null ? Number(body.expectedUnityRevision) : null;
  if (expectedUnityRevision == null || !Number.isFinite(expectedUnityRevision)) {
    const err = new Error("expectedUnityRevision from Unity scene inventory is required.");
    err.code = "revision_required";
    throw err;
  }

  const bridgeBody = {
    scenePath,
    sceneGuid: body.sceneGuid || null,
    targetObjectId,
    targetKind: requestedKind,
    materialSlot: Number.isFinite(body.materialSlot) ? Number(body.materialSlot) : 0,
    assetId,
    unityTexturePath,
    unityMaterialPath,
    expectedUnityRevision,
    tilingX: Number(body.tilingX) || 1,
    tilingY: Number(body.tilingY) || 1,
    offsetX: Number(body.offsetX) || 0,
    offsetY: Number(body.offsetY) || 0,
    normalStrength: Number.isFinite(body.normalStrength) ? Number(body.normalStrength) : 1,
    tint: body.tint || "#ffffff",
    metallic: Number.isFinite(body.metallic) ? Number(body.metallic) : 0,
    smoothness: Number.isFinite(body.smoothness) ? Number(body.smoothness) : 0.5,
    duplicateShared: body.sharedMaterial !== true,
    confirmSharedEdit: body.confirmSharedEdit === true,
    expectedDependencyVersion: body.expectedDependencyVersion || null,
    providerId: body.providerId || null,
    saveScene: body.saveScene !== false,
  };

  const bridge = await postUnityBridge("/materials/apply", bridgeBody, { timeoutMs: 30000 });
  if (!bridge.ok) {
    const code = bridge.data?.code || (bridge.status === 409 ? "stale_revision" : "unity_apply_failed");
    const err = new Error(bridge.error || bridge.data?.message || "Unity material apply failed.");
    err.code = code;
    err.bridge = bridge;
    throw err;
  }
  const data = bridge.data || {};
  if (data.isActualTerrain !== true && requestedKind === "terrain_layer") {
    const err = new Error("Unity reports target is not a Terrain; terrain_layer apply refused.");
    err.code = "not_terrain";
    throw err;
  }

  const store = ensure(loadStore());
  const id = body.id || randomUUID();
  const prior = store.materials.assignments[id] || null;
  if (prior || data.operationId) {
    store.materials.undo.push({
      type: "surface",
      operationId: data.operationId || null,
      before: prior || { id, operationId: data.operationId, scenePath, unityRevision: data.unityRevision },
      at: new Date().toISOString(),
    });
    store.materials.undo = store.materials.undo.slice(-50);
  }
  const assignment = {
    id,
    scenePath,
    sceneRevision: data.unityRevision,
    unityRevision: data.unityRevision,
    operationId: data.operationId || null,
    targetKind: data.appliedKind || requestedKind,
    targetObjectId: data.targetObjectId || targetObjectId,
    materialSlot: data.materialSlot ?? bridgeBody.materialSlot,
    assetId,
    providerId: body.providerId || null,
    materialGuid: data.materialGuid || null,
    materialPath: data.materialPath || null,
    terrainLayerPath: data.terrainLayerPath || null,
    tiling: { x: bridgeBody.tilingX, y: bridgeBody.tilingY },
    offset: { x: bridgeBody.offsetX, y: bridgeBody.offsetY },
    normalStrength: bridgeBody.normalStrength,
    tint: bridgeBody.tint,
    metallic: bridgeBody.metallic,
    smoothness: bridgeBody.smoothness,
    duplicateShared: bridgeBody.duplicateShared,
    appliedValues: data.appliedValues || null,
    source: "unity_bridge",
    updatedAt: new Date().toISOString(),
  };
  store.materials.assignments[id] = assignment;
  saveStore(store);
  return assignment;
}

export async function undoLastSurface(body = {}) {
  const store = ensure(loadStore());
  const operationId = body.operationId || null;
  const entry = operationId
    ? store.materials.undo.find((u) => u.before?.operationId === operationId || u.operationId === operationId)
    : store.materials.undo[store.materials.undo.length - 1];

  const scenePath = body.scenePath || entry?.before?.scenePath || null;
  const expectedUnityRevision =
    body.expectedUnityRevision != null
      ? Number(body.expectedUnityRevision)
      : entry?.before?.unityRevision != null
        ? Number(entry.before.unityRevision)
        : null;
  const opId = operationId || entry?.before?.operationId || entry?.operationId;
  if (!opId) {
    const err = new Error("operationId required for operation-scoped material undo.");
    err.code = "operation_id_required";
    throw err;
  }
  if (expectedUnityRevision == null || !Number.isFinite(expectedUnityRevision)) {
    const err = new Error("expectedUnityRevision required for undo.");
    err.code = "revision_required";
    throw err;
  }

  const bridge = await postUnityBridge(
    "/materials/undo",
    {
      scenePath,
      sceneGuid: body.sceneGuid || null,
      operationId: opId,
      expectedUnityRevision,
    },
    { timeoutMs: 15000 },
  );
  if (!bridge.ok) {
    const err = new Error(bridge.error || "Unity operation-scoped undo failed; Studio assignment left unchanged.");
    err.code = bridge.data?.code || "unity_undo_failed";
    throw err;
  }

  if (entry?.before?.id && store.materials.assignments[entry.before.id]) {
    const idx = store.materials.undo.indexOf(entry);
    if (idx >= 0) store.materials.undo.splice(idx, 1);
    store.materials.assignments[entry.before.id] = {
      ...entry.before,
      unityRevision: bridge.data?.unityRevision ?? entry.before.unityRevision,
      undone: true,
      updatedAt: new Date().toISOString(),
    };
    saveStore(store);
    return store.materials.assignments[entry.before.id];
  }

  return { source: "unity_bridge", operationId: opId, ...(bridge.data || {}) };
}

export async function setHdriEnvironment(body = {}) {
  const scenePath = assertStudioTargetScene(body.scenePath);
  const expectedUnityRevision =
    body.expectedUnityRevision != null ? Number(body.expectedUnityRevision) : null;
  if (expectedUnityRevision == null || !Number.isFinite(expectedUnityRevision)) {
    const err = new Error("expectedUnityRevision required for HDRI apply.");
    err.code = "revision_required";
    throw err;
  }
  let unityHdriPath = body.unityHdriPath || null;
  if (body.assetId) {
    const asset = getAsset(body.assetId);
    if (!asset) {
      const err = new Error("HDRI asset not found.");
      err.code = "unknown_asset";
      throw err;
    }
    if (asset.state !== "unity_imported" && asset.unity?.readiness !== "ready") {
      const err = new Error("HDRI asset must be unity_imported.");
      err.code = "not_unity_imported";
      throw err;
    }
    unityHdriPath = asset.unity?.assetPath || unityHdriPath;
  }
  const bridge = await postUnityBridge(
    "/materials/hdri",
    {
      scenePath,
      sceneGuid: body.sceneGuid || null,
      expectedUnityRevision,
      unityHdriPath,
      assetId: body.assetId || null,
      providerId: body.providerId || null,
      intensity: Number.isFinite(body.intensity) ? Number(body.intensity) : 1,
      rotation: Number.isFinite(body.rotation) ? Number(body.rotation) : 0,
      enableRealtimeGi: body.enableRealtimeGi === true,
      saveScene: body.saveScene !== false,
    },
    { timeoutMs: 30000 },
  );
  if (!bridge.ok) {
    const err = new Error(bridge.error || "Unity HDRI apply failed.");
    err.code = bridge.data?.code || "unity_hdri_failed";
    throw err;
  }
  const store = ensure(loadStore());
  const prior = store.materials.hdri;
  if (prior) {
    store.materials.undo.push({ type: "hdri", before: prior, at: new Date().toISOString() });
  }
  store.materials.hdri = {
    assetId: body.assetId || null,
    providerId: body.providerId || null,
    unityHdriPath: bridge.data?.unityHdriPath || unityHdriPath,
    intensity: Number.isFinite(body.intensity) ? Number(body.intensity) : 1,
    rotation: Number.isFinite(body.rotation) ? Number(body.rotation) : 0,
    unityRevision: bridge.data?.unityRevision,
    scenePath,
    realtimeGiEnabled: bridge.data?.realtimeGiEnabled === true,
    updatedAt: new Date().toISOString(),
    previewNote: "Browser skybox preview is approximate; Unity URP environment is authoritative.",
    source: "unity_bridge",
  };
  saveStore(store);
  return store.materials.hdri;
}
