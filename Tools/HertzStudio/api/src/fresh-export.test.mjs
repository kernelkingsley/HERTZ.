import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cachedExportMatchesForceRequest,
  captureExportBaseline,
  createForceExportRequest,
  exportSatisfiesForceRequest,
} from "./fresh-export.mjs";

describe("fresh-export handshake", () => {
  const baseline = {
    exportedAt: "2026-10-23T20:00:00.000Z",
    contentFingerprint: "fp-old",
    unityRevision: 100,
    exportGeneration: 5,
    importGeneration: 5,
    scenePath: "Assets/Scenes/HertzStudioTest.unity",
  };

  it("cached schema-2 export does not satisfy a newer refresh request", () => {
    const pending = createForceExportRequest("owner_sync_rebase", baseline, {
      requestId: "req-1",
      now: () => "2026-10-23T21:00:00.000Z",
    });
    const staleCache = {
      exportSchemaVersion: 3,
      forceExportRequestId: null,
      importGeneration: 5,
      scenePath: baseline.scenePath,
      exportedAt: "2026-10-23T20:00:00.000Z",
      contentFingerprint: "fp-old",
    };
    assert.equal(cachedExportMatchesForceRequest(pending, staleCache), false);
  });

  it("matching request ID with newer generation completes the request", () => {
    const pending = createForceExportRequest("owner_sync_rebase", baseline, {
      requestId: "req-ok",
      now: () => "2026-10-23T21:00:00.000Z",
    });
    const snap = {
      exportSchemaVersion: 3,
      forceExportRequestId: "req-ok",
      scenePath: baseline.scenePath,
      contentFingerprint: "fp-new",
    };
    const result = exportSatisfiesForceRequest(pending, snap, {
      importGeneration: 6,
      importedAt: "2026-10-23T21:00:01.000Z",
    });
    assert.equal(result.ok, true);
    assert.equal(
      cachedExportMatchesForceRequest(pending, {
        ...snap,
        importGeneration: 6,
        exportedAt: "2026-10-23T21:00:01.000Z",
      }),
      true,
    );
  });

  it("stale request acknowledgement is ignored", () => {
    const pending = createForceExportRequest("owner_sync_rebase", baseline, {
      requestId: "req-current",
      now: () => "2026-10-23T21:00:00.000Z",
    });
    const result = exportSatisfiesForceRequest(
      pending,
      {
        exportSchemaVersion: 3,
        forceExportRequestId: "req-stale",
        scenePath: baseline.scenePath,
      },
      { importGeneration: 99, importedAt: "2026-10-23T21:00:02.000Z" },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "request_id_mismatch");
  });

  it("wrong scene is rejected", () => {
    const pending = createForceExportRequest("owner_sync_rebase", baseline, {
      requestId: "req-scene",
      now: () => "2026-10-23T21:00:00.000Z",
    });
    const result = exportSatisfiesForceRequest(
      pending,
      {
        exportSchemaVersion: 3,
        forceExportRequestId: "req-scene",
        scenePath: "Assets/Scenes/SampleScene.unity",
      },
      { importGeneration: 6, importedAt: "2026-10-23T21:00:01.000Z" },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "scene_mismatch");
  });

  it("same generation does not complete even with matching request id", () => {
    const pending = createForceExportRequest("owner_sync_rebase", baseline, {
      requestId: "req-gen",
      now: () => "2026-10-23T21:00:00.000Z",
    });
    const result = exportSatisfiesForceRequest(
      pending,
      {
        exportSchemaVersion: 3,
        forceExportRequestId: "req-gen",
        scenePath: baseline.scenePath,
      },
      { importGeneration: 5, importedAt: "2026-10-23T21:00:01.000Z" },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "generation_not_newer");
  });

  it("captureExportBaseline reads last export and project fallbacks", () => {
    const captured = captureExportBaseline(
      {
        exportedAt: "t1",
        contentFingerprint: "fp",
        unityRevision: 3,
        exportGeneration: 2,
        importGeneration: 2,
        scenePath: "Assets/A.unity",
      },
      { unityRevision: 9, scenePath: "Assets/B.unity" },
    );
    assert.equal(captured.importGeneration, 2);
    assert.equal(captured.scenePath, "Assets/A.unity");
    assert.equal(captureExportBaseline(null, { scenePath: "Assets/B.unity" }).scenePath, "Assets/B.unity");
  });
});
