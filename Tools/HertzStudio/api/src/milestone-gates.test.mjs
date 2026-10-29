import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findForbiddenApprovalFields,
  getMilestoneStatus,
  MILESTONE_STATES,
  writeDurableMilestoneGates,
  readDurableMilestoneGates,
} from "../../shared/milestoneStatus.mjs";

describe("milestone gate authority", () => {
  let tmp;
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-milestones-"));
  });
  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("detects forbidden approval fields", () => {
    assert.deepEqual(findForbiddenApprovalFields({ codexReview: true }), ["codexReview"]);
    assert.deepEqual(findForbiddenApprovalFields({ kingsleyTesting: false }), ["kingsleyTesting"]);
    assert.deepEqual(findForbiddenApprovalFields({ tasksComplete: true }), []);
  });

  it("public write path rejects codexReview", () => {
    assert.throws(
      () => writeDurableMilestoneGates({ W03: { codexReview: true } }, tmp),
      (err) => err.code === "forbidden_approval_gate",
    );
  });

  it("public write path rejects kingsleyTesting", () => {
    assert.throws(
      () => writeDurableMilestoneGates({ W03: { kingsleyTesting: true } }, tmp),
      (err) => err.code === "forbidden_approval_gate",
    );
  });

  it("allows implementation gates without touching approval", () => {
    writeDurableMilestoneGates(
      { W03: { started: true, tasksComplete: true, automatedVerification: true, manualVerification: true } },
      tmp,
    );
    const gates = readDurableMilestoneGates(tmp).W03;
    assert.equal(gates.tasksComplete, true);
    assert.notEqual(gates.codexReview, true);
    assert.equal(getMilestoneStatus("W03", null, tmp), MILESTONE_STATES.READY_FOR_CODEX_REVIEW);
  });

  it("internal helper may keep approval gates false", () => {
    writeDurableMilestoneGates(
      { W02: { codexReview: false, kingsleyTesting: false, tasksComplete: true } },
      tmp,
      { allowApprovalGates: true },
    );
    const gates = readDurableMilestoneGates(tmp).W02;
    assert.equal(gates.codexReview, false);
    assert.equal(gates.kingsleyTesting, false);
  });
});
