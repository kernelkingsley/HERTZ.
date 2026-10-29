/**
 * Truthful W07 aggregate status evaluation.
 * Fallback fixtures never satisfy runtime. ok:true only when every required check passes.
 * Authoritative failed runtime → failed (never pending). pending only when unavailable/never run.
 */

export const AUTHORITATIVE_RUNTIME_SOURCES = Object.freeze([
  "unity_editor_menu",
  "unity_batchmode",
  "live_bridge",
  "unity_executeMethod_runtime_capture",
]);

/**
 * @param {{
 *   apiOk: boolean,
 *   connectorOk?: boolean,
 *   unityApplyOk?: boolean,
 *   runtimeProof?: object|null,
 *   runtimeFresh?: boolean,
 *   runtimeUnavailableReason?: string,
 *   manualOk?: boolean,
 *   failedChecks?: string[],
 * }} input
 */
export function evaluateW07AggregateStatus(input = {}) {
  const apiOk = Boolean(input.apiOk);
  const connectorOk = Boolean(input.connectorOk);
  const unityApplyOk = Boolean(input.unityApplyOk);
  const manualOk = Boolean(input.manualOk);
  const rt = input.runtimeProof || null;
  const failedChecks = Array.isArray(input.failedChecks) ? input.failedChecks : [];

  if (failedChecks.length > 0) {
    return {
      status: "failed",
      ok: false,
      completion: false,
      reason: `Failed checks: ${failedChecks.join(", ")}`,
      runtime: summarizeRuntime(rt),
    };
  }

  if (!apiOk) {
    return {
      status: "failed",
      ok: false,
      completion: false,
      reason: "API/data layer failed",
      runtime: summarizeRuntime(rt),
    };
  }

  if (rt?.source === "node_fallback_fixture") {
    return {
      status: "failed",
      ok: false,
      completion: false,
      reason: "node_fallback_fixture cannot satisfy Unity runtime verification",
      runtime: summarizeRuntime(rt),
    };
  }

  // Non-authoritative fixture claiming success → failed.
  if (
    rt &&
    rt.ok === true &&
    rt.source &&
    !AUTHORITATIVE_RUNTIME_SOURCES.includes(rt.source) &&
    rt.source !== "pending_unity_unavailable"
  ) {
    return {
      status: "failed",
      ok: false,
      completion: false,
      reason: `non-authoritative runtime source claiming success: ${rt.source}`,
      runtime: summarizeRuntime(rt),
    };
  }

  if (input.runtimeFresh === false) {
    return {
      status: "pending",
      ok: false,
      completion: false,
      reason: "Pending: runtime_playback (" + (input.runtimeUnavailableReason || "stale_or_unavailable") + ")",
      runtime: summarizeRuntime(rt, false, input.runtimeUnavailableReason),
      pendingLayers: ["runtime_playback"],
    };
  }

  const authFailed = isAuthoritativeRuntimeFailure(rt);
  if (authFailed) {
    return {
      status: "failed",
      ok: false,
      completion: false,
      reason: authFailed,
      runtime: summarizeRuntime(rt),
    };
  }

  const runtimePassed = isAuthoritativeRuntimePass(rt);
  const runtimePending = isRuntimePending(rt);

  const pendingParts = [];
  if (!connectorOk) pendingParts.push("connector_delivery");
  if (!unityApplyOk) pendingParts.push("unity_application");
  if (!runtimePassed) pendingParts.push("runtime_playback");
  if (!manualOk) pendingParts.push("manual_verification");

  if (pendingParts.length > 0 || runtimePending) {
    return {
      status: "pending",
      ok: false,
      completion: false,
      reason: `Pending: ${pendingParts.join(", ") || "runtime_playback"}`,
      runtime: summarizeRuntime(rt),
      pendingLayers: pendingParts,
    };
  }

  return {
    status: "passed",
    ok: true,
    completion: true,
    reason: "All required layers passed",
    runtime: summarizeRuntime(rt),
  };
}

export function isAuthoritativeRuntimePass(rt) {
  return (
    Boolean(rt) &&
    rt.ok === true &&
    rt.status !== "failed" &&
    AUTHORITATIVE_RUNTIME_SOURCES.includes(rt.source) &&
    Number(rt.passed) === Number(rt.total) &&
    Number(rt.total) > 0 &&
    !hasFailedNamedCheck(rt) &&
    !hasException(rt)
  );
}

/** @returns {string|null} failure reason or null */
export function isAuthoritativeRuntimeFailure(rt) {
  if (!rt) return null;
  if (!AUTHORITATIVE_RUNTIME_SOURCES.includes(rt.source)) return null;
  if (rt.status === "pending" || rt.source === "pending_unity_unavailable") return null;

  if (rt.status === "failed") {
    return `authoritative runtime status=failed (${rt.failed || rt.reason || "named checks"})`;
  }
  if (rt.ok === false) {
    return `authoritative runtime ok=false after proof ran (${rt.failed || rt.reason || "checks"})`;
  }
  if (hasFailedNamedCheck(rt)) {
    return "authoritative runtime has a failed named check";
  }
  if (hasException(rt)) {
    return `authoritative runtime exception: ${rt.exception || rt.failed}`;
  }
  return null;
}

export function isRuntimePending(rt) {
  if (!rt) return true; // missing artifact
  if (rt.source === "pending_unity_unavailable") return true;
  if (rt.status === "pending") return true;
  if (!AUTHORITATIVE_RUNTIME_SOURCES.includes(rt.source) && rt.ok !== true) return true;
  return false;
}

function hasFailedNamedCheck(rt) {
  const checks = Array.isArray(rt?.checks) ? rt.checks : [];
  return checks.some((c) => c && c.pass === false);
}

function hasException(rt) {
  if (rt?.exception) return true;
  if (typeof rt?.failed === "string" && /exception/i.test(rt.failed)) return true;
  const checks = Array.isArray(rt?.checks) ? rt.checks : [];
  return checks.some((c) => c && c.name === "exception" && c.pass === false);
}

function summarizeRuntime(rt, runtimeFresh = true, unavailableReason = null) {
  if (!rt) return { ok: false, status: "pending", source: null, reason: unavailableReason };
  if (!runtimeFresh) {
    return { ok: false, status: "pending", source: rt.source || null, reason: unavailableReason || "stale_or_unavailable" };
  }
  if (isAuthoritativeRuntimeFailure(rt)) {
    return {
      ok: false,
      status: "failed",
      source: rt.source || null,
      reason: rt.reason || rt.failed || null,
    };
  }
  return {
    ok: isAuthoritativeRuntimePass(rt),
    status: isAuthoritativeRuntimePass(rt) ? "passed" : rt.status || "pending",
    source: rt.source || null,
    reason: rt.reason || null,
  };
}

/** Validate a receipt written only after the live connector received matching Unity + API acknowledgements. */
export function validateW07ConnectorDelivery(receipt, runtimeProof) {
  if (!receipt || typeof receipt !== "object") return { ok: false, reason: "receipt_missing" };
  if (receipt.schemaVersion !== 1 || receipt.proof !== "w07-connector-delivery") {
    return { ok: false, reason: "receipt_schema_mismatch" };
  }
  if (receipt.ok !== true || receipt.source !== "live_studio_connector") {
    return { ok: false, reason: "receipt_not_live_success" };
  }
  if (receipt.unityApplied !== true || receipt.apiAcknowledged !== true) {
    return { ok: false, reason: "delivery_not_acknowledged" };
  }
  if (
    typeof receipt.payloadHash !== "string" ||
    receipt.payloadHash.length < 16 ||
    receipt.payloadHash !== receipt.observedPayloadHash
  ) {
    return { ok: false, reason: "payload_hash_mismatch" };
  }
  if (typeof receipt.requestId !== "string" || receipt.requestId.length < 8) {
    return { ok: false, reason: "request_id_missing" };
  }
  const receiptAt = Date.parse(receipt.generatedAt || "");
  const runtimeAt = Date.parse(runtimeProof?.generatedAt || runtimeProof?.stampedAt || "");
  if (!Number.isFinite(receiptAt) || !Number.isFinite(runtimeAt) || receiptAt < runtimeAt) {
    return { ok: false, reason: "receipt_stale_for_runtime" };
  }
  return {
    ok: true,
    reason: null,
    source: receipt.source,
    requestId: receipt.requestId,
    payloadHash: receipt.payloadHash,
    unityRevision: receipt.unityRevision ?? null,
    generatedAt: receipt.generatedAt,
  };
}
/** Exit code for completion proof: 0 passed, 2 pending, 1 failed. */
export function w07AggregateExitCode(evaluation) {
  if (evaluation?.status === "passed" && evaluation.ok === true) return 0;
  if (evaluation?.status === "pending") return 2;
  return 1;
}
