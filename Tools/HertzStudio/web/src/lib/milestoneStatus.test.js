import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyDurableMilestoneGates,
  editorCardsWithStatus,
  getMilestoneStatus,
  listMilestones,
  MILESTONE_STATES,
  resetMilestoneGateOverlay,
  resolveMilestoneStatus,
  setMilestoneGateOverlay,
  summarizeMilestoneProgress,
} from "./milestoneStatus.js";
import {
  markW03ReadyForCodexReview,
  readDurableMilestoneGates,
  writeDurableMilestoneGates,
  getMilestoneStatus as nodeGetStatus,
  resetMilestoneGateOverlay as nodeReset,
} from "../../../shared/milestoneStatus.mjs";

describe("milestoneStatus", () => {
  beforeEach(() => {
    resetMilestoneGateOverlay();
    nodeReset();
  });

  it("marks Completed only when all gates pass", () => {
    expect(
      resolveMilestoneStatus({
        started: true,
        tasksComplete: true,
        automatedVerification: true,
        manualVerification: true,
        codexReview: true,
        kingsleyTesting: true,
      }),
    ).toBe(MILESTONE_STATES.COMPLETED);
  });

  it("pending Codex → Ready for Codex review", () => {
    expect(
      resolveMilestoneStatus({
        started: true,
        tasksComplete: true,
        automatedVerification: true,
        manualVerification: true,
        codexReview: false,
        kingsleyTesting: false,
      }),
    ).toBe(MILESTONE_STATES.READY_FOR_CODEX_REVIEW);
  });

  it("Ready for Codex without Play Mode manualVerification (truthful pending manual)", () => {
    expect(
      resolveMilestoneStatus({
        started: true,
        tasksComplete: true,
        automatedVerification: true,
        manualVerification: false,
        codexReview: false,
        kingsleyTesting: false,
      }),
    ).toBe(MILESTONE_STATES.READY_FOR_CODEX_REVIEW);
  });

  it("after Codex, missing manualVerification stays Ready for Kingsley testing", () => {
    expect(
      resolveMilestoneStatus({
        started: true,
        tasksComplete: true,
        automatedVerification: true,
        manualVerification: false,
        codexReview: true,
        kingsleyTesting: false,
      }),
    ).toBe(MILESTONE_STATES.READY_FOR_KINGSLEY_TESTING);
  });

  it("pending Kingsley testing preserved", () => {
    expect(
      resolveMilestoneStatus({
        started: true,
        tasksComplete: true,
        automatedVerification: true,
        manualVerification: true,
        codexReview: true,
        kingsleyTesting: false,
      }),
    ).toBe(MILESTONE_STATES.READY_FOR_KINGSLEY_TESTING);
  });

  it("incomplete task prevents completion", () => {
    expect(
      resolveMilestoneStatus({
        started: true,
        tasksComplete: false,
        automatedVerification: true,
        manualVerification: true,
        codexReview: true,
        kingsleyTesting: true,
      }),
    ).toBe(MILESTONE_STATES.IN_PROGRESS);
  });

  it("preserves blocked", () => {
    expect(resolveMilestoneStatus({ blocked: true, tasksComplete: true })).toBe(MILESTONE_STATES.BLOCKED);
  });

  it("W03 is In progress while tasks incomplete (no displayOverride)", () => {
    expect(getMilestoneStatus("W03")).toBe(MILESTONE_STATES.IN_PROGRESS);
  });

  it("Dashboard and list share identical statuses", () => {
    const cards = editorCardsWithStatus();
    const list = listMilestones();
    for (const card of cards) {
      expect(card.state).toBe(list.find((m) => m.id === card.milestoneId).status);
    }
  });

  it("totals do not double count", () => {
    const summary = summarizeMilestoneProgress();
    expect(summary.total).toBe(14);
    expect(new Set(summary.countedIds).size).toBe(14);
    expect(Object.values(summary.counts).reduce((a, b) => a + b, 0)).toBe(14);
  });

  it("durable gates persist across reload", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-ms-"));
    writeDurableMilestoneGates({ W05: { blocked: true } }, dir);
    expect(readDurableMilestoneGates(dir).W05.blocked).toBe(true);
    expect(nodeGetStatus("W05", null, dir)).toBe(MILESTONE_STATES.BLOCKED);
    // simulate process restart: clear memory, re-read file
    nodeReset();
    expect(nodeGetStatus("W05", null, dir)).toBe(MILESTONE_STATES.BLOCKED);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("markW03ReadyForCodexReview does not self-pass Codex/Kingsley", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-ms2-"));
    markW03ReadyForCodexReview(dir);
    expect(nodeGetStatus("W03", null, dir)).toBe(MILESTONE_STATES.READY_FOR_CODEX_REVIEW);
    const gates = readDurableMilestoneGates(dir).W03;
    expect(gates.codexReview).toBe(false);
    expect(gates.kingsleyTesting).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("applyDurableMilestoneGates updates browser view", () => {
    applyDurableMilestoneGates({
      gates: { W03: { tasksComplete: true, automatedVerification: true, manualVerification: true } },
    });
    expect(getMilestoneStatus("W03")).toBe(MILESTONE_STATES.READY_FOR_CODEX_REVIEW);
  });

  it("rejects inventing Completed via overlay without kingsley gate", () => {
    setMilestoneGateOverlay({
      W03: {
        tasksComplete: true,
        automatedVerification: true,
        manualVerification: true,
        codexReview: true,
        kingsleyTesting: false,
      },
    });
    expect(getMilestoneStatus("W03")).toBe(MILESTONE_STATES.READY_FOR_KINGSLEY_TESTING);
  });
});
