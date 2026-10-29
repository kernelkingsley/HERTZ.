import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertProofSchema, createProofBuilder, PROOF_SCHEMA_VERSION } from "./proof-schema.mjs";

describe("proof-schema", () => {
  it("derives ok from checks and fails missing required checks", () => {
    const b = createProofBuilder({
      proof: "t",
      runner: "r",
      command: "node t",
    });
    b.record("a", true, { actual: 1, expected: 1 });
    const artifact = b.build({ requiredChecks: ["a", "b"] });
    assert.equal(artifact.schemaVersion, PROOF_SCHEMA_VERSION);
    assert.equal(artifact.ok, false);
    assert.ok(artifact.checks.some((c) => c.name === "b" && c.pass === false));
  });

  it("rejects ok that does not match checks", () => {
    const errors = assertProofSchema({
      schemaVersion: PROOF_SCHEMA_VERSION,
      runner: "r",
      command: "c",
      stampedAt: new Date().toISOString(),
      ok: true,
      checks: [{ name: "x", pass: false, actual: 0, expected: 1 }],
    });
    assert.ok(errors.includes("ok does not match checks"));
  });
});
