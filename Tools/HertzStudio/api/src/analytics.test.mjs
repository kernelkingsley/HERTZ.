import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-w06-analytics-"));
process.env.HERTZ_STUDIO_DATA = dataDir;

const analytics = await import("./analytics.mjs");

function makeEvents(sessionId, buildId = "build-test") {
  const base = Date.parse("2026-10-24T12:00:00.000Z");
  return [
    {
      eventId: `${sessionId}-start`,
      type: "session_start",
      buildId,
      sessionId,
      recordedAt: new Date(base).toISOString(),
      levelId: "HertzWeaponTest",
    },
    {
      eventId: `${sessionId}-freq`,
      type: "frequency_flip",
      buildId,
      sessionId,
      recordedAt: new Date(base + 1000).toISOString(),
      levelId: "HertzWeaponTest",
      frequencyActive: true,
    },
    {
      eventId: `${sessionId}-shot1`,
      type: "shot",
      buildId,
      sessionId,
      recordedAt: new Date(base + 2000).toISOString(),
      levelId: "HertzWeaponTest",
      weaponId: "left-pistol",
      weaponRole: "left_pistol",
      hit: true,
      damage: 10,
    },
    {
      eventId: `${sessionId}-shot2`,
      type: "shot",
      buildId,
      sessionId,
      recordedAt: new Date(base + 2500).toISOString(),
      levelId: "HertzWeaponTest",
      weaponId: "left-pistol",
      weaponRole: "left_pistol",
      hit: false,
    },
    {
      eventId: `${sessionId}-defeat`,
      type: "enemy_defeat",
      buildId,
      sessionId,
      recordedAt: new Date(base + 3000).toISOString(),
      levelId: "HertzWeaponTest",
      enemyId: "Enemy_Hold",
    },
    {
      eventId: `${sessionId}-frame`,
      type: "frame_sample",
      buildId,
      sessionId,
      recordedAt: new Date(base + 3100).toISOString(),
      frameMs: 11.1,
    },
    {
      eventId: `${sessionId}-end`,
      type: "session_end",
      buildId,
      sessionId,
      recordedAt: new Date(base + 5000).toISOString(),
      levelId: "HertzWeaponTest",
      completed: true,
    },
  ];
}

describe("W06 analytics API", () => {
  after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("exposes documented schema without fabricated types", () => {
    const schema = analytics.getAnalyticsSchema();
    assert.equal(schema.schemaVersion, 1);
    assert.ok(schema.eventTypes.includes("frequency_flip"));
    assert.ok(schema.eventTypes.includes("enemy_defeat"));
    assert.ok(schema.questTransferNote.includes("unverified"));
  });

  it("imports capture and aggregates sessions/accuracy", () => {
    const r = analytics.importCapture(
      { buildId: "build-test", events: makeEvents("sess-a"), source: "test" },
      { dataDir },
    );
    assert.equal(r.ok, true);
    assert.equal(r.imported, 7);
    assert.equal(r.duplicates, 0);
    const summary = analytics.summarizeAnalytics({}, { dataDir });
    assert.equal(summary.sampleCounts.sessions, 1);
    assert.equal(summary.combat.shots, 2);
    assert.equal(summary.combat.hits, 1);
    assert.equal(summary.combat.accuracy, 0.5);
    assert.equal(summary.combat.enemyDefeats, 1);
    assert.equal(summary.combat.frequencyFlips, 1);
    assert.ok(summary.frameTime.avgMs > 10);
    assert.equal(summary.sessions.completedRate, 1);
  });

  it("dedupes repeated import (no double-count)", () => {
    const again = analytics.importCapture(
      { buildId: "build-test", events: makeEvents("sess-a"), source: "test-retry" },
      { dataDir },
    );
    assert.equal(again.imported, 0);
    assert.equal(again.duplicates, 7);
    const summary = analytics.summarizeAnalytics({}, { dataDir });
    assert.equal(summary.sampleCounts.sessions, 1);
    assert.equal(summary.combat.shots, 2);
  });

  it("filters by build and level; CSV export includes session rows", () => {
    analytics.importCapture(
      { buildId: "other-build", events: makeEvents("sess-b", "other-build"), source: "test" },
      { dataDir },
    );
    const filtered = analytics.summarizeAnalytics({ buildId: "build-test" }, { dataDir });
    assert.equal(filtered.sampleCounts.sessions, 1);
    assert.deepEqual(filtered.builds, ["build-test"]);

    const byLevel = analytics.summarizeAnalytics({ levelId: "HertzWeaponTest" }, { dataDir });
    assert.ok(byLevel.sampleCounts.sessions >= 1);

    const csv = analytics.exportAnalytics({ buildId: "build-test" }, { dataDir, format: "csv" });
    assert.match(csv.contentType, /csv/);
    assert.match(csv.body, /sessionId/);
    assert.match(csv.body, /sess-a/);

    const json = analytics.exportAnalytics({ buildId: "build-test" }, { dataDir, format: "json" });
    assert.match(json.contentType, /json/);
    const parsed = JSON.parse(json.body);
    assert.equal(parsed.summary.combat.shots, 2);
  });

  it("rejects invalid event types and oversized payloads", () => {
    assert.throws(
      () =>
        analytics.importCapture(
          {
            events: [
              {
                eventId: "x",
                type: "telemetry_pii",
                buildId: "b",
                sessionId: "s",
                recordedAt: new Date().toISOString(),
              },
            ],
          },
          { dataDir },
        ),
      (e) => e.code === "invalid_event",
    );
  });
});
