import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-w14-deploy-"));
process.env.HERTZ_STUDIO_DATA = dataDir;

const deploy = await import("./deployPlan.mjs");

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("W14 deploy vertical contracts", () => {
  it("overview never returns secrets and requires provider honesty", () => {
    const o = deploy.getDeployOverview();
    assert.equal(o.productionUrl, "https://studio.hertz.software");
    assert.equal(o.providerSelectionRequired, true);
    assert.ok(o.pendingExternal.includes("public deployment"));
    assert.ok(!JSON.stringify(o).toLowerCase().includes("password"));
  });

  it("refuses acknowledge-without-secret", () => {
    assert.throws(
      () => deploy.acknowledgeCredentialDeposit({ kind: "host" }),
      (e) => e.code === "secret_required",
    );
  });

  it("requires provider before plan", () => {
    assert.throws(
      () => deploy.createDeployPlan({ artifactHash: "a".repeat(64) }),
      (e) => e.code === "provider_not_selected",
    );
  });

  it("rejects arbitrary provider strings as deployable adapters", () => {
    assert.throws(
      () => deploy.selectDeployProvider({ hostProvider: "random-vps-vendor" }),
      (e) => e.code === "provider_not_selected",
    );
  });

  it("creates preview plan after review-only provider select and rejects tamper", () => {
    deploy.selectDeployProvider({ hostProvider: "candidate-review-only" });
    const plan = deploy.createDeployPlan({ artifactHash: "a".repeat(64) });
    assert.equal(plan.status, "preview_only");
    assert.equal(plan.hostname, "studio.hertz.software");
    assert.ok(plan.body === undefined); // plan returned is the body itself
    const ok = deploy.validateDeployPlanTamper({ planId: plan.id, planHash: plan.planHash });
    assert.equal(ok.ok, true);
    assert.throws(
      () => deploy.validateDeployPlanTamper({ planId: plan.id, planHash: "b".repeat(64) }),
      (e) => e.code === "plan_tamper",
    );
  });
});
