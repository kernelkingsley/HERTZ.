/**
 * W04 weapon catalog — dual-pistol loadout only. No rarity/shop/unlock systems.
 * Persists in store.json: weapons, weaponLoadout, weaponJobs, weaponMappings.
 */
import { createHash, randomUUID } from "node:crypto";
import { loadStore, saveStore } from "./store.mjs";
import { getAsset, listAssets } from "./assets/catalog.mjs";
import { STATE_LABELS } from "./assets/types.mjs";
import { isUuid } from "./draft-commands.mjs";

const DEFAULT_LOADOUT = {
  frequencyFlipRequired: true,
  slots: ["left_pistol", "right_pistol"],
  leftWeaponId: null,
  rightWeaponId: null,
  note: "Catalog imports never auto-equip new weapon types. Frequency flip remains the gate.",
};

const ANCHOR_MAX = 64;
const SYNC_STATES = new Set([
  "disconnected",
  "queued",
  "applying",
  "applied",
  "failed",
  "conflict",
  "stale",
]);

const WEAPON_ASSET_DIR = "Assets/HertzStudio/Weapons/Definitions";
export const MANAGED_WRAPPERS_ROOT = "Assets/HertzStudio/Weapons/Wrappers";

/** Normalize Assets/ paths; reject traversal, absolute FS paths, and non-Assets roots. */
export function normalizeWeaponAssetPath(path) {
  if (path == null || typeof path !== "string") return null;
  let p = path.trim().replace(/\\/g, "/");
  try {
    p = decodeURIComponent(p);
  } catch {
    // keep raw
  }
  p = p.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (!p || p.includes("..")) return null;
  if (/^[a-zA-Z]:/.test(p) || p.startsWith("/") || p.startsWith("//")) return null;
  if (!p.startsWith("Assets/")) return null;
  return p;
}

/** Managed wrapper must be Assets/HertzStudio/Weapons/Wrappers/<weaponId>/<file>.prefab */
export function isManagedWrapperPathForWeapon(path, weaponId) {
  const n = normalizeWeaponAssetPath(path);
  if (!n || !weaponId || typeof weaponId !== "string") return false;
  if (!n.endsWith(".prefab")) return false;
  const prefix = `${MANAGED_WRAPPERS_ROOT}/${weaponId.trim()}/`;
  if (!n.startsWith(prefix)) return false;
  const rest = n.slice(prefix.length);
  return Boolean(rest) && !rest.includes("/");
}

export function isManagedWrappersPath(path) {
  const n = normalizeWeaponAssetPath(path);
  return Boolean(n && n.startsWith(`${MANAGED_WRAPPERS_ROOT}/`) && n.endsWith(".prefab"));
}

/** Studio/API gate: managed wrappers need authoritative confirmation before Sync/Deploy. */
export function wrapperNeedsConfirmation(meta) {
  if (!meta || typeof meta !== "object") return false;
  if (meta.confirmed === true && meta.provisional !== true && meta.needsConfirmation !== true) {
    return false;
  }
  if (meta.needsConfirmation === true) return true;
  if (meta.recoveryReason === "missing_metadata") return true;
  if (meta.provisional === true && meta.confirmed !== true) return true;
  if (meta.confirmed !== true) return true;
  return false;
}

function assertManagedWrapperReadyForEnqueue(entry) {
  const path = entry?.runtimeModelPrefabPath || entry?.wrapperAnchorMeta?.path || null;
  if (!path || !isManagedWrappersPath(path)) return;
  const normalized = normalizeWeaponAssetPath(path);
  if (!isManagedWrapperPathForWeapon(normalized, entry.id)) {
    const err = new Error(
      `Managed wrapper path must be under ${MANAGED_WRAPPERS_ROOT}/${entry.id}/. Got: ${normalized}`,
    );
    err.code = "wrapper_path_invalid";
    throw err;
  }
  const wrap = entry.wrapperAnchorMeta;
  if (!wrap || wrapperNeedsConfirmation(wrap) || wrap.confirmed !== true) {
    const err = new Error(
      wrap?.recoveryReason === "missing_metadata"
        ? "Legacy managed wrapper is missing confirmation metadata. Confirm Grip/Muzzle in Studio before Sync/Deploy."
        : "Managed Grip/Muzzle wrapper is unconfirmed. Confirm anchors in Studio before Sync/Deploy.",
    );
    err.code = "anchors_unconfirmed";
    throw err;
  }
}

/**
 * Authoritative confirm path for a weapon: saved wrapper only.
 * Caller-supplied paths must normalize to exactly the saved path.
 */
export function resolveConfirmWrapperPath(weapon, requestedPath) {
  if (!weapon?.id) {
    const err = new Error("Weapon not found.");
    err.code = "unknown_id";
    throw err;
  }
  const saved = normalizeWeaponAssetPath(
    weapon.wrapperAnchorMeta?.path || weapon.runtimeModelPrefabPath || null,
  );
  if (!saved) {
    const err = new Error("No managed wrapper prefab on this weapon.");
    err.code = "no_wrapper";
    throw err;
  }
  if (!isManagedWrapperPathForWeapon(saved, weapon.id)) {
    const err = new Error(
      `Saved wrapper path is not under ${MANAGED_WRAPPERS_ROOT}/${weapon.id}/. Confirmation rejected.`,
    );
    err.code = "wrapper_path_invalid";
    throw err;
  }
  if (requestedPath != null && String(requestedPath).trim() !== "") {
    const req = normalizeWeaponAssetPath(String(requestedPath));
    if (!req || req !== saved) {
      const err = new Error(
        "wrapperPrefabPath must match the weapon's saved managed wrapper path. Relinking to another prefab is not allowed during confirmation.",
      );
      err.code = "wrapper_path_mismatch";
      throw err;
    }
  }
  return saved;
}

/**
 * Authoritative imported source prefab for a weapon — Asset Library record wins.
 * Optional requestedPath must normalize to exactly the authoritative path.
 */
export function resolveAuthoritativeWeaponSourcePrefab(weapon, { requestedPath } = {}) {
  if (!weapon?.id) {
    const err = new Error("Weapon not found.");
    err.code = "unknown_id";
    throw err;
  }
  if (!weapon.modelAssetId) {
    const err = new Error("Weapon has no modelAssetId. Assign an imported Unity model before creating a wrapper.");
    err.code = "no_model";
    throw err;
  }
  const asset = getAsset(weapon.modelAssetId);
  if (!asset) {
    const err = new Error("Weapon modelAssetId not found in Asset Library.");
    err.code = "unknown_model";
    throw err;
  }
  const authPath = normalizeWeaponAssetPath(asset.unity?.prefabPath || null);
  if (!authPath || !authPath.endsWith(".prefab")) {
    const err = new Error(
      "No authoritative Unity prefabPath on the assigned Asset Library model. Import the model to Unity first.",
    );
    err.code = "no_prefab";
    throw err;
  }
  if (isManagedWrappersPath(authPath)) {
    const err = new Error("Authoritative source cannot be a managed Wrappers/ prefab.");
    err.code = "wrapper_source_mismatch";
    throw err;
  }
  if (requestedPath != null && String(requestedPath).trim() !== "") {
    const req = normalizeWeaponAssetPath(String(requestedPath));
    if (!req || req !== authPath) {
      const err = new Error(
        `Caller sourcePrefabPath must match the weapon's authoritative imported prefab (${authPath}).`,
      );
      err.code = "wrapper_source_mismatch";
      throw err;
    }
  }
  return {
    modelAssetId: weapon.modelAssetId,
    sourcePrefabPath: authPath,
    sourcePrefabGuid: asset.unity?.prefabGuid || asset.unity?.guid || null,
  };
}

/** Pure helper: build Studio wrapperAnchorMeta from Unity create/confirm bridge payload. */
export function buildWrapperAnchorMetaFromBridge(weaponId, data = {}, { confirmedOverride } = {}) {
  const path = normalizeWeaponAssetPath(data.wrapperPrefabPath || data.path || null);
  const recoveryReason = data.recoveryReason ? String(data.recoveryReason).slice(0, 64) : null;
  const needsConfirmation =
    confirmedOverride === true
      ? false
      : data.needsConfirmation === true ||
        recoveryReason === "missing_metadata" ||
        data.anchorsProvisional === true ||
        data.anchorsConfirmed !== true;
  const confirmed =
    confirmedOverride === true ||
    (data.anchorsConfirmed === true && !needsConfirmation && data.needsConfirmation !== true);
  return {
    path,
    provisional: needsConfirmation || data.anchorsProvisional === true,
    confirmed,
    needsConfirmation: confirmed ? false : needsConfirmation,
    recoveryReason: confirmed ? null : recoveryReason || (needsConfirmation ? "unconfirmed" : null),
    sourcePrefabGuid: data.sourcePrefabGuid || null,
    sourcePrefabPath: data.sourcePrefabPath ? normalizeWeaponAssetPath(data.sourcePrefabPath) : null,
    modelAssetId: data.modelAssetId || null,
    wrapperVersion: Number(data.wrapperVersion) || 1,
    gripFromSource: data.gripFromSource === true,
    muzzleFromSource: data.muzzleFromSource === true,
    confirmedAt: confirmed ? data.confirmedAt || new Date().toISOString() : null,
    weaponId,
  };
}

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

function sanitizeAnchor(value, label, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const s = String(value).trim();
  if (!s || s.length > ANCHOR_MAX) {
    const err = new Error(`${label} must be 1..${ANCHOR_MAX} characters.`);
    err.code = "invalid_tuning";
    throw err;
  }
  return s;
}

export function validateTuning(input = {}, { partial = false, existing = {} } = {}) {
  const src = { ...existing, ...input };
  const need = (key, fallback) => {
    if (partial && input[key] === undefined) return existing[key] ?? fallback;
    return src[key] ?? fallback;
  };
  return {
    damage: requireRange(need("damage", 10), 0, 1000, "damage"),
    fireIntervalSeconds: requireRange(need("fireIntervalSeconds", 0.2), 0.05, 10, "fireIntervalSeconds"),
    rangeMeters: requireRange(need("rangeMeters", 40), 1, 500, "rangeMeters"),
    recoil: requireRange(need("recoil", 0.15), 0, 5, "recoil"),
    leftHandAnchor: sanitizeAnchor(need("leftHandAnchor", "LeftHand"), "leftHandAnchor", "LeftHand"),
    rightHandAnchor: sanitizeAnchor(need("rightHandAnchor", "RightHand"), "rightHandAnchor", "RightHand"),
    gripAnchor: sanitizeAnchor(need("gripAnchor", "Grip"), "gripAnchor", "Grip"),
    muzzleAnchor: sanitizeAnchor(need("muzzleAnchor", "Muzzle"), "muzzleAnchor", "Muzzle"),
  };
}

function validateRole(role, existing) {
  if (role === undefined || role === null || role === "") {
    return existing || "left_pistol";
  }
  if (role !== "left_pistol" && role !== "right_pistol") {
    const err = new Error(`role must be left_pistol or right_pistol (got ${JSON.stringify(role)}).`);
    err.code = "invalid_role";
    throw err;
  }
  return role;
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
      const err = new Error("modelAssetId is not imported/ready in Unity yet. Import the model first.");
      err.code = "invalid_model";
      throw err;
    }
  }
  return modelAssetId;
}

/** Canonical invariant serialization for payload hashing (sorted keys, finite numbers). */
export function canonicalWeaponPayload(entry) {
  const tuning = entry.tuning || {};
  const payload = {
    damage: Number(tuning.damage),
    displayName: String(entry.displayName || ""),
    enabled: entry.enabled !== false,
    fireIntervalSeconds: Number(tuning.fireIntervalSeconds),
    frequencyFlipRequired: entry.frequencyFlipRequired !== false,
    gripAnchor: String(tuning.gripAnchor || ""),
    leftHandAnchor: String(tuning.leftHandAnchor || ""),
    modelAssetId: entry.modelAssetId || null,
    muzzleAnchor: String(tuning.muzzleAnchor || ""),
    rangeMeters: Number(tuning.rangeMeters),
    recoil: Number(tuning.recoil),
    rightHandAnchor: String(tuning.rightHandAnchor || ""),
    role: entry.role === "right_pistol" ? "right_pistol" : "left_pistol",
    weaponId: String(entry.id),
  };
  return JSON.stringify(payload);
}

export function weaponPayloadHash(entry) {
  return createHash("sha256").update(canonicalWeaponPayload(entry), "utf8").digest("hex");
}

function ensureWeaponStore(store) {
  if (!store.weapons) store.weapons = {};
  if (!store.weaponLoadout) store.weaponLoadout = { ...DEFAULT_LOADOUT };
  if (!store.weaponJobs) store.weaponJobs = [];
  if (!store.weaponMappings) store.weaponMappings = {};
  if (!store.weaponMappingsRetained) store.weaponMappingsRetained = {};
  if (!store.weaponRemovalRequests) store.weaponRemovalRequests = {};
  if (!store.weaponRemovalLocks) store.weaponRemovalLocks = {};
  return store;
}

const ACTIVE_JOB_STATUSES = new Set(["pending_unity", "queued", "applying"]);
const CANCELLABLE_JOB_STATUSES = new Set(["pending_unity", "queued"]);

function activeJobsForWeapon(store, weaponId) {
  return (store.weaponJobs || []).filter(
    (j) => j.weaponId === weaponId && ACTIVE_JOB_STATUSES.has(j.status),
  );
}

function assertNoOverlappingRemoval(store, weaponId, requestId) {
  const lock = store.weaponRemovalLocks?.[weaponId];
  if (
    lock &&
    lock.requestId &&
    lock.requestId !== requestId &&
    (lock.status === "in_flight" || lock.status === "waiting_unity")
  ) {
    const err = new Error(
      "A removal workflow is already in progress for this weapon. Wait for it to finish or refresh status.",
    );
    err.code = "removal_in_progress";
    err.lock = lock;
    throw err;
  }
}

function normalizeRemovalSides(sides) {
  if (!Array.isArray(sides)) return [];
  return [...new Set(sides.filter((s) => s === "left" || s === "right"))].sort();
}

/**
 * Canonical request-side identity for guided removal.
 * Omitted sides (null/undefined) stay "omitted" forever — never re-inferred into the hash.
 * Explicit arrays are normalized. Effective/inferred sides are stored separately.
 */
function canonicalizeRequestedSides(sides) {
  if (sides == null) {
    return { sidesMode: "omitted", requestedSides: [] };
  }
  if (!Array.isArray(sides)) {
    const err = new Error("sides must be an array of 'left' and/or 'right', or omitted.");
    err.code = "invalid_request";
    throw err;
  }
  return { sidesMode: "explicit", requestedSides: normalizeRemovalSides(sides) };
}

function removalPayloadHash({ weaponId, action, sidesMode = "omitted", requestedSides = [] }) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        weaponId: String(weaponId || ""),
        action: String(action || ""),
        sidesMode: sidesMode === "explicit" ? "explicit" : "omitted",
        requestedSides: sidesMode === "explicit" ? normalizeRemovalSides(requestedSides) : [],
      }),
      "utf8",
    )
    .digest("hex");
}

function requireRemovalRequestId(requestId) {
  if (typeof requestId !== "string") {
    const err = new Error("requestId required for guided removal actions.");
    err.code = "invalid_request";
    throw err;
  }
  if (!requestId || !requestId.trim() || requestId !== requestId.trim() || /\s/.test(requestId)) {
    const err = new Error(
      "requestId must be a non-empty string without whitespace or leading/trailing spaces.",
    );
    err.code = "invalid_request";
    throw err;
  }
  return requestId;
}

function rememberRemovalResult(
  store,
  requestId,
  result,
  { weaponId, action, sidesMode = "omitted", requestedSides = [], effectiveSides = null } = {},
) {
  const payloadHash = removalPayloadHash({ weaponId, action, sidesMode, requestedSides });
  const record = {
    ...result,
    requestId,
    weaponId,
    action,
    sidesMode: sidesMode === "explicit" ? "explicit" : "omitted",
    requestedSides: sidesMode === "explicit" ? normalizeRemovalSides(requestedSides) : [],
    // Effective/inferred sides for UI — not part of identity hash.
    sides: normalizeRemovalSides(effectiveSides ?? result.sides ?? requestedSides),
    effectiveSides: normalizeRemovalSides(effectiveSides ?? result.sides ?? requestedSides),
    payloadHash,
    rememberedAt: new Date().toISOString(),
  };
  store.weaponRemovalRequests[requestId] = record;
  saveStore(store);
  return record;
}

/** Replay if exact match; throw idempotency_conflict if requestId reused with different identity/payload. */
function lookupRemovalRequest(
  store,
  requestId,
  { weaponId, action, sidesMode = "omitted", requestedSides = [] },
) {
  const prior = store.weaponRemovalRequests?.[requestId];
  if (!prior) return null;
  const payloadHash = removalPayloadHash({ weaponId, action, sidesMode, requestedSides });
  const priorMode = prior.sidesMode || (prior.sides?.length ? "explicit" : "omitted");
  if (
    prior.weaponId !== weaponId ||
    prior.action !== action ||
    prior.payloadHash !== payloadHash ||
    priorMode !== (sidesMode === "explicit" ? "explicit" : "omitted")
  ) {
    const err = new Error(
      "requestId reused with a different weapon, action, or payload (idempotency conflict).",
    );
    err.code = "idempotency_conflict";
    err.prior = {
      weaponId: prior.weaponId || null,
      action: prior.action || null,
      sidesMode: priorMode,
      requestedSides: prior.requestedSides || [],
      payloadHash: prior.payloadHash || null,
      status: prior.status || null,
    };
    throw err;
  }
  return { ...prior, deduplicated: true };
}

function releaseRemovalLock(store, weaponId, requestId) {
  const lock = store.weaponRemovalLocks?.[weaponId];
  if (lock && lock.requestId === requestId) {
    delete store.weaponRemovalLocks[weaponId];
  }
}

function writeTerminalAutoRemoveResult(store, job, { status, error = null, deleted = false }) {
  if (!job?.autoRemoveCatalog || !job.requestId) return;
  releaseRemovalLock(store, job.weaponId, job.requestId);
  const modelAssetId = store.weapons?.[job.weaponId]?.modelAssetId || null;
  const nextAction =
    status === "conflict"
      ? "Unity reported a conflict. Refresh status, then retry Delete Unity definition and remove with a new requestId, or Keep Unity definition and remove catalog entry."
      : "Unity definition delete failed. Retry Delete Unity definition and remove with a new requestId, or Keep Unity definition and remove catalog entry.";
  store.weaponRemovalRequests[job.requestId] = {
    ok: false,
    action: "delete_unity_and_remove",
    status,
    deleted,
    error: error || job.error || "Unity definition delete did not complete.",
    nextAction,
    requestId: job.requestId,
    weaponId: job.weaponId,
    sidesMode: "omitted",
    requestedSides: [],
    sides: [],
    effectiveSides: [],
    payloadHash: removalPayloadHash({
      weaponId: job.weaponId,
      action: "delete_unity_and_remove",
      sidesMode: "omitted",
      requestedSides: [],
    }),
    modelAssetId,
    modelPreserved: modelAssetId ? Boolean(getAsset(modelAssetId)) : true,
    rememberedAt: new Date().toISOString(),
  };
}

function publicUnitySync(sync) {
  const s = sync || {};
  return {
    state: SYNC_STATES.has(s.state) ? s.state : "disconnected",
    assetGuid: s.assetGuid || null,
    // Public project-relative path only — never absolute filesystem paths.
    assetPath: s.assetPath && String(s.assetPath).startsWith("Assets/") ? s.assetPath : s.assetPath || null,
    lastError: s.lastError || null,
    lastSyncedAt: s.lastSyncedAt || null,
    lastRequestId: s.lastRequestId || null,
    payloadHash: s.payloadHash || null,
    observedPayloadHash: s.observedPayloadHash || s.payloadHash || null,
    observedVersion: s.observedVersion ?? null,
    modelImported: s.modelImported === true,
    definitionSynced: s.definitionSynced === true || s.state === "applied",
    anchorsValid: s.anchorsValid === true,
    runtimeDeployApplied: s.runtimeDeployApplied === true,
    runtimePlayable: s.runtimePlayable === true,
    missingAnchors: Array.isArray(s.missingAnchors) ? s.missingAnchors : [],
    prefabPath: s.prefabPath && String(s.prefabPath).startsWith("Assets/") ? s.prefabPath : s.prefabPath || null,
  };
}

function deriveRuntimeReadiness(entry) {
  const asset = entry?.modelAssetId ? getAsset(entry.modelAssetId) : null;
  const modelImported = Boolean(
    asset?.unity?.prefabPath ||
      asset?.unity?.importedPath ||
      entry?.runtimeModelPrefabPath ||
      entry?.unitySync?.modelImported,
  );
  const definitionSynced = entry?.unitySync?.state === "applied" && entry?.unitySync?.definitionSynced === true;
  const anchorsValid = entry?.unitySync?.anchorsValid === true;
  const runtimeDeployApplied =
    entry?.unitySync?.runtimeDeployApplied === true &&
    Boolean(entry?.unityDeploy?.scenePath && entry?.unityDeploy?.lastDeployedAt);
  // Playable only from authoritative true — never from omitted fields.
  const runtimePlayable =
    modelImported &&
    definitionSynced &&
    anchorsValid &&
    runtimeDeployApplied &&
    entry?.unitySync?.runtimePlayable === true;
  return {
    modelImported,
    definitionSynced,
    anchorsValid,
    runtimeDeployApplied,
    runtimePlayable,
    missingAnchors: Array.isArray(entry?.unitySync?.missingAnchors) ? entry.unitySync.missingAnchors : [],
    runtimeModelPrefabPath: entry?.runtimeModelPrefabPath || null,
  };
}

export function publicWeapon(entry) {
  if (!entry) return null;
  return {
    id: entry.id,
    displayName: entry.displayName,
    enabled: entry.enabled !== false,
    role: entry.role,
    modelAssetId: entry.modelAssetId || null,
    frequencyFlipRequired: entry.frequencyFlipRequired !== false,
    version: Number(entry.version) || 1,
    payloadHash: entry.payloadHash || weaponPayloadHash(entry),
    tuning: { ...entry.tuning },
    runtimeModelPrefabPath: entry.runtimeModelPrefabPath || null,
    wrapperAnchorMeta: entry.wrapperAnchorMeta
      ? (() => {
          const needsConfirmation = wrapperNeedsConfirmation(entry.wrapperAnchorMeta);
          return {
            path: entry.wrapperAnchorMeta.path || entry.runtimeModelPrefabPath || null,
            provisional:
              entry.wrapperAnchorMeta.provisional === true ||
              entry.wrapperAnchorMeta.recoveryReason === "missing_metadata" ||
              needsConfirmation,
            confirmed: entry.wrapperAnchorMeta.confirmed === true && !needsConfirmation,
            needsConfirmation,
            recoveryReason: entry.wrapperAnchorMeta.recoveryReason || null,
            sourcePrefabGuid: entry.wrapperAnchorMeta.sourcePrefabGuid || null,
            sourcePrefabPath: entry.wrapperAnchorMeta.sourcePrefabPath || null,
            modelAssetId: entry.wrapperAnchorMeta.modelAssetId || entry.modelAssetId || null,
            wrapperVersion: entry.wrapperAnchorMeta.wrapperVersion || 1,
            gripFromSource: entry.wrapperAnchorMeta.gripFromSource === true,
            muzzleFromSource: entry.wrapperAnchorMeta.muzzleFromSource === true,
            confirmedAt: entry.wrapperAnchorMeta.confirmedAt || null,
            weaponId: entry.wrapperAnchorMeta.weaponId || entry.id,
          };
        })()
      : null,
    runtimeReadiness: deriveRuntimeReadiness(entry),
    unitySync: publicUnitySync(entry.unitySync),
    unityDeploy: entry.unityDeploy
      ? {
          scenePath: entry.unityDeploy.scenePath || null,
          sceneGuid: entry.unityDeploy.sceneGuid || null,
          managedObjectId: entry.unityDeploy.managedObjectId || null,
          lastDeployedAt: entry.unityDeploy.lastDeployedAt || null,
          lastRequestId: entry.unityDeploy.lastRequestId || null,
          weaponVersion: entry.unityDeploy.weaponVersion ?? null,
          payloadHash: entry.unityDeploy.payloadHash || null,
        }
      : null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

export function listWeapons() {
  const store = ensureWeaponStore(loadStore());
  return {
    loadout: { ...DEFAULT_LOADOUT, ...(store.weaponLoadout || {}) },
    weapons: Object.values(store.weapons)
      .map(publicWeapon)
      .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt))),
  };
}

export function getWeapon(id) {
  const store = ensureWeaponStore(loadStore());
  const entry = store.weapons?.[id];
  return entry ? publicWeapon(entry) : null;
}

/** True only for Unity-imported / unity.readiness ready — never browser preview_ready alone. */
export function isUnityAssignableWeaponModel(asset) {
  if (!asset || asset.assetType !== "model_3d") return false;
  return asset.state === "unity_imported" || asset.unity?.readiness === "ready";
}

/**
 * Enrich a library model_3d for the Weapons picker.
 * Assignable only when Unity-imported; every model_3d is listed with truthful state/actions.
 */
export function describeWeaponModelPickerEntry(asset) {
  const state = asset?.state || "unknown";
  const unityImported = isUnityAssignableWeaponModel(asset);
  const previewReady = state === "preview_ready";
  let blockReason = null;
  if (!unityImported) {
    if (state === "unsupported") blockReason = "Unsupported for Unity import — cannot assign as a weapon mesh.";
    else if (state === "failed") {
      blockReason = asset?.unity?.lastError || asset?.lastError || "Unity import failed.";
    } else if (state === "importing_unity" || state === "pending_unity") {
      blockReason = "Unity import in progress — wait for connector/Unity to finish.";
    } else if (previewReady) {
      blockReason = "Preview ready in browser only — Import to Unity before assigning.";
    } else if (state === "uploading" || state === "uploaded" || state === "processing") {
      blockReason = `Still ${STATE_LABELS[state] || state} — not Unity-imported yet.`;
    } else {
      blockReason = "Not Unity-imported yet — cannot assign to a weapon definition.";
    }
  }
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
    modelAssetId: asset.id,
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
    canSelect: unityImported,
    lastError: asset.unity?.lastError || asset.importError || asset.lastError || null,
  };
}

/** All library model_3d entries for Weapons picker (search filters the full collection). */
export function listWeaponModelLibrary({ q = "" } = {}) {
  const { assets } = listAssets({
    type: "model_3d",
    q: q || undefined,
    page: 1,
    pageSize: 100,
  });
  return (assets || []).map(describeWeaponModelPickerEntry);
}

/** Unity-imported only — used by sync/deploy validation. */
export function listReadyWeaponModels({ q = "" } = {}) {
  return listWeaponModelLibrary({ q }).filter((m) => m.assignable);
}

export function upsertWeapon(body = {}) {
  const store = ensureWeaponStore(loadStore());
  const isUpdate = Boolean(body.id && store.weapons[body.id]);
  if (body.id && !isUpdate) {
    const err = new Error(`Unknown weapon id "${body.id}" — refusing to create under a client-supplied id.`);
    err.code = "unknown_id";
    throw err;
  }

  const id = isUpdate ? body.id : randomUUID();
  const existing = store.weapons[id];
  const now = new Date().toISOString();
  const tuning = validateTuning(body.tuning || {}, { partial: isUpdate, existing: existing?.tuning || {} });
  const modelAssetId =
    body.modelAssetId !== undefined
      ? validateModelAssetId(body.modelAssetId)
      : existing?.modelAssetId || null;
  const role = validateRole(body.role, existing?.role);

  let enabled = existing?.enabled !== false;
  if (Object.prototype.hasOwnProperty.call(body, "enabled")) {
    enabled = body.enabled !== false;
  }

  let frequencyFlipRequired = existing?.frequencyFlipRequired !== false;
  if (Object.prototype.hasOwnProperty.call(body, "frequencyFlipRequired")) {
    frequencyFlipRequired = body.frequencyFlipRequired !== false;
  }

  if (isUpdate && body.expectedVersion != null) {
    const current = Number(existing.version) || 1;
    if (Number(body.expectedVersion) !== current) {
      const err = new Error(`Stale weapon version: expected ${body.expectedVersion}, have ${current}.`);
      err.code = "stale_version";
      throw err;
    }
  }

  let runtimeModelPrefabPath = existing?.runtimeModelPrefabPath || null;
  if (Object.prototype.hasOwnProperty.call(body, "runtimeModelPrefabPath")) {
    const raw = body.runtimeModelPrefabPath;
    if (raw === null || raw === "") {
      runtimeModelPrefabPath = null;
    } else {
      const path = normalizeWeaponAssetPath(String(raw));
      if (!path || !path.endsWith(".prefab")) {
        const err = new Error("runtimeModelPrefabPath must be an Assets/…/*.prefab path without traversal.");
        err.code = "invalid_prefab_path";
        throw err;
      }
      if (isManagedWrappersPath(path) && !isManagedWrapperPathForWeapon(path, id)) {
        const err = new Error(
          `Managed wrapper path must be under ${MANAGED_WRAPPERS_ROOT}/${id}/.`,
        );
        err.code = "wrapper_path_invalid";
        throw err;
      }
      runtimeModelPrefabPath = path;
    }
  }

  let wrapperAnchorMeta = existing?.wrapperAnchorMeta || null;
  if (Object.prototype.hasOwnProperty.call(body, "wrapperAnchorMeta")) {
    const raw = body.wrapperAnchorMeta;
    if (raw === null) {
      wrapperAnchorMeta = null;
    } else if (raw && typeof raw === "object") {
      const metaPath = normalizeWeaponAssetPath(raw.path || runtimeModelPrefabPath || null);
      if (metaPath && isManagedWrappersPath(metaPath) && !isManagedWrapperPathForWeapon(metaPath, id)) {
        const err = new Error(
          `wrapperAnchorMeta.path must be under ${MANAGED_WRAPPERS_ROOT}/${id}/.`,
        );
        err.code = "wrapper_path_invalid";
        throw err;
      }
      const recoveryReason = raw.recoveryReason ? String(raw.recoveryReason).slice(0, 64) : null;
      const needsConfirmation =
        raw.needsConfirmation === true ||
        recoveryReason === "missing_metadata" ||
        (raw.provisional === true && raw.confirmed !== true) ||
        (raw.confirmed !== true && Boolean(metaPath && isManagedWrappersPath(metaPath)));
      wrapperAnchorMeta = {
        path: metaPath || runtimeModelPrefabPath || null,
        provisional: raw.provisional === true || recoveryReason === "missing_metadata" || needsConfirmation,
        confirmed: raw.confirmed === true && !needsConfirmation,
        needsConfirmation,
        recoveryReason,
        sourcePrefabGuid: raw.sourcePrefabGuid || null,
        sourcePrefabPath: raw.sourcePrefabPath ? normalizeWeaponAssetPath(raw.sourcePrefabPath) : null,
        modelAssetId: raw.modelAssetId || modelAssetId || null,
        wrapperVersion: Number(raw.wrapperVersion) || 1,
        gripFromSource: raw.gripFromSource === true,
        muzzleFromSource: raw.muzzleFromSource === true,
        confirmedAt: raw.confirmedAt || null,
        weaponId: id,
      };
    }
  }

  // Model replacement: drop incompatible managed wrapper unless this upsert explicitly sets a new one.
  const modelChanged =
    isUpdate &&
    existing?.modelAssetId &&
    modelAssetId &&
    existing.modelAssetId !== modelAssetId &&
    !Object.prototype.hasOwnProperty.call(body, "wrapperAnchorMeta") &&
    !Object.prototype.hasOwnProperty.call(body, "runtimeModelPrefabPath");
  if (modelChanged && (wrapperAnchorMeta || runtimeModelPrefabPath)) {
    let newSourcePath = null;
    try {
      newSourcePath = resolveAuthoritativeWeaponSourcePrefab({
        id,
        modelAssetId,
      }).sourcePrefabPath;
    } catch {
      newSourcePath = null;
    }
    const oldSource = wrapperAnchorMeta?.sourcePrefabPath || null;
    if (
      isManagedWrappersPath(runtimeModelPrefabPath) ||
      (oldSource && newSourcePath && oldSource !== newSourcePath) ||
      (wrapperAnchorMeta?.modelAssetId && wrapperAnchorMeta.modelAssetId !== modelAssetId)
    ) {
      wrapperAnchorMeta = null;
      runtimeModelPrefabPath = null;
    }
  }

  const version = isUpdate ? (Number(existing.version) || 1) + 1 : 1;
  const entry = {
    id,
    displayName: String(body.displayName || existing?.displayName || "Pistol").slice(0, 80),
    enabled,
    role,
    modelAssetId,
    runtimeModelPrefabPath,
    wrapperAnchorMeta,
    frequencyFlipRequired,
    tuning,
    version,
    unitySync: existing?.unitySync
      ? {
          ...existing.unitySync,
          state:
            existing.unitySync.state === "applied" || existing.unitySync.state === "applying"
              ? "stale"
              : existing.unitySync.state || "disconnected",
          // Saving new anchors/model invalidates prior Unity readiness claims until re-sync.
          anchorsValid: false,
          runtimePlayable: false,
          definitionSynced: false,
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
          anchorsValid: false,
          runtimePlayable: false,
        },
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  entry.payloadHash = weaponPayloadHash(entry);
  store.weapons[id] = entry;
  saveStore(store);
  return publicWeapon(entry);
}

export function setWeaponLoadout(partial = {}) {
  const store = ensureWeaponStore(loadStore());
  const loadout = { ...DEFAULT_LOADOUT, ...(store.weaponLoadout || {}) };
  if (Object.prototype.hasOwnProperty.call(partial, "frequencyFlipRequired")) {
    loadout.frequencyFlipRequired = partial.frequencyFlipRequired !== false;
  }
  if (Object.prototype.hasOwnProperty.call(partial, "leftWeaponId")) {
    const id = partial.leftWeaponId;
    if (id && !store.weapons[id]) {
      const err = new Error("leftWeaponId not found.");
      err.code = "unknown_id";
      throw err;
    }
    if (id && store.weapons[id].role !== "left_pistol") {
      const err = new Error("leftWeaponId must reference a left_pistol role entry.");
      err.code = "invalid_role";
      throw err;
    }
    loadout.leftWeaponId = id || null;
  }
  if (Object.prototype.hasOwnProperty.call(partial, "rightWeaponId")) {
    const id = partial.rightWeaponId;
    if (id && !store.weapons[id]) {
      const err = new Error("rightWeaponId not found.");
      err.code = "unknown_id";
      throw err;
    }
    if (id && store.weapons[id].role !== "right_pistol") {
      const err = new Error("rightWeaponId must reference a right_pistol role entry.");
      err.code = "invalid_role";
      throw err;
    }
    loadout.rightWeaponId = id || null;
  }
  store.weaponLoadout = loadout;
  saveStore(store);
  return loadout;
}

export function collectWeaponDependencies(id) {
  const store = ensureWeaponStore(loadStore());
  const entry = store.weapons?.[id];
  if (!entry) return { exists: false, dependencies: [], actions: {}, nextAction: null };
  const dependencies = [];
  const loadout = { ...DEFAULT_LOADOUT, ...(store.weaponLoadout || {}) };
  if (loadout.leftWeaponId === id) {
    dependencies.push({ kind: "loadout_left", detail: "Assigned as active left pistol loadout." });
  }
  if (loadout.rightWeaponId === id) {
    dependencies.push({ kind: "loadout_right", detail: "Assigned as active right pistol loadout." });
  }
  const mapping = store.weaponMappings?.[id];
  if (mapping?.assetGuid || mapping?.assetPath) {
    dependencies.push({
      kind: "unity_mapping",
      detail: "Unity definition mapping exists.",
      assetGuid: mapping.assetGuid || null,
      assetPath: mapping.assetPath || null,
    });
  }
  const jobs = activeJobsForWeapon(store, id);
  for (const j of jobs) {
    dependencies.push({
      kind: "sync_job",
      detail: `${j.type || "job"} ${j.status}`,
      requestId: j.requestId,
      jobId: j.id,
      type: j.type || null,
      status: j.status,
      cancellable: CANCELLABLE_JOB_STATUSES.has(j.status),
    });
  }
  if (entry.unitySync?.state === "applying" || entry.unitySync?.state === "queued") {
    dependencies.push({
      kind: "unity_sync_state",
      detail: `unitySync.state=${entry.unitySync.state}`,
      state: entry.unitySync.state,
    });
  }

  const hasApplying =
    jobs.some((j) => j.status === "applying") || entry.unitySync?.state === "applying";
  const hasCancellable = jobs.some((j) => CANCELLABLE_JOB_STATUSES.has(j.status));
  const hasMapping = Boolean(mapping?.assetGuid || mapping?.assetPath);
  const pendingAutoRemove = jobs.some(
    (j) =>
      j.type === "delete_weapon_definition" &&
      j.autoRemoveCatalog &&
      (CANCELLABLE_JOB_STATUSES.has(j.status) || j.status === "applying"),
  );
  const queuedUndelivered =
    !hasApplying &&
    !hasMapping &&
    (hasCancellable || entry.unitySync?.state === "queued");

  const actions = {
    unassignLoadoutLeft: loadout.leftWeaponId === id,
    unassignLoadoutRight: loadout.rightWeaponId === id,
    cancelQueuedSyncAndRemove: queuedUndelivered,
    refreshStatus: hasApplying || pendingAutoRemove,
    deleteUnityAndRemove: hasMapping && !hasApplying,
    retainUnityAndRemove: hasMapping && !hasApplying,
    removeNow: dependencies.length === 0,
  };

  let nextAction = null;
  if (hasApplying) {
    nextAction =
      "Unity is applying or delivery is uncertain. Use Refresh status after the bridge reconnects — do not cancel.";
  } else if (queuedUndelivered) {
    nextAction = "Cancel queued sync and remove (Unity offline is OK — the job was never delivered).";
  } else if (loadout.leftWeaponId === id || loadout.rightWeaponId === id) {
    nextAction = "Unassign and remove matching loadout side(s), then continue.";
  } else if (hasMapping) {
    nextAction =
      "Delete Unity definition and remove (waits for Unity ack), or Keep Unity definition and remove catalog entry.";
  } else if (dependencies.length === 0) {
    nextAction = "No blockers — confirm Remove to delete the catalog entry only.";
  } else {
    nextAction = "Refresh status, then choose a compatible action for the remaining blockers.";
  }

  return {
    exists: true,
    dependencies,
    actions,
    nextAction,
    preserves: {
      assetLibraryModel: true,
      unrelatedSounds: true,
      sceneObjectsUnlessRequested: true,
    },
    removes: {
      weaponCatalogEntry: true,
      loadoutRefsIfRequested: true,
      pendingUndeliveredJobsIfCancelled: true,
      unityDefinitionOnlyIfDeleteChosen: true,
    },
    weapon: publicWeapon(entry),
    modelAssetId: entry.modelAssetId || null,
  };
}

/**
 * Remove a catalog weapon. Unity mappings are real dependencies:
 * - unityResolution "retain_unity": drop catalog entry, keep durable managed-retained mapping
 * - unityResolution "unity_deleted": mapping already cleared by Unity-acked delete job
 * - otherwise unity_mapping blocks (no silent force bypass)
 * - unassignSides: ["left"|"right"] — only clear those loadout sides (default both when unassignLoadout)
 */
export function deleteWeapon(
  id,
  {
    unassignLoadout = false,
    unassignSides = null,
    unityResolution = null,
    cancelQueuedJobs = false,
  } = {},
) {
  const store = ensureWeaponStore(loadStore());
  if (!store.weapons?.[id]) {
    return {
      ok: true,
      deleted: false,
      idempotent: true,
      dependencies: [],
      note: "Weapon already absent. Linked Asset Library model was not touched.",
    };
  }

  const modelAssetId = store.weapons[id].modelAssetId || null;

  if (cancelQueuedJobs) {
    const applying = activeJobsForWeapon(store, id).filter((j) => j.status === "applying");
    if (applying.length) {
      const err = new Error(
        "Cannot cancel: a Unity job is applying or delivery is uncertain. Refresh status after Unity reconnects.",
      );
      err.code = "unsafe_cancel";
      err.dependencies = collectWeaponDependencies(id).dependencies;
      throw err;
    }
    let cancelled = 0;
    for (const j of store.weaponJobs) {
      if (j.weaponId === id && CANCELLABLE_JOB_STATUSES.has(j.status)) {
        j.status = "cancelled";
        j.cancelledAt = new Date().toISOString();
        j.error = "Cancelled before Unity delivery during catalog removal.";
        cancelled += 1;
      }
    }
    const entry = store.weapons[id];
    if (entry && (entry.unitySync?.state === "queued" || cancelled > 0)) {
      entry.unitySync = {
        ...(entry.unitySync || {}),
        state: entry.unitySync?.assetGuid ? "applied" : "disconnected",
        lastError: cancelled ? "Queued sync cancelled before delivery." : entry.unitySync?.lastError || null,
      };
      if (!entry.unitySync.assetGuid) {
        entry.unitySync.state = "disconnected";
      }
    }
    saveStore(store);
  }

  if (unassignLoadout || (Array.isArray(unassignSides) && unassignSides.length)) {
    const sides =
      Array.isArray(unassignSides) && unassignSides.length
        ? unassignSides
        : ["left", "right"];
    const loadout = { ...DEFAULT_LOADOUT, ...(store.weaponLoadout || {}) };
    if (sides.includes("left") && loadout.leftWeaponId === id) loadout.leftWeaponId = null;
    if (sides.includes("right") && loadout.rightWeaponId === id) loadout.rightWeaponId = null;
    store.weaponLoadout = loadout;
    saveStore(store);
  }

  // Reload after mutations.
  const fresh = ensureWeaponStore(loadStore());
  const mapping = fresh.weaponMappings?.[id];
  const hasMapping = Boolean(mapping?.assetGuid || mapping?.assetPath);

  if (hasMapping && unityResolution === "retain_unity") {
    fresh.weaponMappingsRetained[id] = {
      ...mapping,
      weaponId: id,
      retainedAt: new Date().toISOString(),
      state: "managed_retained",
      note: "Catalog entry removed; Unity definition retained for later reconcile.",
    };
    delete fresh.weaponMappings[id];
    saveStore(fresh);
  } else if (unityResolution === "unity_deleted" && hasMapping) {
    const err = new Error(
      "Unity definition still mapped; wait for delete acknowledgement or choose retain_unity.",
    );
    err.code = "dependency_blocked";
    err.dependencies = [
      {
        kind: "unity_mapping",
        detail: "Unity definition mapping still present after unity_deleted request.",
        assetGuid: mapping.assetGuid || null,
        assetPath: mapping.assetPath || null,
      },
    ];
    err.nextAction =
      "Refresh status until Unity acknowledges definition delete, or use Keep Unity definition and remove catalog entry.";
    throw err;
  }

  const collected = collectWeaponDependencies(id);
  const hardBlock = collected.dependencies.filter((d) =>
    ["loadout_left", "loadout_right", "sync_job", "unity_sync_state", "unity_mapping"].includes(
      d.kind,
    ),
  );

  if (hardBlock.length) {
    const err = new Error(collected.nextAction || "Weapon has dependencies; use a compatible Remove action.");
    err.code = "dependency_blocked";
    err.dependencies = hardBlock;
    err.actions = collected.actions;
    err.nextAction = collected.nextAction;
    err.resolutions = [
      "unassign_and_remove",
      "cancel_queued_and_remove",
      "delete_unity_and_remove",
      "retain_unity_and_remove",
    ];
    throw err;
  }

  const store2 = ensureWeaponStore(loadStore());
  delete store2.weapons[id];
  delete store2.weaponRemovalLocks[id];
  saveStore(store2);

  const modelStillThere = modelAssetId ? Boolean(getAsset(modelAssetId)) : null;
  return {
    ok: true,
    deleted: true,
    idempotent: false,
    unityResolution: unityResolution || null,
    modelAssetId,
    modelPreserved: modelAssetId ? modelStillThere !== false : true,
    note: "Catalog entry removed. Linked Asset Library model, unrelated sounds, and scene objects were not deleted.",
  };
}

/**
 * Guided removal workflow with idempotent requestId and overlapping-lock protection.
 * actions: preview | refresh | remove_now | unassign_and_remove |
 *          cancel_queued_and_remove | delete_unity_and_remove | retain_unity_and_remove
 */
export function guidedRemoveWeapon(
  id,
  { action = "preview", requestId = null, sides = null } = {},
) {
  const store = ensureWeaponStore(loadStore());
  // Identity uses requested sides only — omitted stays omitted even after the weapon is gone.
  const { sidesMode, requestedSides } = canonicalizeRequestedSides(sides);
  const identity = { weaponId: id, action, sidesMode, requestedSides };

  if (action !== "preview" && action !== "refresh") {
    const rid = requireRemovalRequestId(requestId);
    const prior = lookupRemovalRequest(store, rid, identity);
    if (prior) return prior;
  } else if (requestId) {
    // Optional requestId on preview/refresh: validate identity if remembered, else ignore.
    if (typeof requestId === "string" && requestId.trim() && store.weaponRemovalRequests?.[requestId]) {
      const remembered = store.weaponRemovalRequests[requestId];
      const prior = lookupRemovalRequest(store, requireRemovalRequestId(requestId), {
        weaponId: id,
        action: remembered.action || action,
        sidesMode: remembered.sidesMode || "omitted",
        requestedSides: remembered.requestedSides || [],
      });
      if (prior && (prior.status === "completed" || prior.deleted || prior.status === "failed" || prior.status === "conflict")) {
        return prior;
      }
    }
  }

  if (action === "preview" || action === "refresh") {
    const deps = collectWeaponDependencies(id);
    if (!deps.exists) {
      return {
        ok: true,
        deleted: false,
        idempotent: true,
        action,
        dependencies: [],
        actions: {},
        nextAction: "Weapon already removed.",
        note: "Catalog entry already absent.",
      };
    }
    // If a prior delete_unity_and_remove finished in Unity, finish catalog removal.
    const pending = (store.weaponJobs || []).find(
      (j) =>
        j.weaponId === id &&
        j.type === "delete_weapon_definition" &&
        j.autoRemoveCatalog &&
        j.status === "applied",
    );
    const mappingGone = !store.weaponMappings?.[id]?.assetGuid && !store.weaponMappings?.[id]?.assetPath;
    if (pending && mappingGone && store.weapons?.[id]) {
      const finished = deleteWeapon(id, { unityResolution: "unity_deleted" });
      const result = {
        ok: true,
        action: "refresh",
        status: "completed",
        ...finished,
        nextAction: null,
      };
      if (requestId) {
        rememberRemovalResult(store, requireRemovalRequestId(requestId), result, {
          weaponId: id,
          action: "delete_unity_and_remove",
          sidesMode: "omitted",
          requestedSides: [],
          effectiveSides: [],
        });
      }
      return result;
    }
    return {
      ok: true,
      action,
      status: deps.actions.refreshStatus ? "waiting_unity" : deps.dependencies.length ? "blocked" : "ready",
      ...deps,
    };
  }

  const rid = requireRemovalRequestId(requestId);
  assertNoOverlappingRemoval(store, id, rid);
  if (!store.weapons?.[id]) {
    const result = {
      ok: true,
      deleted: false,
      idempotent: true,
      action,
      status: "completed",
      note: "Weapon already absent. Linked Asset Library model was not touched.",
    };
    return rememberRemovalResult(store, rid, result, identity);
  }

  store.weaponRemovalLocks[id] = {
    requestId: rid,
    action,
    status: "in_flight",
    startedAt: new Date().toISOString(),
  };
  saveStore(store);

  try {
    if (action === "remove_now") {
      const deps = collectWeaponDependencies(id);
      if (deps.dependencies.length) {
        const err = new Error(deps.nextAction || "Dependencies still block removal.");
        err.code = "dependency_blocked";
        err.dependencies = deps.dependencies;
        err.actions = deps.actions;
        err.nextAction = deps.nextAction;
        throw err;
      }
      const removed = deleteWeapon(id);
      const result = { ok: true, action, status: "completed", ...removed };
      releaseRemovalLock(ensureWeaponStore(loadStore()), id, rid);
      return rememberRemovalResult(ensureWeaponStore(loadStore()), rid, result, identity);
    }

    if (action === "unassign_and_remove") {
      const deps = collectWeaponDependencies(id);
      // Infer effective sides only for mutation — never for request identity.
      let effectiveSides = requestedSides;
      if (sidesMode === "omitted") {
        const inferred = [];
        if (deps.actions.unassignLoadoutLeft) inferred.push("left");
        if (deps.actions.unassignLoadoutRight) inferred.push("right");
        effectiveSides = normalizeRemovalSides(inferred);
      }
      if (!effectiveSides.length) {
        const err = new Error("This weapon is not assigned to a loadout side.");
        err.code = "dependency_blocked";
        err.dependencies = deps.dependencies;
        err.actions = deps.actions;
        err.nextAction = deps.nextAction;
        throw err;
      }
      {
        const s = ensureWeaponStore(loadStore());
        const loadout = { ...DEFAULT_LOADOUT, ...(s.weaponLoadout || {}) };
        if (effectiveSides.includes("left") && loadout.leftWeaponId === id) loadout.leftWeaponId = null;
        if (effectiveSides.includes("right") && loadout.rightWeaponId === id) loadout.rightWeaponId = null;
        s.weaponLoadout = loadout;
        saveStore(s);
      }
      const after = collectWeaponDependencies(id);
      if (after.dependencies.length) {
        const result = {
          ok: true,
          action,
          status: "blocked",
          deleted: false,
          sides: effectiveSides,
          effectiveSides,
          sidesMode,
          requestedSides,
          note: "Matching loadout reference(s) cleared. Other blockers remain — choose the next compatible action.",
          ...after,
        };
        releaseRemovalLock(ensureWeaponStore(loadStore()), id, rid);
        // Do not remember as terminal — allow further actions with new requestIds.
        return result;
      }
      const removed = deleteWeapon(id);
      const result = {
        ok: true,
        action,
        status: "completed",
        sides: effectiveSides,
        effectiveSides,
        ...removed,
      };
      releaseRemovalLock(ensureWeaponStore(loadStore()), id, rid);
      return rememberRemovalResult(ensureWeaponStore(loadStore()), rid, result, {
        ...identity,
        effectiveSides,
      });
    }

    if (action === "cancel_queued_and_remove") {
      const deps = collectWeaponDependencies(id);
      if (!deps.actions.cancelQueuedSyncAndRemove) {
        const err = new Error(
          deps.nextAction ||
            "Cannot cancel: Unity acknowledgement or reconciliation is required. Use Refresh status.",
        );
        err.code = "unsafe_cancel";
        err.dependencies = deps.dependencies;
        err.actions = deps.actions;
        err.nextAction = deps.nextAction;
        throw err;
      }
      // Also unassign loadout sides if present so cancel+remove can finish in one step when only those + queued sync block.
      const sidesToClear = [];
      if (deps.actions.unassignLoadoutLeft) sidesToClear.push("left");
      if (deps.actions.unassignLoadoutRight) sidesToClear.push("right");
      const removed = deleteWeapon(id, {
        cancelQueuedJobs: true,
        unassignLoadout: sidesToClear.length > 0,
        unassignSides: sidesToClear,
      });
      const result = { ok: true, action, status: "completed", ...removed };
      releaseRemovalLock(ensureWeaponStore(loadStore()), id, rid);
      return rememberRemovalResult(ensureWeaponStore(loadStore()), rid, result, identity);
    }

    if (action === "retain_unity_and_remove") {
      const deps = collectWeaponDependencies(id);
      if (!deps.actions.retainUnityAndRemove) {
        const err = new Error(
          deps.nextAction || "Keep Unity definition is only available when a real Unity mapping exists.",
        );
        err.code = "dependency_blocked";
        err.dependencies = deps.dependencies;
        err.actions = deps.actions;
        err.nextAction = deps.nextAction;
        throw err;
      }
      const sidesToClear = [];
      if (deps.actions.unassignLoadoutLeft) sidesToClear.push("left");
      if (deps.actions.unassignLoadoutRight) sidesToClear.push("right");
      // Cancel undelivered jobs only; refuse if applying.
      const removed = deleteWeapon(id, {
        cancelQueuedJobs: true,
        unassignLoadout: sidesToClear.length > 0,
        unassignSides: sidesToClear,
        unityResolution: "retain_unity",
      });
      const result = { ok: true, action, status: "completed", ...removed };
      releaseRemovalLock(ensureWeaponStore(loadStore()), id, rid);
      return rememberRemovalResult(ensureWeaponStore(loadStore()), rid, result, identity);
    }

    if (action === "delete_unity_and_remove") {
      const deps = collectWeaponDependencies(id);
      if (!deps.actions.deleteUnityAndRemove) {
        const err = new Error(
          deps.nextAction || "Delete Unity definition requires an applied mapping and no applying job.",
        );
        err.code = "dependency_blocked";
        err.dependencies = deps.dependencies;
        err.actions = deps.actions;
        err.nextAction = deps.nextAction;
        throw err;
      }
      const sidesToClear = [];
      if (deps.actions.unassignLoadoutLeft) sidesToClear.push("left");
      if (deps.actions.unassignLoadoutRight) sidesToClear.push("right");
      if (sidesToClear.length) {
        const s = ensureWeaponStore(loadStore());
        const loadout = { ...DEFAULT_LOADOUT, ...(s.weaponLoadout || {}) };
        if (sidesToClear.includes("left") && loadout.leftWeaponId === id) loadout.leftWeaponId = null;
        if (sidesToClear.includes("right") && loadout.rightWeaponId === id) loadout.rightWeaponId = null;
        s.weaponLoadout = loadout;
        saveStore(s);
      }

      const enq = enqueueWeaponUnityDelete(id, rid, { autoRemoveCatalog: true });
      const afterDeps = collectWeaponDependencies(id);
      const modelAssetId = store.weapons?.[id]?.modelAssetId || null;
      const result = {
        ok: true,
        action,
        status: "queued",
        deduplicated: enq.deduplicated,
        job: enq.job,
        nextAction:
          "Waiting for Unity to acknowledge definition delete; catalog removal finishes automatically after ack. Use Refresh status.",
        note: "Unity definition delete queued. Catalog entry remains until Unity acknowledges. Model asset preserved.",
        weapon: getWeapon(id),
        modelAssetId,
        modelPreserved: modelAssetId ? Boolean(getAsset(modelAssetId)) : true,
        dependencies: afterDeps.dependencies,
        actions: afterDeps.actions,
      };
      const s2 = ensureWeaponStore(loadStore());
      s2.weaponRemovalLocks[id] = {
        requestId: rid,
        action,
        status: "waiting_unity",
        startedAt: s2.weaponRemovalLocks[id]?.startedAt || new Date().toISOString(),
      };
      saveStore(s2);
      return rememberRemovalResult(s2, rid, result, identity);
    }

    const err = new Error(`Unknown guided removal action: ${action}`);
    err.code = "invalid_request";
    throw err;
  } catch (err) {
    const s = ensureWeaponStore(loadStore());
    releaseRemovalLock(s, id, rid);
    saveStore(s);
    throw err;
  }
}

/** Enqueue Unity-acknowledged deletion of the managed definition asset. */
export function enqueueWeaponUnityDelete(weaponId, requestId, { autoRemoveCatalog = false } = {}) {
  if (!requestId || typeof requestId !== "string") {
    const err = new Error("requestId required.");
    err.code = "invalid_request";
    throw err;
  }
  const store = ensureWeaponStore(loadStore());
  const entry = store.weapons?.[weaponId];
  if (!entry) {
    const err = new Error("Weapon not found.");
    err.code = "unknown_id";
    throw err;
  }
  const mapping = store.weaponMappings?.[weaponId];
  if (!mapping?.assetGuid && !mapping?.assetPath) {
    const err = new Error("No Unity mapping to delete.");
    err.code = "no_unity_mapping";
    throw err;
  }
  const existing = store.weaponJobs.find((j) => j.requestId === requestId);
  if (existing) {
    if (autoRemoveCatalog && !existing.autoRemoveCatalog) {
      existing.autoRemoveCatalog = true;
      saveStore(store);
    }
    return { deduplicated: true, job: existing, status: 200 };
  }
  const job = {
    id: randomUUID(),
    requestId,
    type: "delete_weapon_definition",
    weaponId,
    payloadHash: `delete:${mapping.assetGuid || ""}:${mapping.assetPath || ""}`,
    weaponVersion: Number(entry.version) || 1,
    payload: {
      weaponId,
      expectedAssetGuid: mapping.assetGuid || null,
      assetPath: mapping.assetPath || deterministicAssetPath(weaponId),
    },
    status: "pending_unity",
    autoRemoveCatalog: Boolean(autoRemoveCatalog),
    createdAt: new Date().toISOString(),
    attempts: 0,
  };
  store.weaponJobs.push(job);
  entry.unitySync = {
    ...(entry.unitySync || {}),
    state: "queued",
    lastError: null,
    lastRequestId: requestId,
  };
  saveStore(store);
  return { deduplicated: false, job, status: 202 };
}

function deterministicAssetPath(weaponId) {
  return `${WEAPON_ASSET_DIR}/${weaponId}.asset`;
}

export function buildUnitySyncPayload(weaponId) {
  const store = ensureWeaponStore(loadStore());
  const entry = store.weapons?.[weaponId];
  if (!entry) {
    const err = new Error("Weapon not found.");
    err.code = "unknown_id";
    throw err;
  }
  if (entry.modelAssetId) {
    validateModelAssetId(entry.modelAssetId, { requireReady: true });
  }
  const asset = entry.modelAssetId ? getAsset(entry.modelAssetId) : null;
  const mapping = store.weaponMappings?.[weaponId] || {};
  const payloadHash = weaponPayloadHash(entry);
  const importedPath = asset?.unity?.prefabPath || asset?.unity?.importedPath || null;
  const modelPrefabPath = entry.runtimeModelPrefabPath || importedPath;
  return {
    weaponId: entry.id,
    displayName: entry.displayName,
    role: entry.role,
    enabled: entry.enabled !== false,
    frequencyFlipRequired: entry.frequencyFlipRequired !== false,
    version: Number(entry.version) || 1,
    payloadHash,
    tuning: { ...entry.tuning },
    modelAssetId: entry.modelAssetId || null,
    modelPrefabPath,
    importedModelPrefabPath: importedPath,
    runtimeModelPrefabPath: entry.runtimeModelPrefabPath || null,
    expectedAssetGuid: mapping.assetGuid || entry.unitySync?.assetGuid || null,
    expectedAssetPath: mapping.assetPath || entry.unitySync?.assetPath || deterministicAssetPath(entry.id),
    assetPath: deterministicAssetPath(entry.id),
  };
}

export function enqueueWeaponSync(weaponId, requestId, { expectedVersion = undefined } = {}) {
  if (!requestId || typeof requestId !== "string") {
    const err = new Error("requestId required.");
    err.code = "invalid_request";
    throw err;
  }
  const store = ensureWeaponStore(loadStore());
  const entry = store.weapons?.[weaponId];
  if (!entry) {
    const err = new Error("Weapon not found.");
    err.code = "unknown_id";
    throw err;
  }
  if (expectedVersion != null && Number(expectedVersion) !== (Number(entry.version) || 1)) {
    const err = new Error(`Stale weapon version: expected ${expectedVersion}, have ${entry.version}.`);
    err.code = "stale_version";
    throw err;
  }
  assertManagedWrapperReadyForEnqueue(entry);

  const payload = buildUnitySyncPayload(weaponId);
  const existing = store.weaponJobs.find((j) => j.requestId === requestId);
  if (existing) {
    if (existing.weaponId !== weaponId || existing.payloadHash !== payload.payloadHash) {
      const err = new Error("requestId reused with a different weapon sync payload.");
      err.code = "payload_conflict";
      throw err;
    }
    return { deduplicated: true, job: existing, status: 200 };
  }

  const job = {
    id: randomUUID(),
    requestId,
    type: "sync_weapon_definition",
    weaponId,
    payloadHash: payload.payloadHash,
    weaponVersion: payload.version,
    payload,
    status: "pending_unity",
    createdAt: new Date().toISOString(),
    attempts: 0,
  };
  store.weaponJobs.push(job);
  entry.unitySync = {
    ...(entry.unitySync || {}),
    state: "queued",
    lastError: null,
    lastRequestId: requestId,
    payloadHash: payload.payloadHash,
  };
  entry.updatedAt = new Date().toISOString();
  saveStore(store);
  return { deduplicated: false, job, status: 202 };
}

/**
 * Queue managed weapon runtime deploy/bind into one explicit scene.
 * Does not place a raw library mesh — binds the synced HertzWeaponDefinition into DualPistolRuntime.
 */
export function enqueueWeaponDeploy(
  weaponId,
  requestId,
  {
    scenePath,
    sceneGuid,
    expectedUnityRevision = null,
    confirmSave = true,
    expectedVersion = undefined,
  } = {},
) {
  if (!requestId || typeof requestId !== "string" || !requestId.trim() || requestId !== requestId.trim()) {
    const err = new Error("requestId must be a non-empty string without leading/trailing whitespace.");
    err.code = "invalid_request";
    throw err;
  }
  if (!scenePath || typeof scenePath !== "string" || !scenePath.startsWith("Assets/")) {
    const err = new Error("scenePath must be an Assets/ scene path.");
    err.code = "invalid_request";
    throw err;
  }
  if (!/^[0-9a-f]{32}$/i.test(String(sceneGuid || ""))) {
    const err = new Error("sceneGuid must be the 32-character Unity GUID for scenePath.");
    err.code = "invalid_request";
    throw err;
  }
  sceneGuid = String(sceneGuid).toLowerCase();
  const store = ensureWeaponStore(loadStore());
  const entry = store.weapons?.[weaponId];
  if (!entry) {
    const err = new Error("Weapon not found.");
    err.code = "unknown_id";
    throw err;
  }
  if (expectedVersion != null && Number(expectedVersion) !== (Number(entry.version) || 1)) {
    const err = new Error(`Stale weapon version: expected ${expectedVersion}, have ${entry.version}.`);
    err.code = "stale_version";
    throw err;
  }
  assertManagedWrapperReadyForEnqueue(entry);
  const mapping = store.weaponMappings?.[weaponId];
  if (!mapping?.assetGuid && !mapping?.assetPath && entry.unitySync?.state !== "applied") {
    const err = new Error(
      "Weapon definition is not synced to Unity yet. Sync to Unity first, then Test/Deploy the managed definition.",
    );
    err.code = "not_synced";
    throw err;
  }
  if (entry.modelAssetId) {
    validateModelAssetId(entry.modelAssetId, { requireReady: true });
  }

  const payloadHash = createHash("sha256")
    .update(
      JSON.stringify({
        weaponId,
        scenePath,
        sceneGuid,
        expectedUnityRevision,
        confirmSave: confirmSave !== false,
        version: Number(entry.version) || 1,
        role: entry.role,
        payloadHash: weaponPayloadHash(entry),
        assetGuid: mapping?.assetGuid || entry.unitySync?.assetGuid || null,
        assetPath: mapping?.assetPath || entry.unitySync?.assetPath || deterministicAssetPath(weaponId),
      }),
      "utf8",
    )
    .digest("hex");

  const existing = store.weaponJobs.find((j) => j.requestId === requestId);
  if (existing) {
    if (
      existing.weaponId !== weaponId ||
      existing.type !== "deploy_weapon_runtime" ||
      existing.payloadHash !== payloadHash
    ) {
      const err = new Error("requestId reused with a different weapon deploy payload.");
      err.code = "payload_conflict";
      throw err;
    }
    return { deduplicated: true, job: existing, status: 200 };
  }

  const payload = {
    weaponId,
    scenePath,
    sceneGuid,
    expectedUnityRevision,
    confirmSave: confirmSave !== false,
    role: entry.role,
    version: Number(entry.version) || 1,
    payloadHash: weaponPayloadHash(entry),
    assetGuid: mapping?.assetGuid || entry.unitySync?.assetGuid || null,
    assetPath: mapping?.assetPath || entry.unitySync?.assetPath || deterministicAssetPath(weaponId),
    displayName: entry.displayName,
    enabled: entry.enabled !== false,
    frequencyFlipRequired: entry.frequencyFlipRequired !== false,
    tuning: { ...entry.tuning },
    managedObjectId: entry.unityDeploy?.managedObjectId || `HertzStudioManagedWeapon_${weaponId}`,
  };

  const job = {
    id: randomUUID(),
    requestId,
    type: "deploy_weapon_runtime",
    weaponId,
    payloadHash,
    weaponVersion: payload.version,
    payload,
    status: "pending_unity",
    createdAt: new Date().toISOString(),
    attempts: 0,
  };
  store.weaponJobs.push(job);
  saveStore(store);
  return { deduplicated: false, job, status: 202 };
}

export function nextWeaponJob() {
  const store = ensureWeaponStore(loadStore());
  return (
    store.weaponJobs.find(
      (j) =>
        (j.status === "pending_unity" || j.status === "applying") &&
        j.status !== "cancelled",
    ) || null
  );
}

export function getWeaponJob(jobId) {
  const store = ensureWeaponStore(loadStore());
  return store.weaponJobs.find((j) => j.id === jobId) || null;
}

export function markWeaponJobApplying(jobId) {
  const store = ensureWeaponStore(loadStore());
  const job = store.weaponJobs.find((j) => j.id === jobId);
  if (!job) return;
  job.status = "applying";
  job.attempts += 1;
  job.startedAt = new Date().toISOString();
  const entry = store.weapons[job.weaponId];
  if (entry) {
    entry.unitySync = { ...(entry.unitySync || {}), state: "applying", lastError: null };
  }
  saveStore(store);
}

/**
 * Acknowledge a weapon sync. Connector must pass Unity-observed fields; inventing
 * success without Unity response is not allowed (caller responsibility).
 */
/** Fields that must be present (not omitted) on a successful sync/deploy ack. */
const SYNC_READINESS_REQUIRED = ["modelImported", "definitionSynced", "anchorsValid"];
const DEPLOY_READINESS_REQUIRED = [
  "modelImported",
  "definitionSynced",
  "anchorsValid",
  "runtimeDeployApplied",
];

function omittedKeys(required, bag) {
  return required.filter((k) => bag[k] === undefined || bag[k] === null);
}

function failWeaponAckKeepPrior(store, job, entry, message, { code = "incompatible_connector" } = {}) {
  job.status = "failed";
  job.error = message;
  job.errorCode = code;
  if (entry) {
    const mapping = store.weaponMappings?.[job.weaponId];
    // A re-sync attempt may have flipped state to queued/applying — still keep the last valid mapping.
    const hadPriorValidSync =
      Boolean(mapping?.assetGuid || mapping?.assetPath) ||
      (entry.unitySync?.state === "applied" && Boolean(entry.unitySync?.assetGuid));
    if (hadPriorValidSync) {
      entry.unitySync = {
        ...entry.unitySync,
        state: "applied",
        assetGuid: mapping?.assetGuid || entry.unitySync?.assetGuid || null,
        assetPath: mapping?.assetPath || entry.unitySync?.assetPath || null,
        lastError: message,
        lastRequestId: job.requestId,
        // Do not let an incomplete/stale ack invent or clear prior authoritative readiness.
        modelImported: entry.unitySync?.modelImported === true || mapping != null,
        definitionSynced: entry.unitySync?.definitionSynced === true || mapping != null,
        anchorsValid: entry.unitySync?.anchorsValid === true,
        runtimeDeployApplied: entry.unitySync?.runtimeDeployApplied === true,
        runtimePlayable: entry.unitySync?.runtimePlayable === true,
      };
    } else {
      entry.unitySync = {
        ...(entry.unitySync || {}),
        state: "failed",
        lastError: message,
        lastRequestId: job.requestId,
        modelImported: entry.unitySync?.modelImported === true,
        definitionSynced: false,
        anchorsValid: entry.unitySync?.anchorsValid === true,
        runtimeDeployApplied: entry.unitySync?.runtimeDeployApplied === true,
        runtimePlayable: false,
      };
    }
    entry.updatedAt = new Date().toISOString();
  }
  saveStore(store);
  return { deduplicated: false, job, weapon: entry ? publicWeapon(entry) : null, code };
}

export function acknowledgeWeaponSync({
  requestId,
  ok,
  error,
  conflict,
  assetGuid,
  assetPath,
  scenePath,
  sceneGuid,
  observedPayloadHash,
  observedVersion,
  unityRevision,
  modelImported,
  definitionSynced,
  anchorsValid,
  runtimeDeployApplied,
  runtimePlayable,
  missingAnchors,
  prefabPath,
}) {
  const store = ensureWeaponStore(loadStore());
  const job = store.weaponJobs.find((j) => j.requestId === requestId);
  if (!job) return null;
  if (["applied", "failed", "conflict"].includes(job.status)) {
    return { deduplicated: true, job, weapon: publicWeapon(store.weapons[job.weaponId]) };
  }

  const entry = store.weapons[job.weaponId];
  const readinessBag = {
    modelImported,
    definitionSynced,
    anchorsValid,
    runtimeDeployApplied,
    runtimePlayable,
  };

  if (ok) {
    if (job.type === "delete_weapon_definition") {
      job.status = "applied";
      job.appliedAt = new Date().toISOString();
      if (store.weaponMappings?.[job.weaponId]) delete store.weaponMappings[job.weaponId];
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
      let catalogRemoved = false;
      let weaponOut = entry ? publicWeapon(entry) : null;
      if (job.autoRemoveCatalog && store.weapons?.[job.weaponId]) {
        const modelAssetId = store.weapons[job.weaponId].modelAssetId || null;
        delete store.weapons[job.weaponId];
        delete store.weaponRemovalLocks[job.weaponId];
        catalogRemoved = true;
        weaponOut = null;
        if (job.requestId) {
          const prior = store.weaponRemovalRequests[job.requestId];
          const sidesMode = prior?.sidesMode || "omitted";
          const requestedSides = prior?.requestedSides || [];
          store.weaponRemovalRequests[job.requestId] = {
            ok: true,
            action: "delete_unity_and_remove",
            status: "completed",
            deleted: true,
            requestId: job.requestId,
            weaponId: job.weaponId,
            sidesMode,
            requestedSides,
            sides: [],
            effectiveSides: [],
            payloadHash: removalPayloadHash({
              weaponId: job.weaponId,
              action: "delete_unity_and_remove",
              sidesMode,
              requestedSides,
            }),
            modelAssetId,
            modelPreserved: modelAssetId ? Boolean(getAsset(modelAssetId)) : true,
            note: "Unity definition deleted and catalog entry removed automatically. Linked Asset Library model preserved.",
            nextAction: null,
            rememberedAt: new Date().toISOString(),
          };
        }
      } else if (job.autoRemoveCatalog && job.requestId) {
        // Mapping cleared but catalog already gone — still terminalise remembered result.
        writeTerminalAutoRemoveResult(store, job, {
          status: "completed",
          deleted: !store.weapons?.[job.weaponId],
          error: null,
        });
        // Override writeTerminal's failed-oriented fields for success-without-catalog case:
        const rec = store.weaponRemovalRequests[job.requestId];
        if (rec) {
          rec.ok = true;
          rec.status = "completed";
          rec.deleted = true;
          rec.error = null;
          rec.nextAction = null;
          rec.note =
            "Unity definition deleted. Catalog entry already absent. Linked Asset Library model preserved.";
        }
      }
      saveStore(store);
      return {
        deduplicated: false,
        job,
        weapon: weaponOut,
        catalogRemoved,
      };
    }

    if (job.type === "deploy_weapon_runtime") {
      const acknowledgedSceneGuid = String(sceneGuid || "").trim().toLowerCase();
      if (!assetGuid || !scenePath || !/^[0-9a-f]{32}$/.test(acknowledgedSceneGuid)) {
        return failWeaponAckKeepPrior(
          store,
          job,
          entry,
          "Unity deploy ack missing authoritative managedObjectId/scenePath/sceneGuid.",
          { code: "target_scene_ack_missing" },
        );
      }
      if (scenePath !== job.payload?.scenePath || acknowledgedSceneGuid !== job.payload?.sceneGuid) {
        return failWeaponAckKeepPrior(
          store,
          job,
          entry,
          "Unity deploy ack scene identity does not match the queued target scene.",
          { code: "target_scene_ack_mismatch" },
        );
      }
      const deployMissing = omittedKeys(DEPLOY_READINESS_REQUIRED, readinessBag);
      if (deployMissing.length) {
        return failWeaponAckKeepPrior(
          store,
          job,
          entry,
          `Incompatible/stale Unity connector response: deploy ack omitted ${deployMissing.join(", ")}. Require authoritative true readiness fields.`,
        );
      }
      if (
        modelImported !== true ||
        definitionSynced !== true ||
        anchorsValid !== true ||
        runtimeDeployApplied !== true
      ) {
        return failWeaponAckKeepPrior(
          store,
          job,
          entry,
          "Deploy acknowledgement rejected: modelImported, definitionSynced, anchorsValid, and runtimeDeployApplied must be explicitly true.",
        );
      }
      job.status = "applied";
      job.appliedAt = new Date().toISOString();
      job.managedObjectId = assetGuid || job.managedObjectId || null;
      job.scenePath = scenePath;
      job.sceneGuid = acknowledgedSceneGuid;
      if (entry) {
        entry.unityDeploy = {
          scenePath: job.scenePath,
          sceneGuid: acknowledgedSceneGuid,
          managedObjectId: job.managedObjectId,
          lastDeployedAt: job.appliedAt,
          lastRequestId: requestId,
          weaponVersion: job.weaponVersion,
          payloadHash: job.payloadHash,
        };
        entry.unitySync = {
          ...(entry.unitySync || {}),
          state: entry.unitySync?.state === "applied" ? "applied" : entry.unitySync?.state || "applied",
          modelImported: true,
          definitionSynced: true,
          anchorsValid: true,
          runtimeDeployApplied: true,
          // Playable only when Unity/connector sends explicit true — omitted stays false.
          runtimePlayable: runtimePlayable === true,
          missingAnchors: Array.isArray(missingAnchors) ? missingAnchors : [],
          prefabPath: prefabPath || entry.unitySync?.prefabPath || null,
        };
      }
      saveStore(store);
      return { deduplicated: false, job, weapon: entry ? publicWeapon(entry) : null };
    }

    if (job.type === "sync_weapon_definition") {
      const syncMissing = omittedKeys(SYNC_READINESS_REQUIRED, readinessBag);
      if (syncMissing.length) {
        return failWeaponAckKeepPrior(
          store,
          job,
          entry,
          `Incompatible/stale Unity connector response: sync ack omitted ${syncMissing.join(", ")}. Require authoritative true readiness fields.`,
        );
      }
      if (modelImported !== true || definitionSynced !== true || anchorsValid !== true) {
        return failWeaponAckKeepPrior(
          store,
          job,
          entry,
          "Sync acknowledgement rejected: modelImported, definitionSynced, and anchorsValid must be explicitly true.",
        );
      }
    }

    if (!assetGuid || !assetPath || !String(assetPath).startsWith("Assets/")) {
      job.status = "failed";
      job.error = "Unity ack missing authoritative assetGuid/assetPath.";
      if (entry) {
        entry.unitySync = {
          ...(entry.unitySync || {}),
          state: "failed",
          lastError: job.error,
        };
      }
      if (job.type === "delete_weapon_definition" && job.autoRemoveCatalog) {
        writeTerminalAutoRemoveResult(store, job, { status: "failed", error: job.error });
      }
      saveStore(store);
      return { deduplicated: false, job, weapon: entry ? publicWeapon(entry) : null };
    }
    if (observedPayloadHash && observedPayloadHash !== job.payloadHash) {
      job.status = "conflict";
      job.error = "Observed payload hash does not match queued sync payload.";
      if (entry) {
        entry.unitySync = {
          ...(entry.unitySync || {}),
          state: "conflict",
          lastError: job.error,
        };
      }
      if (job.type === "delete_weapon_definition" && job.autoRemoveCatalog) {
        writeTerminalAutoRemoveResult(store, job, { status: "conflict", error: job.error });
      }
      saveStore(store);
      return { deduplicated: false, job, weapon: entry ? publicWeapon(entry) : null };
    }
    if (
      observedVersion != null &&
      Number(observedVersion) !== Number(job.weaponVersion) &&
      Number(observedVersion) !== Number(entry?.version)
    ) {
      job.status = "conflict";
      job.error = "Observed version does not match queued weapon version.";
      if (entry) {
        entry.unitySync = {
          ...(entry.unitySync || {}),
          state: "conflict",
          lastError: job.error,
        };
      }
      if (job.type === "delete_weapon_definition" && job.autoRemoveCatalog) {
        writeTerminalAutoRemoveResult(store, job, { status: "conflict", error: job.error });
      }
      saveStore(store);
      return { deduplicated: false, job, weapon: entry ? publicWeapon(entry) : null };
    }
    job.status = "applied";
    job.appliedAt = new Date().toISOString();
    job.assetGuid = assetGuid;
    job.assetPath = assetPath;
    store.weaponMappings[job.weaponId] = {
      weaponId: job.weaponId,
      assetGuid,
      assetPath,
      updatedAt: new Date().toISOString(),
      unityRevision: Number.isFinite(unityRevision) ? unityRevision : null,
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
        observedPayloadHash: job.payloadHash,
        observedVersion: observedVersion ?? entry.version,
        modelImported: true,
        definitionSynced: true,
        anchorsValid: true,
        // Sync never claims deploy/playable — those stages stay false until deploy proof.
        runtimeDeployApplied: false,
        runtimePlayable: false,
        missingAnchors: Array.isArray(missingAnchors) ? missingAnchors : [],
        prefabPath: prefabPath || null,
      };
    }
  } else if (conflict) {
    job.status = "conflict";
    job.error = error || "Weapon sync conflict.";
    if (entry) {
      entry.unitySync = {
        ...(entry.unitySync || {}),
        state: "conflict",
        lastError: job.error,
        lastRequestId: requestId,
        anchorsValid: anchorsValid === true,
        runtimePlayable: false,
        missingAnchors: Array.isArray(missingAnchors) ? missingAnchors : entry.unitySync?.missingAnchors || [],
      };
    }
    if (job.type === "delete_weapon_definition" && job.autoRemoveCatalog) {
      writeTerminalAutoRemoveResult(store, job, { status: "conflict", error: job.error });
    }
  } else {
    job.status = "failed";
    job.error = error || "Weapon sync failed.";
    if (entry) {
      entry.unitySync = {
        ...(entry.unitySync || {}),
        state: "failed",
        lastError: job.error,
        lastRequestId: requestId,
        modelImported: modelImported === true,
        definitionSynced: false,
        anchorsValid: anchorsValid === true,
        runtimeDeployApplied: false,
        runtimePlayable: false,
        missingAnchors: Array.isArray(missingAnchors) ? missingAnchors : [],
        prefabPath: prefabPath || entry.unitySync?.prefabPath || null,
      };
    }
    if (job.type === "delete_weapon_definition" && job.autoRemoveCatalog) {
      writeTerminalAutoRemoveResult(store, job, { status: "failed", error: job.error });
    }
  }
  saveStore(store);
  return { deduplicated: false, job, weapon: entry ? publicWeapon(entry) : null };
}

/** Restart recovery: re-queue applying jobs that never finished. */
export function recoverWeaponJobsOnBoot() {
  const store = ensureWeaponStore(loadStore());
  let changed = 0;
  for (const j of store.weaponJobs) {
    if (j.status === "applying") {
      j.status = "pending_unity";
      j.recoveredAt = new Date().toISOString();
      changed += 1;
      const entry = store.weapons[j.weaponId];
      if (entry) {
        entry.unitySync = { ...(entry.unitySync || {}), state: "queued", lastError: "Recovered after restart." };
      }
    }
  }
  if (changed) saveStore(store);
  return { recovered: changed };
}

export { DEFAULT_LOADOUT, WEAPON_ASSET_DIR, SYNC_STATES };
