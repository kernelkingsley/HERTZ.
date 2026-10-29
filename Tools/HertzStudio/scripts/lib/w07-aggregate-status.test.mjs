import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evaluateW07AggregateStatus,
  validateW07ConnectorDelivery,
  w07AggregateExitCode,
} from "./w07-aggregate-status.mjs";

describe("w07-aggregate-status", () => {
  it("passed only when every required layer succeeds with authoritative runtime", () => {
    const ev = evaluateW07AggregateStatus({
      apiOk: true,
      connectorOk: true,
      unityApplyOk: true,
      manualOk: true,
      runtimeProof: {
        ok: true,
        status: "passed",
        source: "unity_editor_menu",
        passed: 8,
        total: 8,
      },
    });
    assert.equal(ev.status, "passed");
    assert.equal(ev.ok, true);
    assert.equal(ev.completion, true);
    assert.equal(w07AggregateExitCode(ev), 0);
  });

  it("unavailable proof → pending", () => {
    const ev = evaluateW07AggregateStatus({
      apiOk: true,
      connectorOk: false,
      unityApplyOk: false,
      manualOk: false,
      runtimeProof: {
        ok: false,
        status: "pending",
        source: "pending_unity_unavailable",
        reason: "unity_editor_busy_or_skipped",
        passed: 0,
        total: 0,
      },
    });
    assert.equal(ev.status, "pending");
    assert.equal(ev.ok, false);
    assert.equal(ev.completion, false);
    assert.ok(ev.pendingLayers.includes("runtime_playback"));
    assert.equal(w07AggregateExitCode(ev), 2);
  });

  it("missing artifact → pending", () => {
    const ev = evaluateW07AggregateStatus({
      apiOk: true,
      connectorOk: true,
      unityApplyOk: true,
      manualOk: true,
      runtimeProof: null,
    });
    assert.equal(ev.status, "pending");
    assert.equal(w07AggregateExitCode(ev), 2);
  });

  it("valid authoritative proof → passed when layers ok", () => {
    const ev = evaluateW07AggregateStatus({
      apiOk: true,
      connectorOk: true,
      unityApplyOk: true,
      manualOk: true,
      runtimeProof: {
        ok: true,
        status: "passed",
        source: "unity_editor_menu",
        passed: 12,
        total: 12,
        checks: [{ name: "a", pass: true }],
      },
    });
    assert.equal(ev.status, "passed");
    assert.equal(ev.ok, true);
  });

  it("authoritative failed check → failed (not pending)", () => {
    const ev = evaluateW07AggregateStatus({
      apiOk: true,
      connectorOk: true,
      unityApplyOk: true,
      manualOk: true,
      runtimeProof: {
        ok: false,
        status: "failed",
        source: "unity_editor_menu",
        passed: 10,
        total: 12,
        checks: [
          { name: "ok_one", pass: true },
          { name: "freq_on_accepted_shot", pass: false },
        ],
      },
    });
    assert.equal(ev.status, "failed");
    assert.equal(ev.ok, false);
    assert.equal(w07AggregateExitCode(ev), 1);
  });

  it("authoritative exception → failed", () => {
    const ev = evaluateW07AggregateStatus({
      apiOk: true,
      connectorOk: true,
      unityApplyOk: true,
      manualOk: true,
      runtimeProof: {
        ok: false,
        status: "failed",
        source: "unity_editor_menu",
        exception: "NullReferenceException",
        passed: 0,
        total: 1,
        checks: [{ name: "exception", pass: false }],
      },
    });
    assert.equal(ev.status, "failed");
    assert.equal(w07AggregateExitCode(ev), 1);
  });

  it("authoritative ok:false after run → failed", () => {
    const ev = evaluateW07AggregateStatus({
      apiOk: true,
      connectorOk: false,
      unityApplyOk: false,
      manualOk: false,
      runtimeProof: {
        ok: false,
        status: "failed",
        source: "unity_editor_menu",
        passed: 3,
        total: 5,
      },
    });
    assert.equal(ev.status, "failed");
    assert.equal(w07AggregateExitCode(ev), 1);
  });

  it("non-authoritative fixture claiming success → failed", () => {
    const ev = evaluateW07AggregateStatus({
      apiOk: true,
      connectorOk: true,
      unityApplyOk: true,
      manualOk: true,
      runtimeProof: {
        ok: true,
        source: "node_fallback_fixture",
        passed: 3,
        total: 3,
      },
    });
    assert.equal(ev.status, "failed");
    assert.equal(ev.ok, false);
    assert.match(ev.reason, /node_fallback_fixture/);
    assert.equal(w07AggregateExitCode(ev), 1);
  });

  it("failed when API layer fails", () => {
    const ev = evaluateW07AggregateStatus({
      apiOk: false,
      runtimeProof: { ok: false, status: "pending", source: "pending_unity_unavailable" },
    });
    assert.equal(ev.status, "failed");
    assert.equal(ev.ok, false);
    assert.equal(w07AggregateExitCode(ev), 1);
  });

  it("failed when named checks fail", () => {
    const ev = evaluateW07AggregateStatus({
      apiOk: true,
      failedChecks: ["footstep_explicit"],
      runtimeProof: { ok: false, status: "pending", source: "pending_unity_unavailable" },
    });
    assert.equal(ev.status, "failed");
    assert.match(ev.reason, /footstep_explicit/);
  });

  for (const status of ["passed", "failed"]) {
    it(`stale authoritative ${status} serializes runtime as pending`, () => {
      const rt = {
        ok: status === "passed",
        status,
        source: "unity_editor_menu",
        passed: status === "passed" ? 8 : 7,
        total: 8,
      };
      const ev = evaluateW07AggregateStatus({
        apiOk: true, connectorOk: true, unityApplyOk: true, manualOk: true,
        runtimeProof: rt, runtimeFresh: false, runtimeUnavailableReason: "sourceFingerprint_mismatch",
      });
      assert.equal(ev.status, "pending");
      assert.equal(ev.runtime.status, "pending");
      assert.equal(ev.runtime.ok, false);
      assert.equal(w07AggregateExitCode(ev), 2);
    });
  }
});

describe("W07 connector delivery receipt", () => {
  const runtime = { generatedAt: "2026-10-26T20:00:00.000Z" };
  const valid = {
    schemaVersion: 1,
    proof: "w07-connector-delivery",
    ok: true,
    source: "live_studio_connector",
    requestId: "w07-live-1234",
    payloadHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    observedPayloadHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    unityApplied: true,
    apiAcknowledged: true,
    unityRevision: 150,
    generatedAt: "2026-10-26T20:01:00.000Z",
  };

  it("accepts a fresh matching Unity and API acknowledgement", () => {
    assert.equal(validateW07ConnectorDelivery(valid, runtime).ok, true);
  });

  it("rejects missing, stale, mismatched, and non-live receipts", () => {
    assert.equal(validateW07ConnectorDelivery(null, runtime).reason, "receipt_missing");
    assert.equal(
      validateW07ConnectorDelivery({ ...valid, generatedAt: "2026-10-26T19:59:00.000Z" }, runtime).reason,
      "receipt_stale_for_runtime",
    );
    assert.equal(
      validateW07ConnectorDelivery({ ...valid, observedPayloadHash: "bbbbbbbbbbbbbbbb" }, runtime).reason,
      "payload_hash_mismatch",
    );
    assert.equal(
      validateW07ConnectorDelivery({ ...valid, source: "node_fixture" }, runtime).reason,
      "receipt_not_live_success",
    );
  });
});