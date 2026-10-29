import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-w12-enc-"));
process.env.HERTZ_STUDIO_DATA = dataDir;

const encounters = await import("./encounters.mjs");

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("W12 encounters vertical contracts", () => {
  it("allows SampleScene identity and still requires an authoritative Unity revision", async () => {
    await assert.rejects(
      () =>
        encounters.upsertEncounter({
          scenePath: "Assets/Scenes/SampleScene.unity",
          spawns: [{ delaySeconds: 0, count: 1, enemyProfileId: "e" }],
        }),
      (e) => e.code === "revision_required",
    );
    await assert.rejects(
      () =>
        encounters.upsertEncounter({
          scenePath: "Assets/Scenes/HertzStudioTest.unity",
          spawns: [{ delaySeconds: 0, count: 1, enemyProfileId: "e" }],
        }),
      (e) => e.code === "revision_required",
    );
  });

  it("rejects invalid timing before Unity", async () => {
    await assert.rejects(
      () =>
        encounters.upsertEncounter({
          scenePath: "Assets/Scenes/HertzStudioTest.unity",
          expectedUnityRevision: 1,
          spawns: [{ delaySeconds: -1, count: 1, enemyProfileId: "e" }],
        }),
      (e) => e.code === "invalid_timing",
    );
  });

  it("requires references", async () => {
    await assert.rejects(
      () =>
        encounters.upsertEncounter({
          scenePath: "Assets/Scenes/HertzStudioTest.unity",
          expectedUnityRevision: 1,
          spawns: [{ delaySeconds: 0, count: 1 }],
        }),
      (e) => e.code === "missing_reference",
    );
  });

  it("rejects unknown or unsynced profiles before contacting Unity", async () => {
    await assert.rejects(
      () =>
        encounters.upsertEncounter({
          scenePath: "Assets/Scenes/HertzStudioTest.unity",
          expectedUnityRevision: 1,
          spawns: [{ delaySeconds: 0, count: 1, enemyProfileId: "enemy_basic" }],
        }),
      (e) => e.code === "missing_reference",
    );
  });
});
