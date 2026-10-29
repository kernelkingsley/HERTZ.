/** Pure runtime-proof reuse/rerun policy shared by W06 and W07 aggregates. */
export function decideRuntimeProof({ artifact, freshness, force = false, isAuthoritativePass, authoritativeFailure }) {
  const fresh = Boolean(freshness?.ok);
  const pass = Boolean(artifact && isAuthoritativePass(artifact));
  const failureReason = artifact ? authoritativeFailure(artifact) : null;
  const pending = !artifact || artifact.status === "pending" || artifact.source === "pending_unity_unavailable";
  const nonAuthoritativeSuccess = Boolean(artifact?.ok === true && !pass && !failureReason);

  // Documented contract: force always reruns, including fresh pass/failure evidence.
  if (force) {
    return { shouldRun: true, status: "pending", reuse: false, reason: "forced_rerun" };
  }
  if (pending) {
    return { shouldRun: false, status: "pending", reuse: false, reason: artifact ? "runtime_pending" : "missing_artifact" };
  }
  if (!fresh) {
    return { shouldRun: false, status: "pending", reuse: false, reason: freshness?.reason || "stale_artifact" };
  }
  if (failureReason) {
    return { shouldRun: false, status: "failed", reuse: true, reason: failureReason };
  }
  if (pass) {
    return { shouldRun: false, status: "passed", reuse: true, reason: "fresh_authoritative_pass" };
  }
  if (nonAuthoritativeSuccess) {
    return { shouldRun: false, status: "failed", reuse: false, reason: "non_authoritative_success" };
  }
  return { shouldRun: false, status: "pending", reuse: false, reason: "non_authoritative_or_incomplete" };
}

/** Preserve prior evidence when a forced Unity launch does not complete successfully. */
export function selectRuntimeAfterAttempt({ before, after, attempt }) {
  if (attempt?.ran === true && attempt?.status === 0 && after) {
    return { artifact: after, attemptFailed: false, reason: "unity_run_completed" };
  }
  return {
    artifact: before || after || null,
    attemptFailed: true,
    reason: attempt?.reason || `unity_run_failed_status_${attempt?.status ?? "unknown"}`,
  };
}
