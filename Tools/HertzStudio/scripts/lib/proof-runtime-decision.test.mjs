import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideRuntimeProof, selectRuntimeAfterAttempt } from "./proof-runtime-decision.mjs";

const pass = (a) => a?.source === "unity" && a?.ok === true;
const failure = (a) => a?.source === "unity" && a?.status === "failed" ? "authoritative_failed" : null;
const fresh = { ok: true };
const stale = { ok: false, reason: "sourceFingerprint_mismatch" };

for (const milestone of ["W06", "W07"]) {
  describe(`${milestone} proof decisions`, () => {
    it("stale pass stays pending without force and reruns with force", () => {
      const artifact = { source: "unity", ok: true, status: "passed" };
      assert.deepEqual(decideRuntimeProof({ artifact, freshness: stale, isAuthoritativePass: pass, authoritativeFailure: failure }).status, "pending");
      assert.equal(decideRuntimeProof({ artifact, freshness: stale, force: true, isAuthoritativePass: pass, authoritativeFailure: failure }).shouldRun, true);
    });
    it("stale failure stays pending without force and reruns with force", () => {
      const artifact = { source: "unity", ok: false, status: "failed" };
      assert.equal(decideRuntimeProof({ artifact, freshness: stale, isAuthoritativePass: pass, authoritativeFailure: failure }).status, "pending");
      assert.equal(decideRuntimeProof({ artifact, freshness: stale, force: true, isAuthoritativePass: pass, authoritativeFailure: failure }).shouldRun, true);
    });
    it("fresh authoritative failure is preserved unless force reruns", () => {
      const artifact = { source: "unity", ok: false, status: "failed" };
      const normal = decideRuntimeProof({ artifact, freshness: fresh, isAuthoritativePass: pass, authoritativeFailure: failure });
      assert.equal(normal.status, "failed");
      assert.equal(normal.reuse, true);
      assert.equal(decideRuntimeProof({ artifact, freshness: fresh, force: true, isAuthoritativePass: pass, authoritativeFailure: failure }).shouldRun, true);
    });
  });
}

describe("failed forced launch preservation", () => {
  it("keeps prior authoritative evidence", () => {
    const before = { source: "unity", ok: false, status: "failed", id: "prior" };
    const selected = selectRuntimeAfterAttempt({ before, after: null, attempt: { ran: false, reason: "project_locked" } });
    assert.equal(selected.artifact, before);
    assert.equal(selected.attemptFailed, true);
  });
});
