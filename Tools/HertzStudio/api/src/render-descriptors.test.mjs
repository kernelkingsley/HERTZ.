import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDraftRenderDescriptors,
  describeAssetForBrowser,
  isLegacySceneExport,
  normalizeBrowserModelExt,
  rejectUnsafeAssetId,
} from "./render-descriptors.mjs";

const CAT_ID = "8e7aeace-df2b-40ba-842d-9a94e99e1e8f";

const armoredCatCatalogRecord = {
  id: CAT_ID,
  displayName: "Armored cat",
  entrypointFileName: "scene.gltf",
  fileFormat: "gltf",
  blobPath: `private/assets/${CAT_ID}.gltf`,
  assetType: "model_3d",
  state: "unity_imported",
  unity: {
    importedPath: `Assets/HertzStudio/Imported/${CAT_ID}/scene.gltf`,
    prefabPath: `Assets/HertzStudio/Imported/${CAT_ID}/Armored cat.prefab`,
    dependencies: [],
  },
};

function fixtureDeps(assetById, blobOkIds = new Set()) {
  return {
    getAsset: (id) => assetById[id] || null,
    getAssetBlobPath: (id) => (blobOkIds.has(id) ? `/virtual/blobs/${id}` : null),
  };
}

describe("render-descriptors", () => {
  it("rejects path traversal and invalid asset ids", () => {
    assert.equal(rejectUnsafeAssetId("../etc/passwd").ok, false);
    assert.equal(rejectUnsafeAssetId("not-a-uuid").ok, false);
    assert.equal(rejectUnsafeAssetId(CAT_ID).ok, true);
  });

  it("normalizes production catalog fields (entrypointFileName + fileFormat)", () => {
    assert.equal(normalizeBrowserModelExt(armoredCatCatalogRecord), ".gltf");
    assert.equal(normalizeBrowserModelExt({ fileFormat: "GLB" }), ".glb");
    assert.equal(normalizeBrowserModelExt({ entrypointFileName: "model.GLB" }), ".glb");
    assert.equal(normalizeBrowserModelExt({ blobPath: "private/assets/x.gltf" }), ".gltf");
    assert.equal(normalizeBrowserModelExt({ originalName: "legacy.glb" }), ".glb");
    assert.equal(normalizeBrowserModelExt({ fileFormat: "fbx" }), ".fbx");
  });

  it("recognizes Armored cat production schema as supported GLTF", () => {
    const deps = fixtureDeps({ [CAT_ID]: armoredCatCatalogRecord }, new Set([CAT_ID]));
    const d = describeAssetForBrowser(CAT_ID, deps);
    assert.equal(d.supported, true);
    assert.equal(d.status, "ready");
    assert.equal(d.format, "gltf");
    assert.equal(d.modelUrl, `/api/assets/${CAT_ID}/model`);
    assert.equal(d.dependencyBase, `/api/assets/${CAT_ID}/model-dep/`);
    assert.equal(d.fallbackReason, null);
  });

  it("supports FBX model_3d for browser preview descriptors", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const deps = fixtureDeps(
      {
        [id]: {
          id,
          displayName: "FBX prop",
          entrypointFileName: "prop.fbx",
          fileFormat: "fbx",
          assetType: "model_3d",
          state: "unity_imported",
        },
      },
      new Set([id]),
    );
    const d = describeAssetForBrowser(id, deps);
    assert.equal(d.supported, true);
    assert.equal(d.format, "fbx");
    assert.equal(d.modelUrl, `/api/assets/${id}/model`);
    assert.equal(d.fallbackReason, null);
  });

  it("returns unsupported for missing catalog assets and missing blobs", () => {
    const missing = describeAssetForBrowser("00000000-0000-4000-8000-000000000099", fixtureDeps({}, new Set()));
    assert.equal(missing.status, "missing");
    const noBlob = describeAssetForBrowser(CAT_ID, fixtureDeps({ [CAT_ID]: armoredCatCatalogRecord }, new Set()));
    assert.equal(noBlob.supported, false);
    assert.match(noBlob.fallbackReason, /blob missing/i);
  });

  it("deduplicates asset descriptors and marks child meshes as delegated", () => {
    const deps = fixtureDeps({ [CAT_ID]: armoredCatCatalogRecord }, new Set([CAT_ID]));
    const batch = buildDraftRenderDescriptors(
      [
        { objectId: "root", assetId: CAT_ID, renderRole: "model_root" },
        { objectId: "child", assetId: CAT_ID, renderRole: "mesh" },
        { objectId: "root2", assetId: CAT_ID, renderRole: "model_root" },
        { objectId: "empty", renderRole: "empty" },
      ],
      deps,
    );
    assert.equal(batch.assets.length, 1);
    assert.equal(batch.assets[0].supported, true);
    assert.equal(batch.objects.find((o) => o.objectId === "root").modelUrl, `/api/assets/${CAT_ID}/model`);
    assert.equal(batch.objects.find((o) => o.objectId === "child").status, "delegated_to_root");
    assert.equal(batch.objects.find((o) => o.objectId === "child").modelUrl, null);
    assert.equal(batch.objects.find((o) => o.objectId === "empty").supported, false);
  });

  it("never invents model urls for objects without assetId", () => {
    const batch = buildDraftRenderDescriptors([
      { objectId: "unity-only", renderRole: "unsupported", meshAssetPath: "Assets/Foo.fbx" },
    ]);
    assert.equal(batch.objects[0].modelUrl, null);
    assert.match(batch.objects[0].fallbackReason, /No Hertz assetId|native mesh snapshot/i);
  });

  it("attaches native mesh snapshot urls without exposing filesystem paths", () => {
    const batch = buildDraftRenderDescriptors(
      [{ objectId: "wall", renderRole: "mesh", renderCategory: "native_mesh" }],
      {
        renderSnapshot: {
          snapshotId: "abc123def456",
          meshes: [{ objectId: "wall", file: "meshes/m_deadbeef.hmsh", category: "native_mesh" }],
        },
      },
    );
    assert.equal(batch.objects[0].supported, true);
    assert.equal(batch.objects[0].sourceType, "native_snapshot");
    assert.equal(batch.objects[0].format, "hmsh1");
    assert.equal(batch.objects[0].modelUrl, "/api/render-snapshots/abc123def456/meshes/m_deadbeef.hmsh");
    assert.equal(batch.objects[0].modelUrl.includes("Assets/"), false);
  });

  it("detects legacy scene exports lacking provenance fields", () => {
    assert.equal(isLegacySceneExport(null), true);
    assert.equal(
      isLegacySceneExport({
        unityRevision: 4883,
        objects: [{ objectId: "a", name: "Armored cat", position: { x: 0, y: 0, z: 0 } }],
      }),
      true,
    );
    assert.equal(
      isLegacySceneExport({
        exportSchemaVersion: 2,
        objects: [{ objectId: "a", renderRole: "model_root", assetId: CAT_ID }],
      }),
      false,
    );
    assert.equal(
      isLegacySceneExport({
        exportSchemaVersion: 3,
        renderSnapshot: { snapshotId: "abc" },
        objects: [{ objectId: "a", renderRole: "mesh", renderCategory: "native_mesh" }],
      }),
      false,
    );
  });
});

describe("live catalog Armored cat (optional integration)", () => {
  it("describeAssetForBrowser supports the real catalog record when present", async () => {
    const { describeAssetForBrowser: liveDescribe } = await import("./render-descriptors.mjs");
    const d = liveDescribe(CAT_ID);
    if (d.status === "missing") {
      // Isolated CI without live catalog — skip soft.
      return;
    }
    assert.equal(d.supported, true);
    assert.equal(d.format, "gltf");
    assert.equal(d.modelUrl, `/api/assets/${CAT_ID}/model`);
  });
});
