/**
 * W05 Characters & Enemies — visual models separate from enemy behavior profiles.
 * Persists: characterModels, enemyProfiles, characterJobs, characterMappings.
 * Does not invent species; does not auto-place encounters into SampleScene.
 */
import { createHash, randomUUID } from "node:crypto";
import { loadStore, saveStore } from "./store.mjs";
import { getAsset, listAssets } from "./assets/catalog.mjs";
import { STATE_LABELS } from "./assets/types.mjs";
import { isUuid } from "./draft-commands.mjs";

const MODEL_KINDS = new Set(["player_character", "enemy_visual"]);
const BEHAVIOR_MODES = new Set(["idle", "patrol", "hold_position", "rush"]);
export const ANIMATION_SLOTS = Object.freeze(["idle", "attack", "locomotion"]);
const SYNC_STATES = new Set([
  "disconnected",
  "queued",
  "applying",
  "applied",
  "failed",
  "conflict",
  "stale",
]);

export const CHARACTER_MODEL_DIR = "Assets/HertzStudio/Characters/Models";
export const ENEMY_PROFILE_DIR = "Assets/HertzStudio/Characters/Profiles";

const ACTIVE_JOB = new Set(["pending_unity", "applying", "queued"]);

function requireFinite(n, label) {
  const v = Number(n);
  if (!Number.isFinite(v)) {
    const err = new Error(`${label} must be a finite number (got ${JSON.stringify(n)}).`);
    err.code = "invalid_tuning";
    throw err;
  }
  return v;
}

function requireRange(n, min, max, label) {
  const v = requireFinite(n, label);
  if (v < min || v > max) {
    const err = new Error(`${label} must be between ${min} and ${max} (got ${v}).`);
    err.code = "invalid_tuning";
    throw err;
  }
  return v;
}

function normalizeDeployVector(input, fallback, label, { min = -100000, max = 100000 } = {}) {
  const source = input && typeof input === "object" ? input : fallback;
  const out = {};
  for (const axis of ["x", "y", "z"]) {
    const value = Number(source?.[axis] ?? fallback[axis]);
    if (!Number.isFinite(value) || value < min || value > max) {
      const err = new Error(`${label}.${axis} must be finite and between ${min} and ${max}.`);
      err.code = "invalid_transform";
      throw err;
    }
    out[axis] = value;
  }
  return out;
}

function normalizeCharacterDeployTransform({ position, rotation, scale } = {}) {
  return {
    position: normalizeDeployVector(position, { x: 0, y: 0, z: 0 }, "position"),
    rotation: normalizeDeployVector(rotation, { x: 0, y: 0, z: 0 }, "rotation", { min: -36000, max: 36000 }),
    scale: normalizeDeployVector(scale, { x: 1, y: 1, z: 1 }, "scale", { min: 0.01, max: 100 }),
  };
}

export function validateModelAssetId(modelAssetId, { requireReady = false } = {}) {
  if (modelAssetId === null || modelAssetId === undefined || modelAssetId === "") return null;
  if (!isUuid(modelAssetId)) {
    const err = new Error("modelAssetId must be a UUID.");
    err.code = "invalid_model";
    throw err;
  }
  const asset = getAsset(modelAssetId);
  if (!asset) {
    const err = new Error("modelAssetId not found in asset library.");
    err.code = "invalid_model";
    throw err;
  }
  if (asset.assetType !== "model_3d") {
    const err = new Error(`modelAssetId type must be model_3d (got ${asset.assetType}).`);
    err.code = "invalid_model";
    throw err;
  }
  if (asset.state === "unsupported" || asset.unity?.readiness === "unsupported") {
    const err = new Error("modelAssetId is not Unity-importable.");
    err.code = "invalid_model";
    throw err;
  }
  if (requireReady) {
    const ready = asset.state === "unity_imported" || asset.unity?.readiness === "ready";
    if (!ready) {
      const err = new Error("modelAssetId is not imported/ready in Unity yet.");
      err.code = "invalid_model";
      throw err;
    }
  }
  return modelAssetId;
}

/**
 * Animation slots accept library assets typed as animation, or model_3d that
 * Unity imported as RuntimeAnimatorController / AnimationClip containers.
 * Mixamo download/integration remains W09 — assignment of existing imports only.
 */
export function validateAnimationAssetId(animationAssetId, { requireReady = false, slot = "idle" } = {}) {
  if (animationAssetId === null || animationAssetId === undefined || animationAssetId === "") return null;
  if (!isUuid(animationAssetId)) {
    const err = new Error(`${slot} animationAssetId must be a UUID.`);
    err.code = "invalid_animation";
    throw err;
  }
  const asset = getAsset(animationAssetId);
  if (!asset) {
    const err = new Error(`${slot} animation asset not found in library.`);
    err.code = "invalid_animation";
    throw err;
  }
  if (asset.assetType !== "animation" && asset.assetType !== "model_3d") {
    const err = new Error(
      `${slot} must be assetType animation or model_3d (got ${asset.assetType}).`,
    );
    err.code = "invalid_animation";
    throw err;
  }
  if (asset.state === "unsupported" || asset.unity?.readiness === "unsupported") {
    const err = new Error(`${slot} animation is not Unity-importable.`);
    err.code = "invalid_animation";
    throw err;
  }
  if (requireReady) {
    const ready = asset.state === "unity_imported" || asset.unity?.readiness === "ready";
    if (!ready) {
      const err = new Error(`${slot} animation is not imported/ready in Unity yet.`);
      err.code = "invalid_animation";
      throw err;
    }
  }
  return animationAssetId;
}

export function emptyAnimations() {
  return { idle: null, attack: null, locomotion: null };
}

/** Coerce stored/public animation ids without catalog validation (hash-safe). */
export function coerceAnimations(input = {}) {
  const out = emptyAnimations();
  const src = input && typeof input === "object" ? input : {};
  for (const slot of ANIMATION_SLOTS) {
    const raw = src[slot];
    if (raw === null || raw === undefined || raw === "") {
      out[slot] = null;
      continue;
    }
    const id = typeof raw === "object" && raw != null ? raw.assetId || raw.id : raw;
    out[slot] = typeof id === "string" && isUuid(id) ? id : null;
  }
  return out;
}

export function normalizeAnimations(input = {}, { partial = false, existing = {} } = {}) {
  const base = { ...emptyAnimations(), ...coerceAnimations(existing || {}) };
  const src = input && typeof input === "object" ? input : {};
  const out = { ...base };
  for (const slot of ANIMATION_SLOTS) {
    if (partial && !Object.prototype.hasOwnProperty.call(src, slot)) continue;
    if (!Object.prototype.hasOwnProperty.call(src, slot) && !partial) {
      out[slot] = null;
      continue;
    }
    const raw = src[slot];
    if (raw === null || raw === undefined || raw === "") {
      out[slot] = null;
      continue;
    }
    const id = typeof raw === "object" && raw != null ? raw.assetId || raw.id : raw;
    out[slot] = validateAnimationAssetId(id, { slot });
  }
  return out;
}

function animationUnityPaths(animations) {
  const paths = {};
  for (const slot of ANIMATION_SLOTS) {
    const id = animations?.[slot] || null;
    if (!id) {
      paths[slot] = null;
      continue;
    }
    const asset = getAsset(id);
    paths[slot] = {
      assetId: id,
      displayName: asset?.displayName || null,
      assetType: asset?.assetType || null,
      unityPath:
        asset?.unity?.controllerPath ||
        asset?.unity?.clipPath ||
        asset?.unity?.prefabPath ||
        asset?.unity?.importedPath ||
        null,
      readiness: asset?.unity?.readiness || null,
      previewUrl: asset?.preview?.url || (asset?.assetType === "model_3d" ? `/api/assets/${id}/file` : null),
      // Browser GLB preview can play embedded clips; Unity .anim alone is Unity-only.
      browserPreviewable: Boolean(
        asset?.assetType === "model_3d" ||
          (asset?.preview?.url && /\.(glb|gltf)(\?|$)/i.test(String(asset.preview.url))),
      ),
    };
  }
  return paths;
}

/**
 * Soft save-time check only. Does NOT claim browser/Unity preview compatibility.
 * Hard-fail only when Unity metadata explicitly marks incompatibleRig (authoritative prior sync).
 * Filename / GLB bone presence must never invent a pass.
 */
export function validateAnimationRigCompatibility(modelAssetId, animations) {
  const assigned = ANIMATION_SLOTS.some((s) => animations?.[s]);
  if (!assigned) return { ok: true, warnings: [] };
  const warnings = [];
  if (!modelAssetId) {
    warnings.push("Animations assigned without a character mesh — Unity bind may be incomplete.");
    return { ok: true, warnings };
  }
  const mesh = getAsset(modelAssetId);
  if (!mesh) {
    const err = new Error("Character mesh missing for animation rig validation.");
    err.code = "invalid_animation_rig";
    throw err;
  }
  if (mesh.unity?.incompatibleRig === true) {
    const err = new Error("Selected animations are incompatible with this character rig.");
    err.code = "invalid_animation_rig";
    throw err;
  }
  if (mesh.unity?.rigCompatibility?.status === "incompatible") {
    const err = new Error(
      mesh.unity.rigCompatibility.reason || "Selected animations are incompatible with this character rig.",
    );
    err.code = "invalid_animation_rig";
    throw err;
  }
  if (!mesh.unity?.rigCompatibility?.status) {
    warnings.push("Unity rig compatibility not yet validated for this mesh — Studio marks preview as pending.");
  }
  return { ok: true, warnings };
}

/**
 * Browser/Studio compatibility probe. Never fabricates Unity success.
 * Optional live bridge result may be passed in as unityResult.
 */
export function resolveAnimationCompatibilityProbe({
  modelAssetId,
  animationAssetId,
  slot = "idle",
  unityResult = null,
} = {}) {
  const slotKey = ANIMATION_SLOTS.includes(slot) ? slot : "idle";
  if (!modelAssetId || !animationAssetId) {
    return {
      slot: slotKey,
      modelAssetId: modelAssetId || null,
      animationAssetId: animationAssetId || null,
      unityCompatibility: {
        status: "not_applicable",
        source: null,
        reason: "Model and animation asset ids required.",
      },
      message: "Compatibility not applicable.",
    };
  }
  const mesh = getAsset(modelAssetId);
  const anim = getAsset(animationAssetId);
  if (!mesh || !anim) {
    return {
      slot: slotKey,
      modelAssetId,
      animationAssetId,
      unityCompatibility: {
        status: "unavailable",
        source: null,
        reason: "Asset missing from library.",
      },
      message: "Cannot validate — asset missing.",
    };
  }

  const modelPath =
    mesh.unity?.prefabPath || mesh.unity?.assetPath || mesh.unity?.modelPath || null;
  const animPath =
    anim.unity?.clipPath ||
    anim.unity?.controllerPath ||
    anim.unity?.assetPath ||
    anim.unity?.prefabPath ||
    null;

  if (unityResult && (unityResult.source === "unity_bridge" || unityResult.source === "unity_editor")) {
    const ok = unityResult.compatible === true;
    return {
      slot: slotKey,
      modelAssetId,
      animationAssetId,
      modelUnityPath: modelPath,
      animationUnityPath: animPath,
      unityCompatibility: {
        status: ok ? "unity_verified" : "unity_incompatible",
        source: unityResult.source,
        reason: unityResult.reason || (ok ? "Unity validated." : "Unity reported incompatible."),
      },
      message: unityResult.reason || (ok ? "Unity validated." : "Unity reported incompatible."),
    };
  }

  // Persisted authoritative result from a prior Unity sync/validate (never filename inference).
  const stored = anim.unity?.rigCompatibility || mesh.unity?.rigCompatibility;
  if (
    stored &&
    (stored.source === "unity_bridge" || stored.source === "unity_editor" || stored.source === "unity_editor_menu") &&
    stored.modelAssetId === modelAssetId &&
    stored.animationAssetId === animationAssetId
  ) {
    return {
      slot: slotKey,
      modelAssetId,
      animationAssetId,
      modelUnityPath: modelPath,
      animationUnityPath: animPath,
      unityCompatibility: {
        status: stored.status === "compatible" || stored.status === "unity_verified" ? "unity_verified" : "unity_incompatible",
        source: stored.source,
        reason: stored.reason || "Stored Unity validation.",
      },
      message: stored.reason || "Stored Unity validation.",
    };
  }

  return {
    slot: slotKey,
    modelAssetId,
    animationAssetId,
    modelUnityPath: modelPath,
    animationUnityPath: animPath,
    unityCompatibility: {
      status: "pending",
      source: null,
      reason:
        "Awaiting authoritative Unity validation via bridge POST /characters/validate-animation (Assets/ paths only).",
    },
    message: "Rig compatibility pending Unity evidence.",
    bridgeHint: {
      path: "/characters/validate-animation",
      modelUnityPath: modelPath,
      animationUnityPath: animPath,
      slot: slotKey,
      modelAssetId,
      animationAssetId,
    },
  };
}

export function validateBehavior(input = {}, { partial = false, existing = {} } = {}) {
  const src = { ...existing, ...input };
  const need = (key, fallback) => {
    if (partial && input[key] === undefined) return existing[key] ?? fallback;
    return src[key] ?? fallback;
  };
  const modeRaw = need("mode", "hold_position");
  if (!BEHAVIOR_MODES.has(modeRaw)) {
    const err = new Error(`behavior.mode must be one of ${[...BEHAVIOR_MODES].join(",")}.`);
    err.code = "invalid_behavior";
    throw err;
  }
  return {
    moveSpeed: requireRange(need("moveSpeed", 2.5), 0.1, 20, "moveSpeed"),
    detectionRangeMeters: requireRange(need("detectionRangeMeters", 12), 0.5, 200, "detectionRangeMeters"),
    attackRangeMeters: requireRange(need("attackRangeMeters", 8), 0.5, 200, "attackRangeMeters"),
    waitReactionDelaySeconds: requireRange(need("waitReactionDelaySeconds", 0.4), 0, 30, "waitReactionDelaySeconds"),
    shotBurstIntervalSeconds: requireRange(need("shotBurstIntervalSeconds", 0.75), 0.05, 30, "shotBurstIntervalSeconds"),
    approachDistanceMeters: requireRange(need("approachDistanceMeters", 3), 0.25, 100, "approachDistanceMeters"),
    mode: modeRaw,
  };
}

function ensureCharacterStore(store) {
  if (!store.characterModels) store.characterModels = {};
  if (!store.enemyProfiles) store.enemyProfiles = {};
  if (!store.characterJobs) store.characterJobs = [];
  if (!store.characterMappings) store.characterMappings = {};
  return store;
}

function publicUnitySync(sync) {
  const s = sync || {};
  return {
    state: SYNC_STATES.has(s.state) ? s.state : "disconnected",
    assetGuid: s.assetGuid || null,
    assetPath: s.assetPath && String(s.assetPath).startsWith("Assets/") ? s.assetPath : s.assetPath || null,
    lastError: s.lastError || null,
    lastSyncedAt: s.lastSyncedAt || null,
    lastRequestId: s.lastRequestId || null,
    payloadHash: s.payloadHash || null,
    observedPayloadHash: s.observedPayloadHash || s.payloadHash || null,
    observedVersion: s.observedVersion ?? null,
  };
}

function defaultUnitySync(existing) {
  return existing?.unitySync
    ? {
        ...existing.unitySync,
        state:
          existing.unitySync.state === "applied" || existing.unitySync.state === "applying"
            ? "stale"
            : existing.unitySync.state || "disconnected",
      }
    : {
        state: "disconnected",
        assetGuid: null,
        assetPath: null,
        lastError: null,
        lastSyncedAt: null,
        lastRequestId: null,
        payloadHash: null,
        observedVersion: null,
      };
}

export function canonicalCharacterModelPayload(entry) {
  const anim = coerceAnimations(entry.animations || {});
  return JSON.stringify({
    animations: {
      attack: anim.attack || null,
      idle: anim.idle || null,
      locomotion: anim.locomotion || null,
    },
    characterId: String(entry.id),
    displayName: String(entry.displayName || ""),
    enabled: entry.enabled !== false,
    kind: entry.kind === "player_character" ? "player_character" : "enemy_visual",
    modelAssetId: entry.modelAssetId || null,
    replaceTrackedXrRig: false,
    scale: Number(entry.scale),
  });
}

export function characterModelPayloadHash(entry) {
  return createHash("sha256").update(canonicalCharacterModelPayload(entry), "utf8").digest("hex");
}

export function canonicalEnemyProfilePayload(entry) {
  const b = entry.behavior || {};
  const anim = coerceAnimations(entry.animations || {});
  return JSON.stringify({
    animations: {
      attack: anim.attack || null,
      idle: anim.idle || null,
      locomotion: anim.locomotion || null,
    },
    approachDistanceMeters: Number(b.approachDistanceMeters),
    attackRangeMeters: Number(b.attackRangeMeters),
    detectionRangeMeters: Number(b.detectionRangeMeters),
    displayName: String(entry.displayName || ""),
    enabled: entry.enabled !== false,
    mode: String(b.mode || "hold_position"),
    modelId: entry.modelId || null,
    moveSpeed: Number(b.moveSpeed),
    profileId: String(entry.id),
    shotBurstIntervalSeconds: Number(b.shotBurstIntervalSeconds),
    waitReactionDelaySeconds: Number(b.waitReactionDelaySeconds),
  });
}

export function enemyProfilePayloadHash(entry) {
  return createHash("sha256").update(canonicalEnemyProfilePayload(entry), "utf8").digest("hex");
}

export function publicCharacterModel(entry) {
  if (!entry) return null;
  const animations = coerceAnimations(entry.animations || {});
  return {
    id: entry.id,
    displayName: entry.displayName,
    kind: entry.kind,
    enabled: entry.enabled !== false,
    modelAssetId: entry.modelAssetId || null,
    scale: Number(entry.scale) || 1,
    replaceTrackedXrRig: false,
    animations,
    animationBindings: animationUnityPaths(animations),
    animationWarnings: entry.animationWarnings || [],
    note: entry.note || "Imported character models never replace the tracked XR rig or camera.",
    version: Number(entry.version) || 1,
    payloadHash: entry.payloadHash || characterModelPayloadHash(entry),
    unitySync: publicUnitySync(entry.unitySync),
    unityDeploy: entry.unityDeploy || null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

export function publicEnemyProfile(entry) {
  if (!entry) return null;
  const animations = coerceAnimations(entry.animations || {});
  return {
    id: entry.id,
    displayName: entry.displayName,
    enabled: entry.enabled !== false,
    modelId: entry.modelId || null,
    behavior: { ...entry.behavior },
    animations,
    animationBindings: animationUnityPaths(animations),
    animationWarnings: entry.animationWarnings || [],
    version: Number(entry.version) || 1,
    payloadHash: entry.payloadHash || enemyProfilePayloadHash(entry),
    unitySync: publicUnitySync(entry.unitySync),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

export function listCharacters() {
  const store = ensureCharacterStore(loadStore());
  return {
    models: Object.values(store.characterModels)
      .map(publicCharacterModel)
      .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt))),
    profiles: Object.values(store.enemyProfiles)
      .map(publicEnemyProfile)
      .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt))),
    note: "Visual models are separate from enemy behavior profiles. No SampleScene encounter placement.",
  };
}

export function getCharacterModel(id) {
  const store = ensureCharacterStore(loadStore());
  return store.characterModels?.[id] ? publicCharacterModel(store.characterModels[id]) : null;
}

export function getEnemyProfile(id) {
  const store = ensureCharacterStore(loadStore());
  return store.enemyProfiles?.[id] ? publicEnemyProfile(store.enemyProfiles[id]) : null;
}

/** True only for Unity-imported / unity.readiness ready — never browser preview_ready alone. */
export function isUnityAssignableModel(asset) {
  if (!asset || asset.assetType !== "model_3d") return false;
  return asset.state === "unity_imported" || asset.unity?.readiness === "ready";
}

/**
 * Enrich a library model_3d for the Characters picker.
 * Assignable only when Unity-imported; preview_ready is never treated as Unity-ready.
 */
export function describeCharacterModelPickerEntry(asset) {
  const state = asset?.state || "unknown";
  const unityImported = isUnityAssignableModel(asset);
  const previewReady = state === "preview_ready";
  let blockReason = null;
  if (!unityImported) {
    if (state === "unsupported") blockReason = "Unsupported for Unity import.";
    else if (state === "failed") {
      blockReason = asset?.unity?.lastError || asset?.lastError || "Unity import failed.";
    } else if (state === "importing_unity" || state === "pending_unity") {
      blockReason = "Unity import in progress — wait for connector/Unity to finish.";
    } else if (previewReady) {
      blockReason = "Preview ready in browser only — Import to Unity before assigning.";
    } else if (state === "uploading" || state === "uploaded" || state === "processing") {
      blockReason = `Still ${STATE_LABELS[state] || state} — not Unity-imported yet.`;
    } else {
      blockReason = "Not Unity-imported yet — cannot assign to a character model.";
    }
  }
  // Safe retry via existing enqueueUnityImport (new requestId) — not a second import system.
  const canEnqueueImport =
    !unityImported &&
    state !== "unsupported" &&
    state !== "importing_unity" &&
    state !== "pending_unity" &&
    state !== "uploading" &&
    state !== "processing";
  const canRetryImport = state === "failed" && canEnqueueImport;
  const importInFlight = state === "importing_unity" || state === "pending_unity";
  return {
    id: asset.id,
    displayName: asset.displayName || asset.name || asset.id,
    assetType: asset.assetType,
    state,
    stateLabel: STATE_LABELS[state] || state,
    unityReadiness: asset.unity?.readiness || null,
    assignable: unityImported,
    unityImported,
    browserPreviewReady: previewReady || Boolean(asset.preview),
    blockReason,
    canEnqueueImport,
    canRetryImport,
    importInFlight,
    canAddToCatalog: unityImported,
    lastError: asset.unity?.lastError || asset.importError || asset.lastError || null,
  };
}

/** All library model_3d entries for Characters picker (assignable flag set per Unity readiness). */
export function listCharacterModelLibrary({ q = "" } = {}) {
  const { assets } = listAssets({
    type: "model_3d",
    q: q || undefined,
    page: 1,
    pageSize: 100,
  });
  return (assets || []).map(describeCharacterModelPickerEntry);
}

/** Unity-imported only — used by server-side assignment validation callers. */
export function listReadyCharacterModels({ q = "" } = {}) {
  return listCharacterModelLibrary({ q }).filter((m) => m.assignable);
}

/** Ready animation or animatable model_3d assets for idle/attack/locomotion slots. */
export function listReadyAnimations({ q = "" } = {}) {
  const anim = listAssets({
    type: "animation",
    unityReady: "true",
    q: q || undefined,
    page: 1,
    pageSize: 100,
  });
  const models = listAssets({
    type: "model_3d",
    unityReady: "true",
    q: q || undefined,
    page: 1,
    pageSize: 100,
  });
  const byId = new Map();
  for (const a of [...(anim.assets || []), ...(models.assets || [])]) {
    if (!a?.id) continue;
    byId.set(a.id, a);
  }
  return [...byId.values()].sort((a, b) =>
    String(a.displayName || "").localeCompare(String(b.displayName || "")),
  );
}

export function upsertCharacterModel(body = {}) {
  const store = ensureCharacterStore(loadStore());
  const isUpdate = Boolean(body.id && store.characterModels[body.id]);
  if (body.id && !isUpdate) {
    const err = new Error(`Unknown character model id "${body.id}".`);
    err.code = "unknown_id";
    throw err;
  }
  if (body.replaceTrackedXrRig === true) {
    const err = new Error("replaceTrackedXrRig is forbidden — tracked XR rig/camera cannot be replaced.");
    err.code = "invalid_character_safety";
    throw err;
  }
  const id = isUpdate ? body.id : randomUUID();
  const existing = store.characterModels[id];
  const now = new Date().toISOString();
  let kind = existing?.kind || "enemy_visual";
  if (body.kind !== undefined) {
    if (!MODEL_KINDS.has(body.kind)) {
      const err = new Error("kind must be player_character or enemy_visual.");
      err.code = "invalid_kind";
      throw err;
    }
    kind = body.kind;
  }
  const modelAssetId =
    body.modelAssetId !== undefined
      ? validateModelAssetId(body.modelAssetId)
      : existing?.modelAssetId || null;
  let enabled = existing?.enabled !== false;
  if (Object.prototype.hasOwnProperty.call(body, "enabled")) enabled = body.enabled !== false;
  const scale =
    body.scale !== undefined
      ? requireRange(body.scale, 0.05, 10, "scale")
      : requireRange(existing?.scale ?? 1, 0.05, 10, "scale");
  const animations = normalizeAnimations(body.animations, {
    partial: isUpdate && body.animations === undefined,
    existing: existing?.animations || {},
  });
  const rig = validateAnimationRigCompatibility(modelAssetId, animations);
  if (isUpdate && body.expectedVersion != null) {
    const current = Number(existing.version) || 1;
    if (Number(body.expectedVersion) !== current) {
      const err = new Error(`Stale character model version: expected ${body.expectedVersion}, have ${current}.`);
      err.code = "stale_version";
      throw err;
    }
  }
  const version = isUpdate ? (Number(existing.version) || 1) + 1 : 1;
  const entry = {
    id,
    displayName: String(body.displayName || existing?.displayName || "Character").slice(0, 80),
    kind,
    enabled,
    modelAssetId,
    scale,
    animations,
    animationWarnings: rig.warnings || [],
    replaceTrackedXrRig: false,
    note: "Imported character models never replace the tracked XR rig or camera.",
    version,
    unitySync: defaultUnitySync(existing),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  entry.payloadHash = characterModelPayloadHash(entry);
  store.characterModels[id] = entry;
  saveStore(store);
  return publicCharacterModel(entry);
}

export function upsertEnemyProfile(body = {}) {
  const store = ensureCharacterStore(loadStore());
  const isUpdate = Boolean(body.id && store.enemyProfiles[body.id]);
  if (body.id && !isUpdate) {
    const err = new Error(`Unknown enemy profile id "${body.id}".`);
    err.code = "unknown_id";
    throw err;
  }
  const id = isUpdate ? body.id : randomUUID();
  const existing = store.enemyProfiles[id];
  const now = new Date().toISOString();
  const behavior = validateBehavior(body.behavior || {}, {
    partial: isUpdate,
    existing: existing?.behavior || {},
  });
  let modelId = existing?.modelId || null;
  if (body.modelId !== undefined) {
    if (body.modelId === null || body.modelId === "") modelId = null;
    else {
      if (!store.characterModels[body.modelId]) {
        const err = new Error("modelId must reference an existing character model.");
        err.code = "invalid_model_ref";
        throw err;
      }
      if (store.characterModels[body.modelId].kind !== "enemy_visual") {
        const err = new Error("Enemy profiles may only reference enemy_visual models.");
        err.code = "invalid_model_ref";
        throw err;
      }
      modelId = body.modelId;
    }
  }
  let enabled = existing?.enabled !== false;
  if (Object.prototype.hasOwnProperty.call(body, "enabled")) enabled = body.enabled !== false;
  const animations = normalizeAnimations(body.animations, {
    partial: isUpdate && body.animations === undefined,
    existing: existing?.animations || {},
  });
  const linkedModel = modelId ? store.characterModels?.[modelId] : null;
  const rig = validateAnimationRigCompatibility(linkedModel?.modelAssetId || null, animations);
  if (isUpdate && body.expectedVersion != null) {
    const current = Number(existing.version) || 1;
    if (Number(body.expectedVersion) !== current) {
      const err = new Error(`Stale enemy profile version: expected ${body.expectedVersion}, have ${current}.`);
      err.code = "stale_version";
      throw err;
    }
  }
  const version = isUpdate ? (Number(existing.version) || 1) + 1 : 1;
  const entry = {
    id,
    displayName: String(body.displayName || existing?.displayName || "Enemy Profile").slice(0, 80),
    enabled,
    modelId,
    behavior,
    animations,
    animationWarnings: rig.warnings || [],
    version,
    unitySync: defaultUnitySync(existing),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  entry.payloadHash = enemyProfilePayloadHash(entry);
  store.enemyProfiles[id] = entry;
  saveStore(store);
  return publicEnemyProfile(entry);
}

function mappingKey(kind, id) {
  return `${kind}:${id}`;
}

export function collectCharacterModelDependencies(id) {
  const store = ensureCharacterStore(loadStore());
  const entry = store.characterModels?.[id];
  if (!entry) return { exists: false, dependencies: [] };
  const dependencies = [];
  for (const p of Object.values(store.enemyProfiles || {})) {
    if (p.modelId === id) {
      dependencies.push({
        kind: "enemy_profile_ref",
        detail: `Referenced by enemy profile ${p.id}`,
        profileId: p.id,
      });
    }
  }
  const mapping = store.characterMappings?.[mappingKey("model", id)];
  if (mapping?.assetGuid || mapping?.assetPath) {
    dependencies.push({
      kind: "unity_mapping",
      detail: "Unity character model mapping exists.",
      assetGuid: mapping.assetGuid || null,
      assetPath: mapping.assetPath || null,
    });
  }
  for (const j of store.characterJobs || []) {
    if (j.entityId === id && j.entityKind === "model" && ACTIVE_JOB.has(j.status)) {
      dependencies.push({
        kind: "sync_job",
        detail: `Sync job ${j.status}`,
        requestId: j.requestId,
        status: j.status,
      });
    }
  }
  if (entry.unitySync?.state === "applying" || entry.unitySync?.state === "queued") {
    dependencies.push({
      kind: "unity_sync_state",
      detail: `unitySync.state=${entry.unitySync.state}`,
      state: entry.unitySync.state,
    });
  }
  return { exists: true, dependencies, model: publicCharacterModel(entry) };
}

export function collectEnemyProfileDependencies(id) {
  const store = ensureCharacterStore(loadStore());
  const entry = store.enemyProfiles?.[id];
  if (!entry) return { exists: false, dependencies: [] };
  const dependencies = [];
  const mapping = store.characterMappings?.[mappingKey("profile", id)];
  if (mapping?.assetGuid || mapping?.assetPath) {
    dependencies.push({
      kind: "unity_mapping",
      detail: "Unity enemy profile mapping exists.",
      assetGuid: mapping.assetGuid || null,
      assetPath: mapping.assetPath || null,
    });
  }
  for (const j of store.characterJobs || []) {
    if (j.entityId === id && j.entityKind === "profile" && ACTIVE_JOB.has(j.status)) {
      dependencies.push({
        kind: "sync_job",
        detail: `Sync job ${j.status}`,
        requestId: j.requestId,
        status: j.status,
      });
    }
  }
  if (entry.unitySync?.state === "applying" || entry.unitySync?.state === "queued") {
    dependencies.push({
      kind: "unity_sync_state",
      detail: `unitySync.state=${entry.unitySync.state}`,
      state: entry.unitySync.state,
    });
  }
  return { exists: true, dependencies, profile: publicEnemyProfile(entry) };
}

function deleteEntity(kind, id, { unityResolution = null } = {}) {
  const store = ensureCharacterStore(loadStore());
  const bag = kind === "model" ? store.characterModels : store.enemyProfiles;
  if (!bag?.[id]) {
    return { ok: true, deleted: false, idempotent: true, dependencies: [] };
  }
  const mapKey = mappingKey(kind, id);
  const mapping = store.characterMappings?.[mapKey];
  const hasMapping = Boolean(mapping?.assetGuid || mapping?.assetPath);

  if (hasMapping && unityResolution === "retain_unity") {
    if (!store.characterMappingsRetained) store.characterMappingsRetained = {};
    store.characterMappingsRetained[mapKey] = {
      ...mapping,
      retainedAt: new Date().toISOString(),
      state: "managed_retained",
    };
    delete store.characterMappings[mapKey];
    saveStore(store);
  } else if (unityResolution === "unity_deleted" && hasMapping) {
    const err = new Error("Unity definition still mapped; wait for delete acknowledgement or choose retain_unity.");
    err.code = "dependency_blocked";
    err.dependencies = [
      {
        kind: "unity_mapping",
        detail: "Unity mapping still present after unity_deleted request.",
        assetGuid: mapping.assetGuid || null,
        assetPath: mapping.assetPath || null,
      },
    ];
    throw err;
  }

  const deps =
    kind === "model"
      ? collectCharacterModelDependencies(id).dependencies
      : collectEnemyProfileDependencies(id).dependencies;
  const hardBlock = deps.filter((d) =>
    ["enemy_profile_ref", "sync_job", "unity_sync_state", "unity_mapping"].includes(d.kind),
  );
  if (hardBlock.length) {
    const err = new Error("Character entity has dependencies; resolve then retry.");
    err.code = "dependency_blocked";
    err.dependencies = hardBlock;
    err.resolutions = [
      "unityResolution=retain_unity",
      "POST .../unity-delete then delete with unityResolution=unity_deleted",
      "Unlink enemy profiles referencing this model",
    ];
    throw err;
  }

  const store2 = ensureCharacterStore(loadStore());
  if (kind === "model") delete store2.characterModels[id];
  else delete store2.enemyProfiles[id];
  saveStore(store2);
  return {
    ok: true,
    deleted: true,
    idempotent: false,
    unityResolution: unityResolution || null,
    note: "Imported model assets were not deleted.",
  };
}

export function deleteCharacterModel(id, opts) {
  return deleteEntity("model", id, opts);
}

export function deleteEnemyProfile(id, opts) {
  return deleteEntity("profile", id, opts);
}

function enqueueJob({ entityKind, entityId, type, requestId, payload, payloadHash, version }) {
  if (!requestId || typeof requestId !== "string") {
    const err = new Error("requestId required.");
    err.code = "invalid_request";
    throw err;
  }
  const store = ensureCharacterStore(loadStore());
  const bag = entityKind === "model" ? store.characterModels : store.enemyProfiles;
  const entry = bag?.[entityId];
  if (!entry) {
    const err = new Error("Entity not found.");
    err.code = "unknown_id";
    throw err;
  }
  const existing = store.characterJobs.find((j) => j.requestId === requestId);
  if (existing) {
    if (existing.entityId !== entityId || existing.payloadHash !== payloadHash) {
      const err = new Error("requestId reused with a different character payload.");
      err.code = "payload_conflict";
      throw err;
    }
    return { deduplicated: true, job: existing, status: 200 };
  }
  const job = {
    id: randomUUID(),
    requestId,
    type,
    entityKind,
    entityId,
    payloadHash,
    entityVersion: Number(version) || 1,
    payload,
    status: "pending_unity",
    createdAt: new Date().toISOString(),
    attempts: 0,
  };
  store.characterJobs.push(job);
  if (type === "deploy_character_runtime") {
    entry.unityDeploy = {
      ...(entry.unityDeploy || {}),
      state: "queued",
      scenePath: payload?.scenePath || null,
      sceneGuid: payload?.sceneGuid || null,
      lastError: null,
      lastRequestId: requestId,
    };
  } else {
    entry.unitySync = {
      ...(entry.unitySync || {}),
      state: "queued",
      lastError: null,
      lastRequestId: requestId,
    };
  }
  saveStore(store);
  return { deduplicated: false, job, status: 202 };
}

export function buildCharacterModelSyncPayload(id) {
  const store = ensureCharacterStore(loadStore());
  const entry = store.characterModels?.[id];
  if (!entry) {
    const err = new Error("Character model not found.");
    err.code = "unknown_id";
    throw err;
  }
  if (entry.modelAssetId) validateModelAssetId(entry.modelAssetId, { requireReady: true });
  const asset = entry.modelAssetId ? getAsset(entry.modelAssetId) : null;
  const mapping = store.characterMappings?.[mappingKey("model", id)] || {};
  const animations = coerceAnimations(entry.animations || {});
  for (const slot of ANIMATION_SLOTS) {
    if (animations[slot]) validateAnimationAssetId(animations[slot], { requireReady: true, slot });
  }
  const animPaths = animationUnityPaths(animations);
  return {
    characterId: entry.id,
    displayName: entry.displayName,
    kind: entry.kind,
    enabled: entry.enabled !== false,
    scale: Number(entry.scale) || 1,
    replaceTrackedXrRig: false,
    version: Number(entry.version) || 1,
    payloadHash: characterModelPayloadHash(entry),
    modelAssetId: entry.modelAssetId || null,
    modelPrefabPath: asset?.unity?.prefabPath || asset?.unity?.importedPath || null,
    animations,
    animationPaths: {
      idle: animPaths.idle?.unityPath || null,
      attack: animPaths.attack?.unityPath || null,
      locomotion: animPaths.locomotion?.unityPath || null,
    },
    expectedAssetGuid: mapping.assetGuid || entry.unitySync?.assetGuid || null,
    assetPath: `${CHARACTER_MODEL_DIR}/${entry.id}.asset`,
  };
}

export function buildEnemyProfileSyncPayload(id) {
  const store = ensureCharacterStore(loadStore());
  const entry = store.enemyProfiles?.[id];
  if (!entry) {
    const err = new Error("Enemy profile not found.");
    err.code = "unknown_id";
    throw err;
  }
  const mapping = store.characterMappings?.[mappingKey("profile", id)] || {};
  const model = entry.modelId ? store.characterModels?.[entry.modelId] : null;
  const modelMapping = entry.modelId
    ? store.characterMappings?.[mappingKey("model", entry.modelId)]
    : null;
  const animations = coerceAnimations(entry.animations || {});
  for (const slot of ANIMATION_SLOTS) {
    if (animations[slot]) validateAnimationAssetId(animations[slot], { requireReady: true, slot });
  }
  const animPaths = animationUnityPaths(animations);
  return {
    profileId: entry.id,
    displayName: entry.displayName,
    enabled: entry.enabled !== false,
    version: Number(entry.version) || 1,
    payloadHash: enemyProfilePayloadHash(entry),
    behavior: { ...entry.behavior },
    modelId: entry.modelId || null,
    modelAssetGuid: modelMapping?.assetGuid || model?.unitySync?.assetGuid || null,
    animations,
    animationPaths: {
      idle: animPaths.idle?.unityPath || null,
      attack: animPaths.attack?.unityPath || null,
      locomotion: animPaths.locomotion?.unityPath || null,
    },
    expectedAssetGuid: mapping.assetGuid || entry.unitySync?.assetGuid || null,
    assetPath: `${ENEMY_PROFILE_DIR}/${entry.id}.asset`,
  };
}

export function enqueueCharacterModelSync(id, requestId, { expectedVersion } = {}) {
  const store = ensureCharacterStore(loadStore());
  const entry = store.characterModels?.[id];
  if (!entry) {
    const err = new Error("Character model not found.");
    err.code = "unknown_id";
    throw err;
  }
  if (expectedVersion != null && Number(expectedVersion) !== (Number(entry.version) || 1)) {
    const err = new Error(`Stale character model version: expected ${expectedVersion}, have ${entry.version}.`);
    err.code = "stale_version";
    throw err;
  }
  const payload = buildCharacterModelSyncPayload(id);
  return enqueueJob({
    entityKind: "model",
    entityId: id,
    type: "sync_character_model",
    requestId,
    payload,
    payloadHash: payload.payloadHash,
    version: payload.version,
  });
}

export function enqueueEnemyProfileSync(id, requestId, { expectedVersion } = {}) {
  const store = ensureCharacterStore(loadStore());
  const entry = store.enemyProfiles?.[id];
  if (!entry) {
    const err = new Error("Enemy profile not found.");
    err.code = "unknown_id";
    throw err;
  }
  if (expectedVersion != null && Number(expectedVersion) !== (Number(entry.version) || 1)) {
    const err = new Error(`Stale enemy profile version: expected ${expectedVersion}, have ${entry.version}.`);
    err.code = "stale_version";
    throw err;
  }
  const payload = buildEnemyProfileSyncPayload(id);
  return enqueueJob({
    entityKind: "profile",
    entityId: id,
    type: "sync_enemy_profile",
    requestId,
    payload,
    payloadHash: payload.payloadHash,
    version: payload.version,
  });
}

export function enqueueCharacterDeploy(id, requestId, {
  profileId = null,
  scenePath,
  sceneGuid,
  expectedUnityRevision,
  confirmSave = true,
  expectedVersion,
  quantity = 1,
  position,
  rotation,
  scale,
} = {}) {
  const store = ensureCharacterStore(loadStore());
  const entry = store.characterModels?.[id];
  if (!entry) {
    const err = new Error("Character model not found.");
    err.code = "unknown_id";
    throw err;
  }
  if (expectedVersion != null && Number(expectedVersion) !== (Number(entry.version) || 1)) {
    const err = new Error(`Stale character model version: expected ${expectedVersion}, have ${entry.version}.`);
    err.code = "stale_version";
    throw err;
  }
  const mapping = store.characterMappings?.[mappingKey("model", id)];
  if (!mapping?.assetGuid || !mapping?.assetPath || entry.unitySync?.state !== "applied") {
    const err = new Error("Sync this character definition to Unity before deploying it to a scene.");
    err.code = "not_synced";
    throw err;
  }
  if (typeof scenePath !== "string" || !scenePath.startsWith("Assets/") || !scenePath.endsWith(".unity") || scenePath.includes("..")) {
    const err = new Error("scenePath must be an Assets/.../*.unity path.");
    err.code = "invalid_scene";
    throw err;
  }
  if (!/^[a-f0-9]{32}$/i.test(String(sceneGuid || ""))) {
    const err = new Error("sceneGuid must be a 32-character Unity GUID.");
    err.code = "invalid_scene";
    throw err;
  }
  if (!Number.isInteger(expectedUnityRevision) || expectedUnityRevision < 0 || confirmSave !== true) {
    const err = new Error("A current scene revision and explicit save confirmation are required.");
    err.code = "invalid_scene";
    throw err;
  }
  const count = Number(quantity);
  if (!Number.isInteger(count) || count < 1 || count > 8) {
    const err = new Error("quantity must be an integer between 1 and 8.");
    err.code = "invalid_quantity";
    throw err;
  }
  let profile = null;
  let profileMapping = null;
  if (profileId) {
    profile = store.enemyProfiles?.[profileId];
    if (!profile || profile.modelId !== id || entry.kind !== "enemy_visual") {
      const err = new Error("profileId must reference a synced enemy profile linked to this enemy visual.");
      err.code = "invalid_profile";
      throw err;
    }
    profileMapping = store.characterMappings?.[mappingKey("profile", profileId)];
    if (!profileMapping?.assetGuid || !profileMapping?.assetPath || profile.unitySync?.state !== "applied") {
      const err = new Error("Sync the selected enemy profile to Unity before deploying it.");
      err.code = "not_synced";
      throw err;
    }
  }
  const transform = normalizeCharacterDeployTransform({ position, rotation, scale });
  const payload = {
    characterId: id,
    characterKind: entry.kind,
    characterAssetGuid: mapping.assetGuid,
    characterAssetPath: mapping.assetPath,
    profileId: profile?.id || null,
    profileAssetGuid: profileMapping?.assetGuid || null,
    profileAssetPath: profileMapping?.assetPath || null,
    scenePath,
    sceneGuid: String(sceneGuid).toLowerCase(),
    expectedUnityRevision,
    confirmSave: true,
    quantity: count,
    position: transform.position,
    rotation: transform.rotation,
    scale: transform.scale,
    managedObjectId: `HertzStudioManagedCharacter_${id}`,
  };
  const payloadHash = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
  return enqueueJob({ entityKind: "model", entityId: id, type: "deploy_character_runtime", requestId, payload, payloadHash, version: Number(entry.version) || 1 });
}

export function enqueueCharacterUnityDelete(entityKind, entityId, requestId) {
  const store = ensureCharacterStore(loadStore());
  const bag = entityKind === "model" ? store.characterModels : store.enemyProfiles;
  const entry = bag?.[entityId];
  if (!entry) {
    const err = new Error("Entity not found.");
    err.code = "unknown_id";
    throw err;
  }
  const mapKey = mappingKey(entityKind, entityId);
  const mapping = store.characterMappings?.[mapKey];
  if (!mapping?.assetGuid && !mapping?.assetPath) {
    const err = new Error("No Unity mapping to delete.");
    err.code = "no_unity_mapping";
    throw err;
  }
  const type = entityKind === "model" ? "delete_character_definition" : "delete_enemy_profile";
  return enqueueJob({
    entityKind,
    entityId,
    type,
    requestId,
    payload: {
      entityKind,
      entityId,
      expectedAssetGuid: mapping.assetGuid || null,
      assetPath: mapping.assetPath || null,
    },
    payloadHash: `delete:${mapping.assetGuid || ""}:${mapping.assetPath || ""}`,
    version: Number(entry.version) || 1,
  });
}

export function nextCharacterJob() {
  const store = ensureCharacterStore(loadStore());
  return (
    store.characterJobs.find((j) => j.status === "pending_unity" || j.status === "applying") || null
  );
}

export function getCharacterJob(jobId) {
  const store = ensureCharacterStore(loadStore());
  return store.characterJobs.find((j) => j.id === jobId) || null;
}

export function markCharacterJobApplying(jobId) {
  const store = ensureCharacterStore(loadStore());
  const job = store.characterJobs.find((j) => j.id === jobId);
  if (!job) return;
  job.status = "applying";
  job.attempts += 1;
  job.startedAt = new Date().toISOString();
  const bag = job.entityKind === "model" ? store.characterModels : store.enemyProfiles;
  const entry = bag?.[job.entityId];
  if (entry) {
    if (job.type === "deploy_character_runtime") entry.unityDeploy = { ...(entry.unityDeploy || {}), state: "applying", lastError: null };
    else entry.unitySync = { ...(entry.unitySync || {}), state: "applying", lastError: null };
  }
  saveStore(store);
}

export function acknowledgeCharacterSync({
  requestId,
  ok,
  error,
  conflict,
  assetGuid,
  assetPath,
  observedPayloadHash,
  observedVersion,
  unityRevision,
  scenePath,
  sceneGuid,
  managedObjectIds,
}) {
  const store = ensureCharacterStore(loadStore());
  const job = store.characterJobs.find((j) => j.requestId === requestId);
  if (!job) return null;
  if (["applied", "failed", "conflict"].includes(job.status)) {
    const bag = job.entityKind === "model" ? store.characterModels : store.enemyProfiles;
    const entry = bag?.[job.entityId];
    return {
      deduplicated: true,
      job,
      entity:
        job.entityKind === "model" ? publicCharacterModel(entry) : publicEnemyProfile(entry),
    };
  }
  const bag = job.entityKind === "model" ? store.characterModels : store.enemyProfiles;
  const entry = bag?.[job.entityId];
  const mapKey = mappingKey(job.entityKind, job.entityId);

  if (ok) {
    if (job.type === "deploy_character_runtime") {
      const expected = job.payload || {};
      const ids = Array.isArray(managedObjectIds) ? managedObjectIds.filter(Boolean) : [];
      const identityMatches = scenePath === expected.scenePath && String(sceneGuid || "").toLowerCase() === String(expected.sceneGuid || "").toLowerCase();
      if (!identityMatches || ids.length !== expected.quantity) {
        job.status = "conflict";
        job.error = !identityMatches ? "Unity deploy acknowledgement scene identity does not match the queued target." : "Unity deploy acknowledgement omitted stable managed object identities.";
        if (entry) entry.unityDeploy = { ...(entry.unityDeploy || {}), state: "conflict", lastError: job.error };
        saveStore(store);
        return { deduplicated: false, job, entity: publicCharacterModel(entry) };
      }
      job.status = "applied";
      job.appliedAt = new Date().toISOString();
      job.scenePath = scenePath;
      job.sceneGuid = String(sceneGuid).toLowerCase();
      job.managedObjectIds = ids;
      if (entry) {
        entry.unityDeploy = { state: "applied", scenePath, sceneGuid: String(sceneGuid).toLowerCase(), unityRevision: unityRevision ?? null, managedObjectIds: ids, profileId: expected.profileId || null, lastError: null, lastDeployedAt: new Date().toISOString(), lastRequestId: requestId };
      }
      saveStore(store);
      return { deduplicated: false, job, entity: publicCharacterModel(entry) };
    }
    if (job.type === "delete_character_definition" || job.type === "delete_enemy_profile") {
      job.status = "applied";
      job.appliedAt = new Date().toISOString();
      if (store.characterMappings?.[mapKey]) delete store.characterMappings[mapKey];
      if (entry) {
        entry.unitySync = {
          state: "disconnected",
          assetGuid: null,
          assetPath: null,
          lastError: null,
          lastSyncedAt: new Date().toISOString(),
          lastRequestId: requestId,
          deletedInUnity: true,
        };
      }
      saveStore(store);
      return {
        deduplicated: false,
        job,
        entity:
          job.entityKind === "model" ? publicCharacterModel(entry) : publicEnemyProfile(entry),
      };
    }
    if (!assetGuid || !assetPath || !String(assetPath).startsWith("Assets/")) {
      job.status = "failed";
      job.error = "Unity ack missing authoritative assetGuid/assetPath.";
      if (entry) {
        entry.unitySync = { ...(entry.unitySync || {}), state: "failed", lastError: job.error };
      }
      saveStore(store);
      return {
        deduplicated: false,
        job,
        entity:
          job.entityKind === "model" ? publicCharacterModel(entry) : publicEnemyProfile(entry),
      };
    }
    if (observedPayloadHash && observedPayloadHash !== job.payloadHash) {
      job.status = "conflict";
      job.error = "Observed payload hash does not match queued sync payload.";
      if (entry) {
        entry.unitySync = { ...(entry.unitySync || {}), state: "conflict", lastError: job.error };
      }
      saveStore(store);
      return {
        deduplicated: false,
        job,
        entity:
          job.entityKind === "model" ? publicCharacterModel(entry) : publicEnemyProfile(entry),
      };
    }
    job.status = "applied";
    job.appliedAt = new Date().toISOString();
    store.characterMappings[mapKey] = {
      entityKind: job.entityKind,
      entityId: job.entityId,
      assetGuid,
      assetPath,
      updatedAt: new Date().toISOString(),
      unityRevision: unityRevision ?? null,
    };
    if (entry) {
      entry.unitySync = {
        state: "applied",
        assetGuid,
        assetPath,
        lastError: null,
        lastSyncedAt: new Date().toISOString(),
        lastRequestId: requestId,
        payloadHash: job.payloadHash,
        observedPayloadHash: observedPayloadHash || job.payloadHash,
        observedVersion: observedVersion ?? job.entityVersion,
      };
    }
    saveStore(store);
    return {
      deduplicated: false,
      job,
      entity:
        job.entityKind === "model" ? publicCharacterModel(entry) : publicEnemyProfile(entry),
    };
  }

  job.status = conflict ? "conflict" : "failed";
  job.error = error || (conflict ? "Character sync conflict." : "Character sync failed.");
  if (entry) {
    if (job.type === "deploy_character_runtime") {
      entry.unityDeploy = { ...(entry.unityDeploy || {}), state: conflict ? "conflict" : "failed", lastError: job.error, lastRequestId: requestId };
    } else {
      entry.unitySync = { ...(entry.unitySync || {}), state: conflict ? "conflict" : "failed", lastError: job.error, lastRequestId: requestId };
    }
  }
  saveStore(store);
  return {
    deduplicated: false,
    job,
    entity: job.entityKind === "model" ? publicCharacterModel(entry) : publicEnemyProfile(entry),
  };
}

export function recoverCharacterJobsOnBoot() {
  const store = ensureCharacterStore(loadStore());
  let changed = 0;
  for (const j of store.characterJobs) {
    if (j.status === "applying") {
      j.status = "pending_unity";
      j.recoveredAt = new Date().toISOString();
      changed += 1;
      const bag = j.entityKind === "model" ? store.characterModels : store.enemyProfiles;
      const entry = bag?.[j.entityId];
      if (entry) {
        entry.unitySync = {
          ...(entry.unitySync || {}),
          state: "queued",
          lastError: "Recovered after restart.",
        };
      }
    }
  }
  if (changed) saveStore(store);
  return { recovered: changed };
}

export { BEHAVIOR_MODES, MODEL_KINDS, SYNC_STATES };
