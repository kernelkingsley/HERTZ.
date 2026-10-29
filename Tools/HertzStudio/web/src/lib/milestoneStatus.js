/**
 * Browser milestone status — pure gates + optional durable snapshot injected by API.
 * No displayOverride. No Node fs.
 */
import {
  EDITOR_MILESTONE_CARDS,
  MILESTONE_GATES,
  MILESTONE_IDS,
  MILESTONE_STATES,
  mergeGates,
  resolveMilestoneStatus,
  statusBadgeVariant,
  summarizeMilestoneProgress as summarizeRows,
} from "../../../shared/milestoneStatusCore.mjs";

export {
  EDITOR_MILESTONE_CARDS,
  MILESTONE_GATES,
  MILESTONE_IDS,
  MILESTONE_STATES,
  resolveMilestoneStatus,
  statusBadgeVariant,
};

/** Durable gates last fetched from /api/milestones (or test overlay). */
let durableGates = Object.create(null);
let memoryOverlay = Object.create(null);

export function resetMilestoneGateOverlay() {
  memoryOverlay = Object.create(null);
  durableGates = Object.create(null);
}

export function setMilestoneGateOverlay(partialById = {}) {
  for (const [id, partial] of Object.entries(partialById || {})) {
    memoryOverlay[id] = { ...(memoryOverlay[id] || {}), ...partial };
  }
}

/** Apply durable gates from the API JSON payload. */
export function applyDurableMilestoneGates(payload) {
  const byId = payload?.gates && typeof payload.gates === "object" ? payload.gates : payload || {};
  durableGates = Object.create(null);
  for (const id of MILESTONE_IDS) {
    if (byId[id] && typeof byId[id] === "object") durableGates[id] = { ...byId[id] };
  }
}

export function getMilestoneGates(id) {
  const base = MILESTONE_GATES[id];
  if (!base) return null;
  return mergeGates(base, durableGates[id], memoryOverlay[id]);
}

export function getMilestoneStatus(id, gatesOverride = null) {
  const gates = gatesOverride || getMilestoneGates(id);
  if (!gates) return MILESTONE_STATES.NOT_STARTED;
  return resolveMilestoneStatus(gates);
}

export function listMilestones() {
  return MILESTONE_IDS.map((id) => {
    const gates = getMilestoneGates(id);
    return { id, title: gates.title, status: getMilestoneStatus(id, gates), gates };
  });
}

export function summarizeMilestoneProgress(milestones = listMilestones()) {
  return summarizeRows(milestones);
}

export function editorCardsWithStatus() {
  return EDITOR_MILESTONE_CARDS.map((card) => ({
    ...card,
    state: getMilestoneStatus(card.milestoneId),
  }));
}
