/**
 * Pure Level Editor draft/scene identity helpers (W03 Priority 2 #8 continuation).
 */

export function sceneDisplayName(scenePath) {
  if (!scenePath || typeof scenePath !== "string") return "(no scene)";
  const base = scenePath.split("/").pop() || scenePath;
  return base.replace(/\.unity$/i, "") || scenePath;
}

export function draftsForScene(drafts, scenePath) {
  const list = Array.isArray(drafts) ? drafts : [];
  if (!scenePath) return [];
  return list.filter((d) => d && d.scenePath === scenePath);
}

/** Newest matching draft for Unity's active scene; never falls back to another scene. */
export function selectNewestDraftForActiveScene(drafts, activeScenePath) {
  const matching = draftsForScene(drafts, activeScenePath).slice().sort((a, b) => {
    const at = Date.parse(a.updatedAt || 0) || 0;
    const bt = Date.parse(b.updatedAt || 0) || 0;
    if (bt !== at) return bt - at;
    return String(b.id || "").localeCompare(String(a.id || ""));
  });
  return matching[0] || null;
}

export function uniqueScenePaths(drafts) {
  const set = new Set();
  for (const d of Array.isArray(drafts) ? drafts : []) {
    if (d?.scenePath) set.add(d.scenePath);
  }
  return [...set].sort();
}

export function shouldShowDraftSceneSelector(drafts, activeScenePath) {
  const list = Array.isArray(drafts) ? drafts : [];
  if (list.length <= 1) return false;
  if (uniqueScenePaths(list).length > 1) return true;
  return draftsForScene(list, activeScenePath).length > 1;
}

export function draftMatchesActiveScene(draft, activeScenePath) {
  if (!draft?.scenePath || !activeScenePath) return false;
  return draft.scenePath === activeScenePath;
}

/**
 * @returns {string | null} human reason Apply must stay disabled, or null when Apply is allowed.
 */
export function getApplyBlockReason({
  draft,
  activeScenePath,
  unityConnected,
  unityRevision,
} = {}) {
  if (!draft) {
    return "No draft loaded for Unity's active scene. Sync from Unity or open a matching draft.";
  }
  if (!unityConnected) {
    return "Unity is disconnected. Pair/reconnect the connector before Apply.";
  }
  if (!activeScenePath) {
    return "Unity active scene is unknown. Wait for the connector scene list, then retry.";
  }
  if (draft.scenePath !== activeScenePath) {
    return `Draft scene (${draft.scenePath}) differs from Unity's active scene (${activeScenePath}). Open a matching draft or Sync from Unity.`;
  }
  if (draft.status === "conflict") {
    return "Draft is in conflict. Sync from Unity, edit again, then Apply.";
  }
  if (draft.status === "pending_unity" || draft.status === "applying") {
    return "An Apply is already in progress. Wait for Unity to finish.";
  }
  if (
    unityRevision != null &&
    draft.baseUnityRevision != null &&
    Number(draft.baseUnityRevision) < Number(unityRevision)
  ) {
    return `Draft base rev ${draft.baseUnityRevision} is stale vs Unity rev ${unityRevision}. Sync from Unity before Apply.`;
  }
  return null;
}

export function findObjectIndexById(objects, objectId) {
  if (!objectId || !Array.isArray(objects)) return -1;
  return objects.findIndex((o) => o && o.objectId === objectId);
}
