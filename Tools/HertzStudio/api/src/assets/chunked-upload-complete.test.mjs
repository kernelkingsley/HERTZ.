/**
 * Regression: completeChunkedUpload must not overwrite ingestFile's catalog write.
 * Also covers repair of completed sessions whose assetId blob survives without a catalog row.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-chunked-complete-"));
process.env.HERTZ_STUDIO_DATA = dataDir;

const {
  initChunkedUpload,
  appendUploadChunk,
  completeChunkedUpload,
  getAsset,
  listAssets,
  loadCatalog,
  repairOrphanedCompletedUploads,
  sha256File,
} = await import("./catalog.mjs");

/** Minimal valid GLB (empty scene) for content validation. Unique generator notes change the hash. */
function writeTinyGlb(filePath, note = "a") {
  const json = Buffer.from(
    JSON.stringify({ asset: { version: "2.0", generator: `hertz-test-${note}` }, scenes: [{ nodes: [] }], nodes: [] }),
  );
  const jsonPad = (4 - (json.length % 4)) % 4;
  const jsonChunk = Buffer.concat([json, Buffer.alloc(jsonPad, 0x20)]);
  const binChunk = Buffer.alloc(0);
  const totalLength = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const out = Buffer.alloc(totalLength);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(totalLength, 8);
  let o = 12;
  out.writeUInt32LE(jsonChunk.length, o);
  out.writeUInt32LE(0x4e4f534a, o + 4);
  jsonChunk.copy(out, o + 8);
  o += 8 + jsonChunk.length;
  out.writeUInt32LE(binChunk.length, o);
  out.writeUInt32LE(0x004e4942, o + 4);
  fs.writeFileSync(filePath, out);
  return out;
}

test("completeChunkedUpload keeps ingested asset after completion write", () => {
  const src = path.join(dataDir, "weapon.glb");
  const bytes = writeTinyGlb(src, "weapon-1");
  const session = initChunkedUpload({
    fileName: "weapon.glb",
    byteSize: bytes.length,
  });
  appendUploadChunk(session.uploadId, bytes, 0);
  const result = completeChunkedUpload(session.uploadId, { provider: "upload", license: "uploaded" });
  assert.ok(result.asset?.id, "ingest must return asset id");
  const asset = getAsset(result.asset.id);
  assert.ok(asset, "asset must exist in catalog after complete");
  assert.match(asset.displayName, /weapon/i);
  const listed = listAssets({ q: "weapon", type: "model_3d" });
  assert.ok(listed.assets.some((a) => a.id === result.asset.id));
  const catalog = loadCatalog();
  assert.equal(catalog.uploads[session.uploadId]?.status, "completed");
  assert.equal(catalog.uploads[session.uploadId]?.assetId, result.asset.id);
  const blob = path.join(dataDir, "private", "assets", `${result.asset.id}.glb`);
  assert.ok(fs.existsSync(blob));
  assert.equal(sha256File(blob), asset.contentHash);
});

test("second identical complete dedupes without wiping first asset", () => {
  const src = path.join(dataDir, "dup.glb");
  const bytes = writeTinyGlb(src, "dup-shared");
  const s1 = initChunkedUpload({ fileName: "dup-a.glb", byteSize: bytes.length });
  appendUploadChunk(s1.uploadId, bytes, 0);
  const r1 = completeChunkedUpload(s1.uploadId, {});
  const s2 = initChunkedUpload({ fileName: "dup-b.glb", byteSize: bytes.length });
  appendUploadChunk(s2.uploadId, bytes, 0);
  const r2 = completeChunkedUpload(s2.uploadId, {});
  assert.equal(r2.deduplicated, true);
  assert.equal(r2.asset.id, r1.asset.id);
  assert.ok(getAsset(r1.asset.id));
  assert.equal(loadCatalog().uploads[s2.uploadId]?.assetId, r1.asset.id);
});

test("repairOrphanedCompletedUploads restores missing asset and collapses duplicate blobs", () => {
  const src = path.join(dataDir, "orphan.glb");
  const bytes = writeTinyGlb(src, "orphan-repair");
  const orphanId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const orphanId2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const blobDir = path.join(dataDir, "private", "assets");
  const previewDir = path.join(dataDir, "previews");
  fs.mkdirSync(blobDir, { recursive: true });
  fs.mkdirSync(previewDir, { recursive: true });
  fs.writeFileSync(path.join(blobDir, `${orphanId}.glb`), bytes);
  fs.writeFileSync(path.join(previewDir, `${orphanId}.glb`), bytes);
  fs.writeFileSync(path.join(blobDir, `${orphanId2}.glb`), bytes);
  fs.writeFileSync(path.join(previewDir, `${orphanId2}.glb`), bytes);

  const catalog = loadCatalog();
  catalog.uploads["upload-orphan-1"] = {
    id: "upload-orphan-1",
    fileName: "orphan.glb",
    byteSize: bytes.length,
    received: bytes.length,
    partDir: "tmp/uploads/chunk-x",
    status: "completed",
    assetId: orphanId,
    createdAt: "2026-10-24T20:00:00.000Z",
    completedAt: "2026-10-24T20:00:01.000Z",
  };
  catalog.uploads["upload-orphan-2"] = {
    id: "upload-orphan-2",
    fileName: "orphan.glb",
    byteSize: bytes.length,
    received: bytes.length,
    partDir: "tmp/uploads/chunk-y",
    status: "completed",
    assetId: orphanId2,
    createdAt: "2026-10-24T20:00:02.000Z",
    completedAt: "2026-10-24T20:00:03.000Z",
  };
  fs.writeFileSync(path.join(dataDir, "assets-catalog.json"), JSON.stringify(catalog, null, 2));

  const report = repairOrphanedCompletedUploads();
  assert.equal(report.restored.length, 1);
  assert.equal(report.restored[0].assetId, orphanId);
  assert.equal(report.relinked.length, 1);
  assert.equal(report.relinked[0].to, orphanId);
  assert.ok(getAsset(orphanId));
  assert.equal(getAsset(orphanId2), null);
  assert.ok(!fs.existsSync(path.join(blobDir, `${orphanId2}.glb`)));
  const after = loadCatalog();
  assert.equal(after.uploads["upload-orphan-2"].assetId, orphanId);
  assert.ok(listAssets({ q: "orphan" }).assets.some((a) => a.id === orphanId));
});
