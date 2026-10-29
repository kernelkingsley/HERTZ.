/**
 * Pure milestone status logic (browser + Node safe). No filesystem.
 */
export const MILESTONE_STATES = Object.freeze({
  NOT_STARTED: "Not started",
  IN_PROGRESS: "In progress",
  BLOCKED: "Blocked",
  READY_FOR_CODEX_REVIEW: "Ready for Codex review",
  READY_FOR_KINGSLEY_TESTING: "Ready for Kingsley testing",
  COMPLETED: "Completed",
});

export const MILESTONE_IDS = Object.freeze([
  "W01", "W02", "W03", "W04", "W05", "W06", "W07",
  "W08", "W09", "W10", "W11", "W12", "W13", "W14",
]);

export const GATE_KEYS = Object.freeze([
  "blocked",
  "started",
  "tasksComplete",
  "automatedVerification",
  "manualVerification",
  "codexReview",
  "kingsleyTesting",
]);

export const MILESTONE_GATES = Object.freeze({
  W01: Object.freeze({
    id: "W01", title: "Studio shell + drafts",
    blocked: false, started: true, tasksComplete: true,
    automatedVerification: true, manualVerification: true,
    codexReview: true, kingsleyTesting: true,
  }),
  W02: Object.freeze({
    id: "W02", title: "Import loop + Asset Library",
    blocked: false, started: true, tasksComplete: true,
    automatedVerification: true, manualVerification: true,
    codexReview: false, kingsleyTesting: false,
  }),
  W03: Object.freeze({
    id: "W03", title: "Level editor + typed Unity ops",
    blocked: false, started: true, tasksComplete: false,
    automatedVerification: false, manualVerification: false,
    codexReview: false, kingsleyTesting: false,
  }),
  W04: Object.freeze({
    id: "W04", title: "Weapon catalog",
    blocked: false, started: true, tasksComplete: false,
    automatedVerification: false, manualVerification: false,
    codexReview: false, kingsleyTesting: false,
  }),
  W05: Object.freeze({ id: "W05", title: "Characters & Enemies", blocked: false, started: false, tasksComplete: false, automatedVerification: false, manualVerification: false, codexReview: false, kingsleyTesting: false }),
  W06: Object.freeze({ id: "W06", title: "Analytics", blocked: false, started: false, tasksComplete: false, automatedVerification: false, manualVerification: false, codexReview: false, kingsleyTesting: false }),
  W07: Object.freeze({ id: "W07", title: "Sound", blocked: false, started: false, tasksComplete: false, automatedVerification: false, manualVerification: false, codexReview: false, kingsleyTesting: false }),
  W08: Object.freeze({ id: "W08", title: "Materials & Lighting", blocked: false, started: false, tasksComplete: false, automatedVerification: false, manualVerification: false, codexReview: false, kingsleyTesting: false }),
  W09: Object.freeze({ id: "W09", title: "Animation", blocked: false, started: false, tasksComplete: false, automatedVerification: false, manualVerification: false, codexReview: false, kingsleyTesting: false }),
  W10: Object.freeze({ id: "W10", title: "Performance", blocked: false, started: false, tasksComplete: false, automatedVerification: false, manualVerification: false, codexReview: false, kingsleyTesting: false }),
  W11: Object.freeze({ id: "W11", title: "Snapshots", blocked: false, started: false, tasksComplete: false, automatedVerification: false, manualVerification: false, codexReview: false, kingsleyTesting: false }),
  W12: Object.freeze({ id: "W12", title: "Encounters", blocked: false, started: false, tasksComplete: false, automatedVerification: false, manualVerification: false, codexReview: false, kingsleyTesting: false }),
  W13: Object.freeze({ id: "W13", title: "Polish / comfort", blocked: false, started: false, tasksComplete: false, automatedVerification: false, manualVerification: false, codexReview: false, kingsleyTesting: false }),
  W14: Object.freeze({ id: "W14", title: "Deploy", blocked: false, started: false, tasksComplete: false, automatedVerification: false, manualVerification: false, codexReview: false, kingsleyTesting: false }),
});

export function resolveMilestoneStatus(gates = {}) {
  if (gates.blocked) return MILESTONE_STATES.BLOCKED;
  // Codex re-review may proceed once tasks + automated verification are truthful.
  // manualVerification (e.g. Unity Play Mode) can remain false without blocking Ready for Codex.
  const automatedDone = Boolean(gates.tasksComplete && gates.automatedVerification);
  if (!automatedDone) {
    if (gates.started || gates.tasksComplete || gates.automatedVerification || gates.manualVerification) {
      return MILESTONE_STATES.IN_PROGRESS;
    }
    return MILESTONE_STATES.NOT_STARTED;
  }
  if (!gates.codexReview) return MILESTONE_STATES.READY_FOR_CODEX_REVIEW;
  if (!gates.manualVerification || !gates.kingsleyTesting) {
    return MILESTONE_STATES.READY_FOR_KINGSLEY_TESTING;
  }
  return MILESTONE_STATES.COMPLETED;
}

/** Gates the Studio app may write via PATCH /api/milestones/:id. */
export const IMPLEMENTATION_GATE_KEYS = Object.freeze([
  "blocked",
  "started",
  "tasksComplete",
  "automatedVerification",
  "manualVerification",
]);

/** Independent approval gates — never writable via the public application PATCH route. */
export const APPROVAL_GATE_KEYS = Object.freeze(["codexReview", "kingsleyTesting"]);

export function sanitizeGatePartial(partial = {}) {
  const out = {};
  for (const key of GATE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(partial, key)) out[key] = Boolean(partial[key]);
  }
  return out;
}

/** Strip approval gates; used by owner-facing PATCH. */
export function sanitizeImplementationGatePartial(partial = {}) {
  const out = {};
  for (const key of IMPLEMENTATION_GATE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(partial, key)) out[key] = Boolean(partial[key]);
  }
  return out;
}

export function findForbiddenApprovalFields(partial = {}) {
  return APPROVAL_GATE_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(partial || {}, key));
}

export function mergeGates(base, ...overlays) {
  let next = { ...base };
  for (const overlay of overlays) {
    if (!overlay) continue;
    next = { ...next, ...sanitizeGatePartial(overlay), id: base.id, title: base.title };
  }
  return next;
}

export function summarizeMilestoneProgress(milestones) {
  const counts = {
    [MILESTONE_STATES.NOT_STARTED]: 0,
    [MILESTONE_STATES.IN_PROGRESS]: 0,
    [MILESTONE_STATES.BLOCKED]: 0,
    [MILESTONE_STATES.READY_FOR_CODEX_REVIEW]: 0,
    [MILESTONE_STATES.READY_FOR_KINGSLEY_TESTING]: 0,
    [MILESTONE_STATES.COMPLETED]: 0,
  };
  for (const row of milestones) {
    if (counts[row.status] != null) counts[row.status] += 1;
  }
  const total = milestones.length;
  const completed = counts[MILESTONE_STATES.COMPLETED];
  return {
    total,
    completed,
    percentComplete: total === 0 ? 0 : Math.round((completed / total) * 100),
    counts,
    countedIds: milestones.map((m) => m.id),
  };
}

export const EDITOR_MILESTONE_CARDS = Object.freeze([
  { title: "Level editor", blurb: "Place and tune the town in a browser preview, then apply to Unity.", to: "/level-editor", milestoneId: "W03" },
  { title: "Characters & Enemies", blurb: "Models and behavior profiles for spirits and characters.", to: "/characters", milestoneId: "W05" },
  { title: "Weapons", blurb: "Dual-pistol catalog and tuning after frequency flip.", to: "/weapons", milestoneId: "W04" },
  { title: "Asset Library", blurb: "Kenney packs, Sketchfab, typed drag targets.", to: "/assets", milestoneId: "W02" },
  { title: "Analytics", blurb: "Hosted playtest readouts that stay available with Unity off.", to: "/analytics", milestoneId: "W06" },
  { title: "Performance", blurb: "Quest-focused capture summaries.", to: "/performance", milestoneId: "W10" },
]);

export function statusBadgeVariant(status) {
  if (
    status === MILESTONE_STATES.COMPLETED ||
    status === MILESTONE_STATES.READY_FOR_CODEX_REVIEW ||
    status === MILESTONE_STATES.READY_FOR_KINGSLEY_TESTING
  ) {
    return "default";
  }
  if (status === MILESTONE_STATES.BLOCKED) return "destructive";
  return "outline";
}
