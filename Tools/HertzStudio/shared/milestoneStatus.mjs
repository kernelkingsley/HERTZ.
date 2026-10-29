/**
 * Node milestone status: pure core + durable data/milestone-gates.json.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPROVAL_GATE_KEYS,
  EDITOR_MILESTONE_CARDS,
  findForbiddenApprovalFields,
  IMPLEMENTATION_GATE_KEYS,
  MILESTONE_GATES,
  MILESTONE_IDS,
  MILESTONE_STATES,
  mergeGates,
  resolveMilestoneStatus,
  sanitizeGatePartial,
  sanitizeImplementationGatePartial,
  statusBadgeVariant,
  summarizeMilestoneProgress as summarizeRows,
} from "./milestoneStatusCore.mjs";

export {
  APPROVAL_GATE_KEYS,
  EDITOR_MILESTONE_CARDS,
  findForbiddenApprovalFields,
  IMPLEMENTATION_GATE_KEYS,
  MILESTONE_GATES,
  MILESTONE_IDS,
  MILESTONE_STATES,
  resolveMilestoneStatus,
  sanitizeImplementationGatePartial,
  statusBadgeVariant,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function defaultDataDir() {
  if (process.env.HERTZ_STUDIO_DATA) return path.resolve(process.env.HERTZ_STUDIO_DATA);
  return path.resolve(__dirname, "../data");
}

export function milestoneGatesPath(dataDir = defaultDataDir()) {
  return path.join(dataDir, "milestone-gates.json");
}

export function readDurableMilestoneGates(dataDir = defaultDataDir()) {
  const file = milestoneGatesPath(dataDir);
  try {
    if (!fs.existsSync(file)) return {};
    let text = fs.readFileSync(file, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const raw = JSON.parse(text);
    const byId = raw?.gates && typeof raw.gates === "object" ? raw.gates : raw;
    const cleaned = {};
    for (const id of MILESTONE_IDS) {
      if (byId?.[id] && typeof byId[id] === "object") cleaned[id] = sanitizeGatePartial(byId[id]);
    }
    return cleaned;
  } catch {
    return {};
  }
}

/**
 * Persist durable gates. By default only implementation-owned fields may change.
 * Pass { allowApprovalGates: true } for trusted internal helpers (never from public PATCH).
 */
export function writeDurableMilestoneGates(partialById = {}, dataDir = defaultDataDir(), options = {}) {
  const allowApproval = Boolean(options.allowApprovalGates);
  const file = milestoneGatesPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = readDurableMilestoneGates(dataDir);
  const next = { ...current };
  for (const [id, partial] of Object.entries(partialById || {})) {
    if (!MILESTONE_IDS.includes(id)) {
      const err = new Error(`Unknown milestone id: ${id}`);
      err.code = "invalid_milestone";
      throw err;
    }
    if (!allowApproval) {
      const forbidden = findForbiddenApprovalFields(partial);
      if (forbidden.length) {
        const err = new Error(
          `Forbidden approval gate(s) on PATCH: ${forbidden.join(", ")}. Use independent review/approval, not the Studio app.`,
        );
        err.code = "forbidden_approval_gate";
        err.forbidden = forbidden;
        throw err;
      }
    }
    const cleaned = allowApproval ? sanitizeGatePartial(partial) : sanitizeImplementationGatePartial(partial);
    next[id] = { ...(current[id] || {}), ...cleaned };
  }
  const payload = { version: 1, updatedAt: new Date().toISOString(), gates: next };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
  });
  return payload;
}

let memoryOverlay = Object.create(null);

export function resetMilestoneGateOverlay() {
  memoryOverlay = Object.create(null);
}

export function setMilestoneGateOverlay(partialById = {}) {
  for (const [id, partial] of Object.entries(partialById || {})) {
    memoryOverlay[id] = { ...(memoryOverlay[id] || {}), ...sanitizeGatePartial(partial) };
  }
}

export function getMilestoneGates(id, dataDir = defaultDataDir()) {
  const base = MILESTONE_GATES[id];
  if (!base) return null;
  return mergeGates(base, readDurableMilestoneGates(dataDir)[id], memoryOverlay[id]);
}

export function getMilestoneStatus(id, gatesOverride = null, dataDir = defaultDataDir()) {
  const gates = gatesOverride || getMilestoneGates(id, dataDir);
  if (!gates) return MILESTONE_STATES.NOT_STARTED;
  return resolveMilestoneStatus(gates);
}

export function listMilestones(dataDir = defaultDataDir()) {
  return MILESTONE_IDS.map((id) => {
    const gates = getMilestoneGates(id, dataDir);
    return { id, title: gates.title, status: getMilestoneStatus(id, gates, dataDir), gates };
  });
}

export function summarizeMilestoneProgress(milestones = listMilestones()) {
  return summarizeRows(milestones);
}

export function editorCardsWithStatus(dataDir = defaultDataDir()) {
  return EDITOR_MILESTONE_CARDS.map((card) => ({
    ...card,
    state: getMilestoneStatus(card.milestoneId, null, dataDir),
  }));
}

export function markW03ReadyForCodexReview(dataDir = defaultDataDir()) {
  // Internal helper may touch approval keys only to keep them explicitly false.
  return writeDurableMilestoneGates(
    {
      W03: {
        started: true,
        tasksComplete: true,
        automatedVerification: true,
        manualVerification: true,
        codexReview: false,
        kingsleyTesting: false,
        blocked: false,
      },
    },
    dataDir,
    { allowApprovalGates: true },
  );
}
