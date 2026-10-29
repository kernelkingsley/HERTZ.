import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-w08-ph-"));
process.env.HERTZ_STUDIO_DATA = dataDir;

const polyhaven = await import("./polyhaven.mjs");

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("W08 polyhaven vertical", () => {
  it("rejects caller-supplied fileUrl on import and retired intent", async () => {
    await assert.rejects(
      () => polyhaven.startPolyHavenImport({ assetId: "rock", fileUrl: "https://evil.example/x.png" }),
      (e) => e.code === "caller_url_rejected",
    );
    assert.throws(
      () => polyhaven.recordPolyHavenDownloadIntent({ assetId: "rock", resolution: "1k", fileUrl: "https://evil.example/x" }),
      (e) => e.code === "caller_url_rejected",
    );
    assert.throws(
      () => polyhaven.recordPolyHavenDownloadIntent({ assetId: "rock", resolution: "1k" }),
      (e) => e.code === "intent_retired",
    );
  });

  it("selects download from provider files and rejects missing resolution", () => {
    const files = {
      "1k": {
        Diffuse: { png: { url: "https://cdn.example/diff.png", size: 100 } },
        nor_gl: { png: { url: "https://cdn.example/nor.png", size: 100 } },
      },
      "2k": {
        Diffuse: { png: { url: "https://cdn.example/diff2.png", size: 200 } },
      },
    };
    const sel = polyhaven.selectPolyHavenDownload(files, { type: "textures", resolution: "1k" });
    assert.equal(sel.url, "https://cdn.example/diff.png");
    assert.equal(sel.map, "Diffuse");
    assert.throws(
      () => polyhaven.selectPolyHavenDownload(files, { type: "textures", resolution: "8k" }),
      (e) => e.code === "unavailable_resolution",
    );
  });

  it("selects HDRI hdr/exr urls", () => {
    const files = {
      "1k": {
        hdr: { url: "https://cdn.example/sky.hdr", size: 50 },
        exr: { url: "https://cdn.example/sky.exr", size: 60 },
      },
    };
    const sel = polyhaven.selectPolyHavenDownload(files, { type: "hdris", resolution: "1k" });
    assert.match(sel.url, /sky\.hdr/);
  });
});
