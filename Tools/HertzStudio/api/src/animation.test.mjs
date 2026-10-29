import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-w09-anim-"));
process.env.HERTZ_STUDIO_DATA = dataDir;

const animation = await import("./animation.mjs");

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("W09 animation vertical contracts", () => {
  it("documents Mixamo honesty", () => {
    const s = animation.listAnimationSlots();
    assert.ok(s.openMixamoUrl.includes("mixamo"));
    assert.match(s.workflow, /does not automate/i);
    assert.match(s.workflow, /Unity/i);
  });

  it("requires Asset Library assetId — refuses metadata-only invent", () => {
    assert.throws(
      () =>
        animation.recordMixamoImportMeta({
          filename: "Idle.fbx",
          humanoidValid: true,
          clipNames: ["Idle"],
        }),
      (e) => e.code === "invalid_request",
    );
  });

  it("assignment requires a real saved character before Unity and ignores posted validation claims", async () => {
    await assert.rejects(
      () =>
        animation.assignAnimationSlot({
          characterId: "enemy_basic",
          slot: "idle",
          clipName: "Idle",
          humanoidValid: true,
          affectsTrackedXr: false,
        }),
      (e) => e.code === "unknown_character",
    );
  });
});
