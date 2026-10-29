import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-w10-perf-"));
process.env.HERTZ_STUDIO_DATA = dataDir;

const performance = await import("./performance.mjs");

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("W10 performance vertical contracts", () => {
  it("rejects browser-claimed quest_device without importer provenance", () => {
    assert.throws(
      () =>
        performance.ingestPerformanceCapture({
          source: "quest_device",
          cpuFrameMs: 10,
          fps: 72,
          device: "Quest 3S",
        }),
      (e) => e.code === "quest_provenance_required",
    );
  });

  it("rejects fabricated static/editor posts — must use authoritative endpoints", () => {
    assert.throws(
      () => performance.ingestPerformanceCapture({ source: "unity_editor", cpuFrameMs: 10 }),
      (e) => e.code === "use_authoritative_endpoint",
    );
  });

  it("accepts browser_viewport separately labeled", () => {
    const br = performance.ingestPerformanceCapture({
      source: "browser_viewport",
      cpuFrameMs: 12,
      fps: 60,
    });
    assert.match(br.label, /Browser/i);
    assert.equal(br.source, "browser_viewport");
  });

  it("rejects malformed non-finite", () => {
    assert.throws(
      () =>
        performance.ingestPerformanceCapture({
          source: "browser_viewport",
          cpuFrameMs: Number.NaN,
        }),
      (e) => e.code === "malformed_capture",
    );
  });

  it("paginates", () => {
    for (let i = 0; i < 5; i++) {
      performance.ingestPerformanceCapture({
        source: "browser_viewport",
        cpuFrameMs: i,
        fps: 60,
      });
    }
    const page = performance.listPerformanceCaptures({ page: 1, pageSize: 2 });
    assert.equal(page.captures.length, 2);
  });

  it("static inspect fails closed offline", async () => {
    await assert.rejects(
      () => performance.runStaticProjectInspection({ scenePath: "Assets/Scenes/HertzStudioTest.unity" }),
      (e) => e.code === "unity_offline" || e.code === "unity_inspect_failed" || e.code === "protected_scene",
    );
  });
});
