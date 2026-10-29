/**
 * W06 Analytics — documented playtest event schema, durable owner-scoped captures,
 * deduped import, server-side aggregates (available with Unity off).
 * No personal identifiers. No fabricated metrics. No fixture mixing with live store.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ANALYTICS_SCHEMA_VERSION = 1;

export const EVENT_TYPES = Object.freeze([
  "session_start",
  "session_end",
  "level_start",
  "level_end",
  "frequency_flip",
  "shot",
  "hit",
  "enemy_defeat",
  "frame_sample",
]);

const EVENT_TYPE_SET = new Set(EVENT_TYPES);
const MAX_EVENTS_PER_CAPTURE = 5000;
const MAX_CAPTURES_LIST = 200;

function defaultDataDir() {
  if (process.env.HERTZ_STUDIO_DATA) return path.resolve(process.env.HERTZ_STUDIO_DATA);
  return path.resolve(__dirname, "../../data");
}

function analyticsRoot(dataDir = defaultDataDir()) {
  return path.join(dataDir, "analytics");
}

function indexPath(dataDir) {
  return path.join(analyticsRoot(dataDir), "index.json");
}

function capturePath(dataDir, captureId) {
  return path.join(analyticsRoot(dataDir), "captures", `${captureId}.json`);
}

function ensureDirs(dataDir) {
  const root = analyticsRoot(dataDir);
  fs.mkdirSync(path.join(root, "captures"), { recursive: true });
  return root;
}

function readJsonSafe(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  let text = fs.readFileSync(filePath, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

function loadIndex(dataDir) {
  ensureDirs(dataDir);
  const idx = readJsonSafe(indexPath(dataDir), null);
  if (idx && typeof idx === "object" && Array.isArray(idx.captures)) return idx;
  return { version: 1, captures: [], seenEventIds: {} };
}

function saveIndex(dataDir, idx) {
  writeJsonAtomic(indexPath(dataDir), idx);
}

/** Documented schema for Studio + Unity exporters. */
export function getAnalyticsSchema() {
  return {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    description:
      "HERTZ playtest analytics events. Owner-private. No personal identifiers. Device Quest transfer is documented separately.",
    eventTypes: [...EVENT_TYPES],
    requiredFields: ["eventId", "type", "buildId", "sessionId", "recordedAt"],
    optionalFields: [
      "levelId",
      "tMs",
      "weaponId",
      "weaponRole",
      "enemyId",
      "frequencyActive",
      "hit",
      "damage",
      "frameMs",
      "completed",
      "source",
    ],
    captureEnvelope: {
      captureId: "uuid (server-assigned on import if omitted)",
      schemaVersion: ANALYTICS_SCHEMA_VERSION,
      buildId: "string",
      exportedAt: "ISO-8601",
      source: "unity_editor | unity_runtime | browser_import | connector",
      events: "array of events (max 5000)",
    },
    aggregationNote:
      "Dashboard summaries are computed server-side from stored captures. Clients must not request unbounded raw event dumps for charts.",
    questTransferNote:
      "Quest device capture is unverified in W06. Transfer path: export capture JSON from Editor/Play Mode on PC Link, or copy Application.persistentDataPath capture files off-device via Meta Quest Developer Hub / MTP, then import in Studio Analytics. No automatic Quest→cloud uplink in this milestone.",
  };
}

export function getQuestTransferGuide() {
  return {
    title: "Quest capture transfer (documented — device collection unverified)",
    steps: [
      "Prefer PC VR / Editor Play Mode capture during W06 verification.",
      "On Quest builds (later): captures write under Application.persistentDataPath as HertzAnalytics_*.json.",
      "Pull files with Meta Quest Developer Hub file browser or USB MTP.",
      "Import the JSON in Studio → Analytics → Import capture (owner auth).",
      "Connector upload path: Editor bridge exports pending capture; connector POSTs /api/connector/analytics/upload.",
    ],
    notImplemented: [
      "Automatic always-on Quest cloud telemetry",
      "Public multiplayer stats",
      "Personal identifiers / account linking beyond owner Studio login",
    ],
  };
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function normalizeEvent(raw, index) {
  if (!raw || typeof raw !== "object") {
    const err = new Error(`events[${index}] must be an object`);
    err.code = "invalid_event";
    throw err;
  }
  const type = String(raw.type || "");
  if (!EVENT_TYPE_SET.has(type)) {
    const err = new Error(`events[${index}].type invalid: ${type}`);
    err.code = "invalid_event";
    throw err;
  }
  if (!isNonEmptyString(raw.eventId)) {
    const err = new Error(`events[${index}].eventId required`);
    err.code = "invalid_event";
    throw err;
  }
  if (!isNonEmptyString(raw.buildId)) {
    const err = new Error(`events[${index}].buildId required`);
    err.code = "invalid_event";
    throw err;
  }
  if (!isNonEmptyString(raw.sessionId)) {
    const err = new Error(`events[${index}].sessionId required`);
    err.code = "invalid_event";
    throw err;
  }
  if (!isNonEmptyString(raw.recordedAt)) {
    const err = new Error(`events[${index}].recordedAt required`);
    err.code = "invalid_event";
    throw err;
  }
  const recordedAt = new Date(raw.recordedAt);
  if (Number.isNaN(recordedAt.getTime())) {
    const err = new Error(`events[${index}].recordedAt must be ISO date`);
    err.code = "invalid_event";
    throw err;
  }

  const ev = {
    eventId: String(raw.eventId).trim(),
    type,
    buildId: String(raw.buildId).trim().slice(0, 80),
    sessionId: String(raw.sessionId).trim().slice(0, 80),
    recordedAt: recordedAt.toISOString(),
    levelId: raw.levelId != null && raw.levelId !== "" ? String(raw.levelId).slice(0, 80) : null,
    tMs: Number.isFinite(Number(raw.tMs)) ? Number(raw.tMs) : null,
    weaponId: raw.weaponId != null && raw.weaponId !== "" ? String(raw.weaponId).slice(0, 80) : null,
    weaponRole: raw.weaponRole != null && raw.weaponRole !== "" ? String(raw.weaponRole).slice(0, 40) : null,
    enemyId: raw.enemyId != null && raw.enemyId !== "" ? String(raw.enemyId).slice(0, 80) : null,
    frequencyActive: typeof raw.frequencyActive === "boolean" ? raw.frequencyActive : null,
    hit: typeof raw.hit === "boolean" ? raw.hit : null,
    damage: Number.isFinite(Number(raw.damage)) ? Number(raw.damage) : null,
    frameMs: Number.isFinite(Number(raw.frameMs)) ? Number(raw.frameMs) : null,
    completed: typeof raw.completed === "boolean" ? raw.completed : null,
    source: raw.source != null ? String(raw.source).slice(0, 40) : null,
  };
  return ev;
}

/**
 * Import a capture envelope. Dedupes by eventId across all prior imports.
 * Repeated import of the same events does not double-count.
 */
export function importCapture(body = {}, { dataDir = defaultDataDir(), source = "browser_import" } = {}) {
  const eventsIn = Array.isArray(body.events) ? body.events : null;
  if (!eventsIn) {
    const err = new Error("events array required");
    err.code = "invalid_capture";
    throw err;
  }
  if (eventsIn.length === 0) {
    const err = new Error("events array empty");
    err.code = "invalid_capture";
    throw err;
  }
  if (eventsIn.length > MAX_EVENTS_PER_CAPTURE) {
    const err = new Error(`events exceed max ${MAX_EVENTS_PER_CAPTURE}`);
    err.code = "payload_too_large";
    throw err;
  }

  const normalized = eventsIn.map((e, i) => normalizeEvent(e, i));
  const idx = loadIndex(dataDir);
  const seen = idx.seenEventIds || {};
  const accepted = [];
  let duplicateCount = 0;
  for (const ev of normalized) {
    if (seen[ev.eventId]) {
      duplicateCount += 1;
      continue;
    }
    seen[ev.eventId] = true;
    accepted.push(ev);
  }

  if (accepted.length === 0) {
    return {
      ok: true,
      captureId: null,
      imported: 0,
      duplicates: duplicateCount,
      message: "All events already imported (deduped).",
    };
  }

  const captureId = isNonEmptyString(body.captureId) ? String(body.captureId).trim() : randomUUID();
  const buildId = isNonEmptyString(body.buildId)
    ? String(body.buildId).trim()
    : accepted[0].buildId;
  const exportedAt = isNonEmptyString(body.exportedAt)
    ? new Date(body.exportedAt).toISOString()
    : new Date().toISOString();
  const payloadHash = createHash("sha256")
    .update(JSON.stringify(accepted.map((e) => e.eventId).sort()))
    .digest("hex");

  const capture = {
    captureId,
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    buildId,
    exportedAt,
    importedAt: new Date().toISOString(),
    source: body.source || source,
    eventCount: accepted.length,
    payloadHash,
    events: accepted,
  };

  writeJsonAtomic(capturePath(dataDir, captureId), capture);
  idx.seenEventIds = seen;
  idx.captures = [
    {
      captureId,
      buildId,
      importedAt: capture.importedAt,
      exportedAt,
      source: capture.source,
      eventCount: accepted.length,
      payloadHash,
      sessionIds: [...new Set(accepted.map((e) => e.sessionId))],
    },
    ...(idx.captures || []).filter((c) => c.captureId !== captureId),
  ].slice(0, MAX_CAPTURES_LIST);
  saveIndex(dataDir, idx);

  return {
    ok: true,
    captureId,
    imported: accepted.length,
    duplicates: duplicateCount,
    payloadHash,
  };
}

function loadAllEvents(dataDir, filters = {}) {
  const idx = loadIndex(dataDir);
  const events = [];
  for (const meta of idx.captures || []) {
    const file = capturePath(dataDir, meta.captureId);
    if (!fs.existsSync(file)) continue;
    const cap = readJsonSafe(file, null);
    if (!cap?.events) continue;
    for (const ev of cap.events) {
      if (filters.buildId && ev.buildId !== filters.buildId) continue;
      if (filters.levelId && ev.levelId !== filters.levelId) continue;
      if (filters.sessionId && ev.sessionId !== filters.sessionId) continue;
      if (filters.from) {
        if (new Date(ev.recordedAt).getTime() < new Date(filters.from).getTime()) continue;
      }
      if (filters.to) {
        if (new Date(ev.recordedAt).getTime() > new Date(filters.to).getTime()) continue;
      }
      events.push(ev);
    }
  }
  return events;
}

function buildSessionRows(events) {
  const bySession = new Map();
  for (const ev of events) {
    let row = bySession.get(ev.sessionId);
    if (!row) {
      row = {
        sessionId: ev.sessionId,
        buildId: ev.buildId,
        levelIds: new Set(),
        startedAt: null,
        endedAt: null,
        completed: false,
        shots: 0,
        hits: 0,
        frequencyFlips: 0,
        enemyDefeats: 0,
        frameSamples: [],
        eventCount: 0,
      };
      bySession.set(ev.sessionId, row);
    }
    row.eventCount += 1;
    if (ev.levelId) row.levelIds.add(ev.levelId);
    const t = new Date(ev.recordedAt).getTime();
    if (ev.type === "session_start") {
      row.startedAt = row.startedAt ? Math.min(row.startedAt, t) : t;
    }
    if (ev.type === "session_end") {
      row.endedAt = row.endedAt ? Math.max(row.endedAt, t) : t;
      if (ev.completed === true) row.completed = true;
    }
    if (ev.type === "level_end" && ev.completed === true) row.completed = true;
    if (ev.type === "shot") {
      row.shots += 1;
      if (ev.hit === true) row.hits += 1;
    } else if (ev.type === "hit") {
      // Standalone hit events (imports without shot.hit) still count.
      row.hits += 1;
    }
    if (ev.type === "frequency_flip") row.frequencyFlips += 1;
    if (ev.type === "enemy_defeat") row.enemyDefeats += 1;
    if (ev.type === "frame_sample" && Number.isFinite(ev.frameMs)) row.frameSamples.push(ev.frameMs);
    // track span even without explicit start/end
    row._minT = row._minT == null ? t : Math.min(row._minT, t);
    row._maxT = row._maxT == null ? t : Math.max(row._maxT, t);
  }

  return [...bySession.values()].map((row) => {
    const startedAt = row.startedAt ?? row._minT;
    const endedAt = row.endedAt ?? row._maxT;
    const durationMs =
      startedAt != null && endedAt != null && endedAt >= startedAt ? endedAt - startedAt : null;
    const incomplete = row.startedAt != null && row.endedAt == null;
    const samples = row.frameSamples;
    const frameAvgMs =
      samples.length > 0 ? samples.reduce((a, b) => a + b, 0) / samples.length : null;
    const accuracy =
      row.shots > 0 ? row.hits / row.shots : null;
    return {
      sessionId: row.sessionId,
      buildId: row.buildId,
      levelIds: [...row.levelIds],
      startedAt: startedAt != null ? new Date(startedAt).toISOString() : null,
      endedAt: endedAt != null ? new Date(endedAt).toISOString() : null,
      durationMs,
      completed: row.completed,
      incomplete,
      shots: row.shots,
      hits: row.hits,
      accuracy,
      frequencyFlips: row.frequencyFlips,
      enemyDefeats: row.enemyDefeats,
      frameSampleCount: samples.length,
      frameAvgMs,
      eventCount: row.eventCount,
    };
  });
}

export function listCaptures({ dataDir = defaultDataDir() } = {}) {
  const idx = loadIndex(dataDir);
  return {
    captures: idx.captures || [],
    captureCount: (idx.captures || []).length,
    uniqueEventIds: Object.keys(idx.seenEventIds || {}).length,
  };
}

export function summarizeAnalytics(filters = {}, { dataDir = defaultDataDir() } = {}) {
  const events = loadAllEvents(dataDir, filters);
  const sessions = buildSessionRows(events);
  const completeSessions = sessions.filter((s) => s.completed);
  const incompleteSessions = sessions.filter((s) => s.incomplete);
  const denomSessions = sessions.filter((s) => !s.incomplete || s.completed);
  const weaponUsage = {};
  for (const ev of events) {
    if (ev.type !== "shot" || !ev.weaponId) continue;
    const key = `${ev.weaponId}|${ev.weaponRole || ""}`;
    weaponUsage[key] = weaponUsage[key] || { weaponId: ev.weaponId, weaponRole: ev.weaponRole, shots: 0, hits: 0 };
    weaponUsage[key].shots += 1;
    if (ev.hit) weaponUsage[key].hits += 1;
  }
  const totalShots = sessions.reduce((n, s) => n + s.shots, 0);
  const totalHits = sessions.reduce((n, s) => n + s.hits, 0);
  const frameSamples = events.filter((e) => e.type === "frame_sample" && Number.isFinite(e.frameMs));
  const frameAvgMs =
    frameSamples.length > 0
      ? frameSamples.reduce((a, e) => a + e.frameMs, 0) / frameSamples.length
      : null;

  return {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    filters,
    sampleCounts: {
      events: events.length,
      sessions: sessions.length,
      completeSessions: completeSessions.length,
      incompleteSessions: incompleteSessions.length,
      denominatorSessions: denomSessions.length,
      frameSamples: frameSamples.length,
      captures: listCaptures({ dataDir }).captureCount,
    },
    sessions: {
      count: sessions.length,
      completedRate:
        denomSessions.length > 0 ? completeSessions.length / denomSessions.length : null,
      avgDurationMs:
        sessions.filter((s) => s.durationMs != null).length > 0
          ? sessions.filter((s) => s.durationMs != null).reduce((a, s) => a + s.durationMs, 0) /
            sessions.filter((s) => s.durationMs != null).length
          : null,
    },
    combat: {
      shots: totalShots,
      hits: totalHits,
      accuracy: totalShots > 0 ? totalHits / totalShots : null,
      enemyDefeats: sessions.reduce((n, s) => n + s.enemyDefeats, 0),
      frequencyFlips: sessions.reduce((n, s) => n + s.frequencyFlips, 0),
    },
    frameTime: {
      sampleCount: frameSamples.length,
      avgMs: frameAvgMs,
    },
    weaponUsage: Object.values(weaponUsage),
    builds: [...new Set(events.map((e) => e.buildId))],
    levels: [...new Set(events.map((e) => e.levelId).filter(Boolean))],
    note: "Aggregates only — raw event dump not included. Traceability via session list + import hashes.",
  };
}

export function listSessions(filters = {}, { dataDir = defaultDataDir(), page = 1, pageSize = 50 } = {}) {
  const events = loadAllEvents(dataDir, filters);
  const sessions = buildSessionRows(events).sort((a, b) =>
    String(b.startedAt || "").localeCompare(String(a.startedAt || "")),
  );
  const p = Math.max(1, Number(page) || 1);
  const ps = Math.min(100, Math.max(1, Number(pageSize) || 50));
  const start = (p - 1) * ps;
  return {
    total: sessions.length,
    page: p,
    pageSize: ps,
    sessions: sessions.slice(start, start + ps),
  };
}

export function exportAnalytics(filters = {}, { dataDir = defaultDataDir(), format = "json" } = {}) {
  const summary = summarizeAnalytics(filters, { dataDir });
  const sessions = listSessions(filters, { dataDir, page: 1, pageSize: 100 });
  if (format === "csv") {
    const header = [
      "sessionId",
      "buildId",
      "startedAt",
      "endedAt",
      "durationMs",
      "completed",
      "incomplete",
      "shots",
      "hits",
      "accuracy",
      "frequencyFlips",
      "enemyDefeats",
      "frameAvgMs",
      "eventCount",
    ];
    const lines = [header.join(",")];
    for (const s of sessions.sessions) {
      lines.push(
        [
          s.sessionId,
          s.buildId,
          s.startedAt || "",
          s.endedAt || "",
          s.durationMs ?? "",
          s.completed,
          s.incomplete,
          s.shots,
          s.hits,
          s.accuracy ?? "",
          s.frequencyFlips,
          s.enemyDefeats,
          s.frameAvgMs ?? "",
          s.eventCount,
        ]
          .map((v) => {
            const str = String(v);
            return str.includes(",") ? `"${str.replace(/"/g, '""')}"` : str;
          })
          .join(","),
      );
    }
    return {
      contentType: "text/csv; charset=utf-8",
      body: lines.join("\n") + "\n",
      filename: "hertz-analytics-sessions.csv",
    };
  }
  return {
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify({ summary, sessions: sessions.sessions }, null, 2) + "\n",
    filename: "hertz-analytics-export.json",
  };
}
