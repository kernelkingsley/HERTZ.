/**
 * Normalize Characters Asset Library model rows for UI actions.
 * Survives version skew when a stale API omits canAddToCatalog / canEnqueueImport /
 * canRetryImport / importInFlight but still reports Unity-imported readiness.
 */

const IMPORT_IN_FLIGHT_STATES = new Set(["importing_unity", "pending_unity"]);
const NO_ENQUEUE_STATES = new Set([
  "unsupported",
  "importing_unity",
  "pending_unity",
  "uploading",
  "processing",
]);

/**
 * @param {object|null|undefined} entry
 * @returns {boolean}
 */
export function isUnityImportedLibraryModel(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.assignable === true || entry.unityImported === true) return true;
  if (entry.assignable === false && entry.unityImported === false) return false;
  const state = String(entry.state || "");
  const readiness = entry.unityReadiness || entry.unity?.readiness || null;
  if (state === "unity_imported" || readiness === "ready") return true;
  const label = String(entry.stateLabel || "").toLowerCase();
  if (label.includes("unity imported")) return true;
  return false;
}

/**
 * @param {object|null|undefined} raw
 * @returns {object|null}
 */
export function normalizeCharacterLibraryModel(raw) {
  if (!raw || typeof raw !== "object") return null;
  const state = raw.state || "unknown";
  const unityImported = isUnityImportedLibraryModel(raw);
  const assignable = typeof raw.assignable === "boolean" ? raw.assignable : unityImported;
  const importInFlight =
    typeof raw.importInFlight === "boolean" ? raw.importInFlight : IMPORT_IN_FLIGHT_STATES.has(state);
  const canEnqueueImport =
    typeof raw.canEnqueueImport === "boolean"
      ? raw.canEnqueueImport
      : !unityImported && !NO_ENQUEUE_STATES.has(state);
  const canRetryImport =
    typeof raw.canRetryImport === "boolean" ? raw.canRetryImport : state === "failed" && canEnqueueImport;
  const canAddToCatalog =
    typeof raw.canAddToCatalog === "boolean" ? raw.canAddToCatalog : assignable || unityImported;

  let blockReason = raw.blockReason || null;
  if (!canAddToCatalog && !blockReason) {
    if (state === "unsupported") blockReason = "Unsupported for Unity import.";
    else if (state === "failed") blockReason = raw.lastError || "Unity import failed.";
    else if (importInFlight) blockReason = "Unity import in progress — wait for connector/Unity to finish.";
    else if (state === "preview_ready") {
      blockReason = "Preview ready in browser only — Import to Unity before assigning.";
    } else {
      blockReason = "Not Unity-imported yet — cannot assign to a character model.";
    }
  }

  return {
    ...raw,
    state,
    stateLabel: raw.stateLabel || state,
    assignable,
    unityImported,
    importInFlight,
    canEnqueueImport,
    canRetryImport,
    canAddToCatalog,
    blockReason,
    lastError: raw.lastError || raw.importError || raw.unity?.lastError || null,
  };
}

/**
 * @param {Array<object>} list
 * @returns {Array<object>}
 */
export function normalizeCharacterLibraryModels(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeCharacterLibraryModel).filter(Boolean);
}
