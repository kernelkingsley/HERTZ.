import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-w11-snap-"));
process.env.HERTZ_STUDIO_DATA = dataDir;

const snapshots = await import("./snapshots.mjs");

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("W11 snapshots vertical contracts", () => {
  it("rejects caller-supplied entries/content", async () => {
    await assert.rejects(
      () =>
        snapshots.createNamedSnapshot({
          name: "bad",
          entries: [{ path: "Assets/HertzStudio/x.mat", content: "A" }],
        }),
      (e) => e.code === "caller_content_rejected",
    );
  });

  it("rejects SampleScene scenePath", async () => {
    await assert.rejects(
      () =>
        snapshots.createNamedSnapshot({
          name: "bad",
          scenePath: "Assets/Scenes/SampleScene.unity",
        }),
      (e) => e.code === "protected_scene",
    );
  });

  it("fails closed when Unity offline for real capture", async () => {
    await assert.rejects(
      () =>
        snapshots.createNamedSnapshot({
          name: "real",
          scenePath: "Assets/Scenes/HertzStudioTest.unity",
        }),
      (e) => e.code === "unity_offline" || e.code === "unity_capture_failed" || e.code === "empty_snapshot",
    );
  });
});
