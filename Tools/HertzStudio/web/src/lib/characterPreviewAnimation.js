/**
 * Truthful character animation preview resolution (W05).
 * Never substitutes an unrelated embedded GLB clip for an assigned Unity animation.
 */

export const PREVIEW_SLOTS = Object.freeze(["idle", "attack", "locomotion"]);

const UNITY_ONLY_FORMATS = new Set([
  "anim",
  ".anim",
  "controller",
  ".controller",
  "overridecontroller",
  ".overridecontroller",
]);

/**
 * Stable identity for exact clip matching (basename, no extension, lowercased).
 */
export function normalizeAnimIdentity(value) {
  let s = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\\/g, "/");
  if (!s) return "";
  const slash = s.lastIndexOf("/");
  if (slash >= 0) s = s.slice(slash + 1);
  return s.replace(/\.(anim|fbx|glb|gltf|controller|overridecontroller)$/i, "");
}

export function isUnityOnlyAnimationAsset(assignment) {
  if (!assignment) return false;
  const fmt = String(assignment.fileFormat || "").trim().toLowerCase();
  if (UNITY_ONLY_FORMATS.has(fmt) || UNITY_ONLY_FORMATS.has(`.${fmt}`)) return true;
  const path = String(assignment.unityPath || "").toLowerCase();
  if (/\.(anim|controller|overridecontroller)$/.test(path)) return true;
  if (assignment.assetType === "animation" && !assignment.embeddedClipName) {
    // Library animation assets are Unity-side unless an explicit embedded clip name is known.
    return true;
  }
  return false;
}

/**
 * Exact identity match only — never substring, never clips[0].
 * @param {Array<{ name?: string }|string>} clips
 * @param {object|null} assignment
 * @returns {{ name: string }|null}
 */
export function findExactEmbeddedClip(clips, assignment) {
  if (!assignment || !Array.isArray(clips) || clips.length === 0) return null;
  const candidates = [
    assignment.embeddedClipName,
    assignment.displayName,
    assignment.unityPath,
    assignment.name,
  ]
    .map(normalizeAnimIdentity)
    .filter(Boolean);
  if (!candidates.length) return null;

  for (let i = 0; i < clips.length; i += 1) {
    const raw = clips[i];
    const clipName = typeof raw === "string" ? raw : raw?.name;
    const identity = normalizeAnimIdentity(clipName);
    if (!identity) continue;
    if (candidates.includes(identity)) {
      return typeof raw === "string" ? { name: raw } : raw;
    }
  }
  return null;
}

/**
 * @param {{
 *   slot?: string,
 *   assignment?: object|null,
 *   embeddedClipNames?: string[],
 *   unityCompatibility?: { status?: string, source?: string, reason?: string }|null
 * }} input
 */
export function resolvePreviewPlayback(input = {}) {
  const slot = PREVIEW_SLOTS.includes(input.slot) ? input.slot : "idle";
  const assignment = input.assignment || null;
  const embedded = Array.isArray(input.embeddedClipNames) ? input.embeddedClipNames : [];
  const unityCompat = input.unityCompatibility || null;

  const assignedLabel = assignment
    ? String(assignment.displayName || assignment.name || assignment.assetId || "Assigned asset")
    : "Unassigned";
  const assignedAssetId = assignment?.assetId || null;

  if (!assignment) {
    return {
      slot,
      assignedLabel: "Unassigned",
      assignedAssetId: null,
      playingClipName: null,
      browserPlayback: "unassigned",
      compatibilityStatus: "not_applicable",
      compatibilitySource: null,
      message: "No animation assigned to this slot.",
      canPlayInBrowser: false,
    };
  }

  const exact = findExactEmbeddedClip(
    embedded.map((n) => (typeof n === "string" ? { name: n } : n)),
    assignment,
  );

  if (exact) {
    const compat = resolveCompatibility(unityCompat, { hasExactEmbedded: true });
    return {
      slot,
      assignedLabel,
      assignedAssetId,
      playingClipName: exact.name || null,
      browserPlayback: "exact_embedded",
      compatibilityStatus: compat.status,
      compatibilitySource: compat.source,
      message: compat.message || `Browser playing exact embedded clip "${exact.name}".`,
      canPlayInBrowser: true,
    };
  }

  if (isUnityOnlyAnimationAsset(assignment) || embedded.length === 0) {
    const compat = resolveCompatibility(unityCompat, { hasExactEmbedded: false, unityOnly: true });
    return {
      slot,
      assignedLabel,
      assignedAssetId,
      playingClipName: null,
      browserPlayback: "unavailable_unity_only",
      compatibilityStatus: compat.status,
      compatibilitySource: compat.source,
      message:
        "Assigned in Unity; browser preview unavailable. Studio cannot play .anim / AnimatorController assets in the browser (Mixamo pipeline is W09).",
      canPlayInBrowser: false,
    };
  }

  const compat = resolveCompatibility(unityCompat, { hasExactEmbedded: false });
  return {
    slot,
    assignedLabel,
    assignedAssetId,
    playingClipName: null,
    browserPlayback: "unavailable_no_match",
    compatibilityStatus: compat.status,
    compatibilitySource: compat.source,
    message:
      "Assigned animation does not exactly match any embedded GLB clip. No unrelated clip will be shown.",
    canPlayInBrowser: false,
  };
}

function resolveCompatibility(unityCompat, { hasExactEmbedded = false, unityOnly = false } = {}) {
  const status = String(unityCompat?.status || "").toLowerCase();
  const source = unityCompat?.source || null;
  if (status === "unity_verified" || status === "compatible") {
    if (source === "unity_editor" || source === "unity_bridge" || source === "unity_editor_menu") {
      return {
        status: "unity_verified",
        source,
        message: unityCompat.reason || "Unity reported compatible.",
      };
    }
  }
  if (status === "unity_incompatible" || status === "incompatible") {
    if (source === "unity_editor" || source === "unity_bridge" || source === "unity_editor_menu") {
      return {
        status: "unity_incompatible",
        source,
        message: unityCompat.reason || "Unity reported incompatible.",
      };
    }
  }
  // Never fabricate from GLB bones / filenames.
  if (unityOnly || !hasExactEmbedded) {
    return {
      status: "pending",
      source: source || null,
      message: "Rig compatibility pending authoritative Unity validation.",
    };
  }
  return {
    status: "pending",
    source: source || null,
    message: "Embedded clip matched for browser preview; Unity rig validation still pending.",
  };
}
