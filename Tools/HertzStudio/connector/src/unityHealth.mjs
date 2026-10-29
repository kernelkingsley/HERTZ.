/**
 * Decide whether Unity is reachable for mutation polling.
 * Bridge /health must be HTTP 2xx with a successful main-thread payload.
 * Deferred/stalled main-thread responses (HTTP 503) must leave jobs queued.
 */
export function isUnityHealthReachable(health) {
  if (!health || health.ok !== true) {
    return false;
  }
  if (typeof health.status === "number" && (health.status < 200 || health.status >= 300)) {
    return false;
  }
  const data = health.data;
  if (data && data.ok === false) {
    return false;
  }
  if (data && data.note === "main_thread_deferred") {
    return false;
  }
  if (data && data.error === "main_thread_unavailable") {
    return false;
  }
  return true;
}
