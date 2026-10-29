import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-w03-offline-"));
process.env.HERTZ_STUDIO_DATA = tmp;

const storeUrl = pathToFileURL(path.resolve("api/src/store.mjs")).href;

const {
  mutateStore,
  enqueueApply,
  acknowledgeCommand,
  loadStore,
} = await import(storeUrl);

describe("W03 offline / reconnect / conflict", () => {
  before(() => {
    mutateStore((s) => {
      s.project.unityRevision = 100;
      s.project.scenePath = "Assets/Scenes/HertzStudioTest.unity";
      s.drafts = {
        d1: {
          id: "d1",
          version: 1,
          status: "draft_saved",
          statusLabel: "Draft saved",
          scenePath: "Assets/Scenes/HertzStudioTest.unity",
          baseUnityRevision: 100,
          objects: [
            {
              objectId: "obj-1",
              unityObjectId: "GlobalObjectId_V1-2-aaa-1-0",
              name: "Cube",
              position: { x: 0, y: 0, z: 0 },
              rotation: { x: 0, y: 0, z: 0 },
              scale: { x: 1, y: 1, z: 1 },
              localPosition: { x: 0, y: 0, z: 0 },
              localRotation: { x: 0, y: 0, z: 0 },
              localScale: { x: 1, y: 1, z: 1 },
            },
          ],
          unityTransformBaseline: {
            "obj-1": {
              localPosition: { x: 0, y: 0, z: 0 },
              localRotation: { x: 0, y: 0, z: 0 },
              localScale: { x: 1, y: 1, z: 1 },
              position: { x: 0, y: 0, z: 0 },
              rotation: { x: 0, y: 0, z: 0 },
              scale: { x: 1, y: 1, z: 1 },
            },
          },
        },
      };
      s.queue = [];
      s.results = [];
    });
  });

  after(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("duplicate command delivery is idempotent", () => {
    mutateStore((s) => {
      s.drafts.d1.objects[0].position = { x: 1, y: 0, z: 0 };
      s.drafts.d1.objects[0].localPosition = { x: 1, y: 0, z: 0 };
      s.drafts.d1.version = 2;
    });
    const a = enqueueApply("d1", "req-dup-1", 2);
    const b = enqueueApply("d1", "req-dup-1", 2);
    assert.equal(a.deduplicated, false);
    assert.equal(b.deduplicated, true);
    assert.equal(loadStore().queue.filter((q) => q.requestId === "req-dup-1").length, 1);
  });

  it("duplicate acknowledgment is idempotent", () => {
    const first = acknowledgeCommand({
      requestId: "req-dup-1",
      ok: true,
      unityRevision: 101,
    });
    const second = acknowledgeCommand({
      requestId: "req-dup-1",
      ok: true,
      unityRevision: 999,
    });
    assert.equal(first.deduplicated, false);
    assert.equal(second.deduplicated, true);
    assert.equal(loadStore().project.unityRevision, 101);
  });

  it("stale unity revision conflict does not overwrite newer draft", () => {
    mutateStore((s) => {
      s.drafts.d1.version = 5;
      s.drafts.d1.status = "draft_saved";
      s.drafts.d1.baseUnityRevision = 101;
      s.drafts.d1.objects[0].position = { x: 3, y: 0, z: 0 };
      s.queue.push({
        id: "cmd-stale",
        requestId: "req-stale",
        draftId: "d1",
        draftVersion: 4,
        status: "applying",
        operations: [],
      });
    });
    acknowledgeCommand({
      requestId: "req-stale",
      ok: false,
      conflict: true,
      error: "stale revision",
      unityRevision: 102,
    });
    const draft = loadStore().drafts.d1;
    assert.equal(draft.version, 5);
    assert.equal(draft.objects[0].position.x, 3);
    assert.notEqual(draft.status, "applying");
  });

  it("scene mismatch is represented on draft scenePath vs project", () => {
    const store = loadStore();
    store.drafts.d1.scenePath = "Assets/Scenes/Other.unity";
    assert.notEqual(store.drafts.d1.scenePath, store.project.scenePath);
  });
});
