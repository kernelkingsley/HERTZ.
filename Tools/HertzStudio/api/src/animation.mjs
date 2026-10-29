/**
 * W09 Animation — Unity-authoritative Humanoid/clip validation.
 * Never trusts posted humanoidValid / clipNames / affectsTrackedXr.
 */
import { randomUUID } from "node:crypto";
import { loadStore, saveStore } from "./store.mjs";
import { getAsset, enqueueUnityImport } from "./assets/catalog.mjs";
import { postUnityBridge } from "./unityBridgeClient.mjs";
import { getCharacterModel, getEnemyProfile } from "./characters.mjs";

const SLOTS = ["idle", "locomotion", "attack", "shoot", "wait", "rush", "patrol"];

function ensure(store) {
  if (!store.animation) store.animation = { assignments: {}, imports: [] };
  if (!store.animation.assignments) store.animation.assignments = {};
  if (!Array.isArray(store.animation.imports)) store.animation.imports = [];
  return store;
}

export function listAnimationSlots() {
  return {
    slots: SLOTS,
    workflow:
      "Open Mixamo in a browser (Adobe ID). Download FBX, then upload the file into Studio. Studio does not automate Adobe login or Mixamo rigging. Humanoid/clip facts come from Unity after import. Project placeholder clips under Assets/HertzStudio/Characters/TestAssets can be assigned to Generic/Legacy characters immediately.",
    openMixamoUrl: "https://www.mixamo.com/",
  };
}

/** Built-in Studio test clips that live in the Unity project (not Asset Library uploads). */
export function listStudioAnimationClips() {
  return {
    clips: [
      {
        id: "studio-clip:PLACEHOLDER_Idle",
        displayName: "PLACEHOLDER_Idle",
        unityPath: "Assets/HertzStudio/Characters/TestAssets/PLACEHOLDER_Idle.anim",
        clipName: "PLACEHOLDER_Idle",
        humanoidValid: false,
        source: "project_test_assets",
      },
      {
        id: "studio-clip:PLACEHOLDER_Attack",
        displayName: "PLACEHOLDER_Attack",
        unityPath: "Assets/HertzStudio/Characters/TestAssets/PLACEHOLDER_Attack.anim",
        clipName: "PLACEHOLDER_Attack",
        humanoidValid: false,
        source: "project_test_assets",
      },
      {
        id: "studio-clip:PLACEHOLDER_Locomotion",
        displayName: "PLACEHOLDER_Locomotion",
        unityPath: "Assets/HertzStudio/Characters/TestAssets/PLACEHOLDER_Locomotion.anim",
        clipName: "PLACEHOLDER_Locomotion",
        humanoidValid: false,
        source: "project_test_assets",
      },
    ],
  };
}

/**
 * Record that an Asset Library FBX/pack was ingested — does not invent Unity validation.
 * Prefer POST /api/assets upload; this binds catalog asset → animation import job.
 */
export function recordMixamoImportMeta(body = {}) {
  if (body.humanoidValid != null || body.clipNames != null || body.rootMotionAvailable != null) {
    // Accept the call but strip untrusted fields — Unity must report these.
  }
  const store = ensure(loadStore());
  const assetId = body.assetId || null;
  if (!assetId) {
    const err = new Error("assetId of an uploaded FBX/pack in Asset Library is required.");
    err.code = "invalid_request";
    throw err;
  }
  const asset = getAsset(assetId);
  if (!asset) {
    const err = new Error("Asset not found in library.");
    err.code = "unknown_asset";
    throw err;
  }
  const record = {
    id: randomUUID(),
    filename: asset.originalName || asset.displayName || body.filename || null,
    contentHash: asset.contentHash || body.contentHash || null,
    assetId,
    status: asset.state === "unity_imported" || asset.unity?.readiness === "ready" ? "awaiting_unity_probe" : "queued_or_uploaded",
    humanoidValid: null,
    clipNames: null,
    rootMotionAvailable: null,
    unityGuid: asset.unity?.guid || null,
    unityPath: asset.unity?.assetPath || null,
    createdAt: new Date().toISOString(),
    note: "Unity ModelImporter/Avatar/clips are authoritative after import. Posted humanoidValid/clipNames are ignored.",
  };
  if (asset.state !== "unity_imported" && asset.unity?.readiness !== "ready") {
    const requestId = `anim-import-${assetId}-${asset.contentHash || randomUUID().slice(0, 8)}`;
    const queued = enqueueUnityImport(assetId, requestId);
    record.unityImportJobId = queued.job?.id || null;
    record.queueError = queued.error || null;
    if (!queued.error) record.status = "queued_unity";
  }
  store.animation.imports.unshift(record);
  store.animation.imports = store.animation.imports.slice(0, 200);
  saveStore(store);
  return record;
}

/** Probe Unity for clips + Humanoid validity on an imported asset. */
export async function probeAnimationAsset(body = {}) {
  const assetId = body.assetId;
  const studioClip = listStudioAnimationClips().clips.find((entry) => entry.id === assetId) || null;
  const asset = !studioClip && assetId ? getAsset(assetId) : null;
  if (!studioClip && !asset) {
    const err = new Error("Asset not found.");
    err.code = "unknown_asset";
    throw err;
  }
  const unityPath = studioClip?.unityPath || asset?.unity?.assetPath || body.unityPath;
  const profile = body.enemyProfileId ? getEnemyProfile(body.enemyProfileId) : null;
  const model = getCharacterModel(profile?.modelId || body.characterId || "");
  const modelAsset = model?.modelAssetId ? getAsset(model.modelAssetId) : null;
  const characterModelUnityPath = modelAsset?.unity?.prefabPath || modelAsset?.unity?.assetPath || body.characterModelUnityPath || null;
  if (!unityPath) {
    const err = new Error("Asset has no Unity path yet — wait for unity_imported.");
    err.code = "not_unity_imported";
    throw err;
  }
  const bridge = await postUnityBridge(
    "/animation/probe",
    { assetId, unityPath, characterModelUnityPath },
    { timeoutMs: 20000 },
  );
  if (!bridge.ok) {
    const err = new Error(bridge.error || "Unity animation probe failed.");
    err.code = bridge.status === 0 ? "unity_offline" : "unity_probe_failed";
    throw err;
  }
  const data = bridge.data || {};
  return {
    assetId,
    unityPath,
    humanoidValid: data.humanoidValid === true,
    rigType: data.rigType || null,
    clipNames: Array.isArray(data.clipNames) ? data.clipNames : [],
    clips: Array.isArray(data.clips) ? data.clips : [],
    rootMotionAvailable: data.rootMotionAvailable === true,
    trackedXrProtected: data.trackedXrProtected === true,
    source: "unity_bridge",
  };
}

export async function assignAnimationSlot(body = {}) {
  const store = ensure(loadStore());
  const slot = String(body.slot || "");
  if (!SLOTS.includes(slot)) {
    const err = new Error(`Unknown animation slot '${slot}'.`);
    err.code = "invalid_slot";
    throw err;
  }
  const characterId = body.characterId || body.enemyProfileId || null;
  if (!characterId) {
    const err = new Error("characterId or enemyProfileId required.");
    err.code = "invalid_request";
    throw err;
  }

  const profile = body.enemyProfileId ? getEnemyProfile(body.enemyProfileId) : null;
  const model = getCharacterModel(profile?.modelId || body.characterId || characterId);
  if (!model) {
    const err = new Error("Choose a saved character model or enemy profile before assigning animation.");
    err.code = "unknown_character";
    throw err;
  }
  const studioClips = listStudioAnimationClips().clips;
  const studioClip = studioClips.find((entry) => entry.id === body.clipAssetId) || null;
  const clipAsset = body.clipAssetId && !studioClip ? getAsset(body.clipAssetId) : null;
  if (!studioClip && (!clipAsset || (clipAsset.state !== "unity_imported" && clipAsset.unity?.readiness !== "ready"))) {
    const err = new Error("Choose a Unity-imported animation asset or a Studio placeholder clip.");
    err.code = "not_unity_imported";
    throw err;
  }
  const modelAsset = model.modelAssetId ? getAsset(model.modelAssetId) : null;
  const clipUnityPath =
    studioClip?.unityPath ||
    clipAsset?.unity?.assetPath ||
    clipAsset?.unity?.prefabPath ||
    (typeof body.clipUnityPath === "string" && body.clipUnityPath.startsWith("Assets/") ? body.clipUnityPath : null);
  // Model prefab is optional for Generic slot binding; definition asset is required.
  const modelUnityPath =
    modelAsset?.unity?.prefabPath ||
    modelAsset?.unity?.assetPath ||
    "Assets/HertzStudio/Weapons/TestAssets/PLACEHOLDER_Pistol_Left.prefab";
  const definitionUnityPath = model.unitySync?.assetPath || null;
  const profileUnityPath = profile?.unitySync?.assetPath || null;
  if (!clipUnityPath || !definitionUnityPath || (profile && !profileUnityPath)) {
    const err = new Error("Sync the character/profile into Unity and choose a clip before assigning a slot.");
    err.code = "unity_mapping_required";
    throw err;
  }
  const key = `${characterId}:${slot}`;
  const prior = store.animation.assignments[key] || null;

  // Unity validates — never trust client humanoidValid / affectsTrackedXr.
  const bridge = await postUnityBridge(
    "/animation/assign",
    {
      characterId,
      scenePath: body.scenePath || null,
      sceneGuid: body.sceneGuid || null,
      expectedUnityRevision: body.expectedUnityRevision,
      enemyProfileId: body.enemyProfileId || null,
      slot,
      clipAssetId: body.clipAssetId || null,
      clipUnityPath,
      clipGuid: body.clipGuid || null,
      clipName: body.clipName || null,
      modelUnityPath,
      definitionUnityPath,
      profileUnityPath,
      loop: body.loop !== false,
      speed: Number.isFinite(body.speed) ? Number(body.speed) : 1,
      transitionSeconds: Number.isFinite(body.transitionSeconds)
        ? Number(body.transitionSeconds)
        : Number.isFinite(body.transitionDuration)
          ? Number(body.transitionDuration)
          : 0.15,
      rootMotionPolicy: body.rootMotionPolicy === "apply" ? "apply" : "ignore",
      visiblePlayerBodyOnly: body.visiblePlayerBodyOnly !== false,
    },
    { timeoutMs: 25000 },
  );

  if (!bridge.ok) {
    const code = bridge.data?.code || "unity_assign_failed";
    // Preserve prior assignment on validation failure.
    const err = new Error(bridge.error || bridge.data?.message || "Animation assign refused by Unity.");
    err.code = code;
    err.priorPreserved = Boolean(prior);
    err.prior = prior;
    throw err;
  }
  const data = bridge.data || {};
  if (data.affectsTrackedXr === true) {
    const err = new Error("Unity reports assignment would affect tracked XR transforms.");
    err.code = "xr_protected";
    err.priorPreserved = Boolean(prior);
    err.prior = prior;
    throw err;
  }
  // Unity is authoritative: refuse only when it reports incompatible (Humanoid clip on non-Humanoid model).
  // Generic/Legacy clips may assign with humanoidValid:false.
  if (data.compatible === false) {
    const err = new Error("Unity reports the animation is incompatible with the selected character. Prior assignment retained.");
    err.code = "rig_mismatch";
    err.priorPreserved = Boolean(prior);
    err.prior = prior;
    throw err;
  }

  const assignment = {
    id: key,
    characterId,
    scenePath: body.scenePath || null,
    sceneGuid: body.sceneGuid || null,
    unityRevision: data.unityRevision ?? body.expectedUnityRevision,
    slot,
    clipAssetId: body.clipAssetId || null,
    clipName: data.clipName || body.clipName || null,
    clipGuid: data.clipGuid || null,
    clipUnityPath: data.clipUnityPath || null,
    controllerPath: data.controllerPath || null,
    loop: body.loop !== false,
    speed: Number.isFinite(body.speed) ? Number(body.speed) : 1,
    transitionSeconds: Number.isFinite(body.transitionSeconds) ? Number(body.transitionSeconds) : 0.15,
    rootMotionPolicy: body.rootMotionPolicy === "apply" ? "apply" : "ignore",
    humanoidValid: data.humanoidValid === true,
    compatible: data.compatible !== false,
    source: "unity_bridge",
    updatedAt: new Date().toISOString(),
  };
  store.animation.assignments[key] = assignment;
  saveStore(store);
  return { assignment, replaced: Boolean(prior), prior };
}

export function listAnimationAssignments({ characterId } = {}) {
  const store = ensure(loadStore());
  let list = Object.values(store.animation.assignments);
  if (characterId) list = list.filter((a) => a.characterId === characterId);
  return { assignments: list, imports: store.animation.imports.slice(0, 20) };
}
