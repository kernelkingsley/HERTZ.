/**
 * W03 #15 — distinguish API / connector / Unity / revision / scene mismatch states.
 */
export const CONNECTION_KIND = Object.freeze({
  API_OFFLINE: "api_offline",
  CONNECTOR_OFFLINE: "connector_offline",
  UNITY_OFFLINE: "unity_offline",
  STALE_REVISION: "stale_revision",
  SCENE_MISMATCH: "scene_mismatch",
  APPLY_PENDING: "apply_pending",
  APPLY_APPLYING: "apply_applying",
  CONFLICT: "conflict",
  FAILED: "failed",
  RECOVERY: "recovery",
  ONLINE: "online",
});

/**
 * @param {object} input
 * @param {boolean} [input.apiReachable]
 * @param {boolean} [input.connectorOnline]
 * @param {boolean} [input.unityConnected]
 * @param {string|null} [input.activeScenePath]
 * @param {string|null} [input.draftScenePath]
 * @param {number|null} [input.unityRevision]
 * @param {number|null} [input.draftBaseRevision]
 * @param {string|null} [input.draftStatus]
 * @param {boolean} [input.bindingResyncRequired]
 */
export function resolveConnectionStatus(input = {}) {
  const states = [];
  if (input.apiReachable === false) {
    states.push({
      kind: CONNECTION_KIND.API_OFFLINE,
      severity: "error",
      message: "Studio API is offline. Draft edits cannot be saved until it returns.",
      blocksApply: true,
      allowsDraftEdit: false,
    });
  }
  if (input.apiReachable !== false && input.connectorOnline === false) {
    states.push({
      kind: CONNECTION_KIND.CONNECTOR_OFFLINE,
      severity: "warn",
      message: "Connector offline. Draft edits stay local until the connector reconnects.",
      blocksApply: true,
      allowsDraftEdit: true,
    });
  }
  if (input.apiReachable !== false && input.connectorOnline !== false && input.unityConnected === false) {
    states.push({
      kind: CONNECTION_KIND.UNITY_OFFLINE,
      severity: "warn",
      message: "Unity bridge offline. Editing is allowed; Apply waits for Unity.",
      blocksApply: true,
      allowsDraftEdit: true,
    });
  }
  if (
    input.draftScenePath &&
    input.activeScenePath &&
    input.draftScenePath !== input.activeScenePath
  ) {
    states.push({
      kind: CONNECTION_KIND.SCENE_MISMATCH,
      severity: "error",
      message: `Draft scene (${input.draftScenePath}) does not match Unity active scene (${input.activeScenePath}). Sync from Unity.`,
      blocksApply: true,
      allowsDraftEdit: true,
      recovery: "sync_from_unity",
    });
  }
  if (
    Number.isFinite(Number(input.unityRevision)) &&
    Number.isFinite(Number(input.draftBaseRevision)) &&
    Number(input.unityRevision) !== Number(input.draftBaseRevision)
  ) {
    states.push({
      kind: CONNECTION_KIND.STALE_REVISION,
      severity: "error",
      message: `Draft base rev ${input.draftBaseRevision} is stale vs Unity rev ${input.unityRevision}. Sync from Unity before Apply.`,
      blocksApply: true,
      allowsDraftEdit: true,
      recovery: "sync_from_unity",
    });
  }
  const status = String(input.draftStatus || "");
  if (status === "pending_unity") {
    states.push({
      kind: CONNECTION_KIND.APPLY_PENDING,
      severity: "info",
      message: "Apply pending Unity. Not acknowledged yet.",
      blocksApply: true,
      allowsDraftEdit: false,
    });
  } else if (status === "applying") {
    states.push({
      kind: CONNECTION_KIND.APPLY_APPLYING,
      severity: "info",
      message: "Unity is applying commands.",
      blocksApply: true,
      allowsDraftEdit: false,
    });
  } else if (status === "conflict") {
    states.push({
      kind: CONNECTION_KIND.CONFLICT,
      severity: "error",
      message: "Revision conflict. Sync from Unity, then re-apply.",
      blocksApply: true,
      allowsDraftEdit: true,
      recovery: "sync_from_unity",
    });
  } else if (status === "failed") {
    states.push({
      kind: CONNECTION_KIND.FAILED,
      severity: "error",
      message: "Last Apply failed. Draft proxy restored to last persisted state where possible.",
      blocksApply: false,
      allowsDraftEdit: true,
      recovery: "retry_apply",
    });
  }
  if (input.bindingResyncRequired) {
    states.push({
      kind: CONNECTION_KIND.RECOVERY,
      severity: "warn",
      message: "Stale Unity bindings detected. Resync from Unity before trusting object ids.",
      blocksApply: true,
      allowsDraftEdit: true,
      recovery: "sync_from_unity",
    });
  }

  if (!states.length) {
    states.push({
      kind: CONNECTION_KIND.ONLINE,
      severity: "ok",
      message: "API, connector, and Unity look ready.",
      blocksApply: false,
      allowsDraftEdit: true,
    });
  }

  const blocksApply = states.some((s) => s.blocksApply);
  const allowsDraftEdit = states.every((s) => s.allowsDraftEdit !== false);
  return {
    states,
    primary: states[0],
    blocksApply,
    allowsDraftEdit,
    requiresLiveUnity: blocksApply && states.some((s) =>
      [CONNECTION_KIND.UNITY_OFFLINE, CONNECTION_KIND.CONNECTOR_OFFLINE, CONNECTION_KIND.API_OFFLINE].includes(s.kind),
    ),
  };
}
