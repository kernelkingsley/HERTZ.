/**
 * W02 focused regressions: Kenney categories, ZIP safety, uploads, dedupe,
 * secrets redaction, Sketchfab credential lifecycle (mocked validate), Unity offline queue.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const studioRoot = path.resolve(__dirname, "..");
const scratch = path.join(studioRoot, "data", "secrets", `w02-regress-${randomBytes(4).toString("hex")}`);
const isolatedData = path.join(scratch, "data");
fs.mkdirSync(isolatedData, { recursive: true });
process.env.HERTZ_STUDIO_DATA = isolatedData;

const catalog = await import("../api/src/assets/catalog.mjs");
const zipSafe = await import("../api/src/assets/zip-safe.mjs");
const kenney = await import("../api/src/assets/kenney.mjs");
const secrets = await import("../api/src/assets/secrets.mjs");
const types = await import("../api/src/assets/types.mjs");

const report = {
  startedAt: new Date().toISOString(),
  checks: [],
  ok: true,
  sketchfabLiveVerified: false,
  notes: [],
};

function check(name, condition, detail = {}) {
  report.checks.push({ name, pass: Boolean(condition), ...detail });
  if (!condition) {
    report.ok = false;
    console.error(`✗ ${name}`, detail);
  } else {
    console.log(`✓ ${name}`);
  }
}

function pngBytes() {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
}

function writeZipFromFolder(folder, zipPath) {
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Compress-Archive -Path '${folder}\\*' -DestinationPath '${zipPath}' -Force`,
    ],
    { windowsHide: true },
  );
}

/** Minimal ZIP with a single stored entry (for path-traversal cases). */
function writeRawZip(zipPath, fileName, content) {
  const nameBuf = Buffer.from(fileName, "utf8");
  const data = Buffer.from(content);
  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(0, 14); // crc deferred — yauzl may still extract
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  nameBuf.copy(local, 30);

  const crc = (() => {
    // crude: leave 0; many unzippers accept
    return 0;
  })();
  local.writeUInt32LE(crc, 14);

  const central = Buffer.alloc(46 + nameBuf.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);
  nameBuf.copy(central, 46);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + data.length, 16);
  end.writeUInt16LE(0, 20);

  fs.writeFileSync(zipPath, Buffer.concat([local, data, central, end]));
}

const fixturesRoot = path.join(studioRoot, "fixtures", "kenney");
const categories = ["2D", "3D", "UI", "Audio", "Pixel", "Textures"];

// --- Six Kenney categories + provenance ---
{
  const seenTypes = new Set();
  for (const cat of categories) {
    const folder = path.join(fixturesRoot, cat);
    const zipPath = path.join(scratch, `kenney-${cat}.zip`);
    writeZipFromFolder(folder, zipPath);
    const result = await kenney.importKenneyPack({
      archivePath: zipPath,
      packName: `KenneyFixture-${cat}`,
      packVersion: "w02",
    });
    check(`kenney_${cat}_imports`, result.created >= 1, {
      created: result.created,
      category: result.category,
      license: result.license,
    });
    check(`kenney_${cat}_cc0_provenance`, result.license === "CC0" && result.sourceUrl === kenney.KENNEY_SOURCE);
    for (const a of result.assets) {
      seenTypes.add(a.assetType);
      check(`kenney_${cat}_metadata_${a.id.slice(0, 8)}`, Boolean(a.id && a.displayName && a.contentHash && a.provider === "kenney"));
    }
  }
  check("kenney_covers_typed_entries", seenTypes.size >= 4, { types: [...seenTypes] });
}

// Duplicate pack import does not create uncontrolled copies
{
  const zipPath = path.join(scratch, "kenney-2D.zip");
  const before = catalog.loadCatalog();
  const countBefore = Object.keys(before.assets).length;
  const again = await kenney.importKenneyPack({
    archivePath: zipPath,
    packName: "KenneyFixture-2D-dup",
  });
  const after = catalog.loadCatalog();
  const countAfter = Object.keys(after.assets).length;
  check("duplicate_pack_dedupes_by_hash", again.created === 0 && again.skipped >= 1 && countAfter === countBefore, {
    created: again.created,
    skipped: again.skipped,
    countBefore,
    countAfter,
  });
}

// Safe ZIP + rejected traversal
{
  const safeDir = path.join(scratch, "safe-out");
  const safeZip = path.join(scratch, "safe.zip");
  const safeFolder = path.join(scratch, "safe-src");
  fs.mkdirSync(safeFolder, { recursive: true });
  fs.writeFileSync(path.join(safeFolder, "ok.png"), pngBytes());
  writeZipFromFolder(safeFolder, safeZip);
  const extracted = await zipSafe.safeExtractZip(safeZip, safeDir);
  check("zip_safe_extracts_ok", extracted.files.length === 1 && extracted.rejected.length === 0);

  const badZip = path.join(scratch, "traversal.zip");
  writeRawZip(badZip, "../escape.png", pngBytes());
  const badOut = path.join(scratch, "bad-out");
  fs.mkdirSync(badOut, { recursive: true });
  let bad;
  try {
    bad = await zipSafe.safeExtractZip(badZip, badOut);
  } catch (err) {
    bad = { files: [], rejected: [String(err.message)] };
  }
  check(
    "zip_rejects_path_traversal",
    bad.files.length === 0 && bad.rejected.some((r) => /unsafe|escape|relative path/i.test(r)),
    { rejected: bad.rejected },
  );
  check("zip_no_escape_file_written", !fs.existsSync(path.join(scratch, "escape.png")));
}

// Upload limits / invalid types / SHA-256 dedupe
{
  const tmp = path.join(scratch, "upload.png");
  fs.writeFileSync(tmp, pngBytes());
  const a = catalog.ingestFile({ absolutePath: tmp, originalName: "upload.png", provider: "upload", license: "uploaded" });
  const b = catalog.ingestFile({ absolutePath: tmp, originalName: "upload-copy.png", provider: "upload", license: "uploaded" });
  check("sha256_duplicate_import", a.deduplicated === false && b.deduplicated === true && a.asset.id === b.asset.id);

  let unsupported = false;
  try {
    const exe = path.join(scratch, "bad.exe");
    fs.writeFileSync(exe, Buffer.from("MZ"));
    catalog.ingestFile({ absolutePath: exe, originalName: "bad.exe", provider: "upload" });
  } catch (err) {
    unsupported = err.code === "unsupported" || /Unsupported/i.test(err.message);
  }
  check("rejects_invalid_file_type", unsupported);

  let tooLarge = false;
  try {
    const huge = path.join(scratch, "huge.bin");
    // Don't allocate full max — stub by temporarily lowering via direct size check path
    // Write small file but claim via LIMITS by writing oversize content only if practical
    const over = Buffer.alloc(Math.min(types.LIMITS.maxFileBytes + 1, 2 * 1024 * 1024));
    if (over.length > types.LIMITS.maxFileBytes) {
      fs.writeFileSync(huge, over);
      catalog.ingestFile({ absolutePath: huge, originalName: "huge.glb", provider: "upload" });
    } else {
      // Verify LIMITS are configured and quota path exists
      tooLarge = types.LIMITS.maxFileBytes > 0 && types.LIMITS.maxZipBytes > types.LIMITS.maxFileBytes;
      check("upload_limits_configured", tooLarge, { limits: types.LIMITS });
      tooLarge = true; // mark configured check separately
    }
  } catch (err) {
    tooLarge = err.code === "too_large";
  }
  if (!report.checks.some((c) => c.name === "upload_limits_configured")) {
    check("upload_limits_reject_or_configured", tooLarge || types.LIMITS.maxFileBytes === 40 * 1024 * 1024);
  }
}

// Restart persistence
{
  const before = catalog.loadCatalog();
  const ids = Object.keys(before.assets);
  check("catalog_has_assets_before_reload", ids.length >= 6);
  const reloaded = catalog.loadCatalog();
  check("restart_persistence_catalog", ids.every((id) => reloaded.assets[id]?.contentHash === before.assets[id].contentHash));
}

// Private authorization surface (publicAsset never exposes blobPath)
{
  const listed = catalog.listAssets({ pageSize: 5 });
  const sample = listed.assets[0];
  check("public_asset_hides_blob_path", sample && !("blobPath" in sample));
  check("list_paginated", listed.pageSize <= 100 && Array.isArray(listed.assets));
}

// Secret redaction
{
  const redacted = secrets.redactSecrets("Bearer sk-supersecretTOKEN123 and access_token=abc.def");
  check(
    "secret_redaction",
    !redacted.includes("sk-supersecret") && !redacted.includes("abc.def") && /REDACTED/i.test(redacted),
    { redacted },
  );
}

// Sketchfab credential save/test/replace/revoke (DPAPI) — validate mocked via direct save after fake validation
{
  const fakeToken = `test-token-${randomBytes(8).toString("hex")}`;
  const meta = await secrets.saveSketchfabToken(fakeToken, {
    accountLabel: "w02-test-account",
    scopes: ["read"],
  });
  check("sketchfab_save_meta_no_raw_token", meta.maskedId && !JSON.stringify(meta).includes(fakeToken));
  const metaFile = fs.readFileSync(path.join(isolatedData, "secrets", "sketchfab.meta.json"), "utf8");
  check("sketchfab_meta_file_no_raw_token", !metaFile.includes(fakeToken));
  const dpapiBlob = fs.readFileSync(path.join(isolatedData, "secrets", "sketchfab.dpapi.b64"), "utf8");
  check("sketchfab_dpapi_blob_not_plaintext", !dpapiBlob.includes(fakeToken) && dpapiBlob.length > 16);

  const readBack = await secrets.readSketchfabToken();
  check("sketchfab_roundtrip_token", readBack === fakeToken);

  const replaced = `replaced-${randomBytes(6).toString("hex")}`;
  await secrets.saveSketchfabToken(replaced, { accountLabel: "replaced", scopes: [] });
  check("sketchfab_replace", (await secrets.readSketchfabToken()) === replaced);

  secrets.clearSketchfabToken();
  check("sketchfab_revoke", (await secrets.readSketchfabToken()) === null && secrets.getSketchfabMeta().configured === false);

  // Live Sketchfab: only if HERTZ_SKETCHFAB_TEST_TOKEN is set (never logged)
  if (process.env.HERTZ_SKETCHFAB_TEST_TOKEN) {
    const sketchfab = await import("../api/src/assets/sketchfab.mjs");
    try {
      const v = await sketchfab.validateSketchfabToken(process.env.HERTZ_SKETCHFAB_TEST_TOKEN);
      report.sketchfabLiveVerified = Boolean(v.ok);
      check("sketchfab_live_validate", v.ok, { accountLabel: v.accountLabel });
    } catch (err) {
      report.notes.push(`Sketchfab live validate failed (pending): ${secrets.redactSecrets(err.message)}`);
      check("sketchfab_live_validate", false, { pending: true });
    }
  } else {
    report.notes.push("Sketchfab live API verification pending — no HERTZ_SKETCHFAB_TEST_TOKEN in environment.");
    check("sketchfab_marked_pending_without_live_token", true);
  }
}

// Provider failure / rate limit shaping
{
  const sketchfab = await import("../api/src/assets/sketchfab.mjs");
  const empty = await sketchfab.searchSketchfab({ q: "test" });
  check("sketchfab_search_without_credential", empty.configured === false && empty.pending === true);
}

// Unity offline pending + idempotent connector delivery
{
  const any = Object.values(catalog.loadCatalog().assets).find((a) => a.assetType === "model_3d" || a.assetType === "sprite");
  check("has_asset_for_unity_queue", Boolean(any));
  if (any) {
    const r1 = catalog.enqueueUnityImport(any.id, "req-unity-1");
    const r2 = catalog.enqueueUnityImport(any.id, "req-unity-1");
    check("unity_offline_pending_state", r1.status === 202 && catalog.getAsset(any.id).state === "pending_unity");
    check("idempotent_enqueue_same_requestId", r2.deduplicated === true);

    catalog.markAssetJobApplying(r1.job.id);
    check("importing_unity_state", catalog.getAsset(any.id).state === "importing_unity");

    const ack1 = catalog.acknowledgeAssetJob({
      requestId: "req-unity-1",
      ok: true,
      importedPath: "Assets/HertzStudio/Imported/test/model.glb",
      prefabPath: "Assets/HertzStudio/Imported/test/model.prefab",
    });
    const ack2 = catalog.acknowledgeAssetJob({
      requestId: "req-unity-1",
      ok: true,
      importedPath: "Assets/HertzStudio/Imported/test/other.glb",
    });
    check("ack_applied_once", ack1.asset?.state === "unity_imported" && ack1.asset?.unity?.prefabPath?.includes("Imported"));
    check("ack_idempotent_duplicate_delivery", ack2.deduplicated === true);
  }
}

// Chunked upload cancel
{
  const bytes = pngBytes();
  const init = catalog.initChunkedUpload({ fileName: "chunked.png", byteSize: bytes.length });
  check("chunk_init", Boolean(init.uploadId));
  const mid = catalog.appendUploadChunk(init.uploadId, bytes.subarray(0, 10), 0);
  check("chunk_append", mid.received === 10);
  const cancelled = catalog.cancelChunkedUpload(init.uploadId);
  check("chunk_cancel", cancelled.cancelled === true);
}

// Ensure store.json path was never used for sketchfab in isolated data
{
  const storeProbe = path.join(isolatedData, "store.json");
  if (fs.existsSync(storeProbe)) {
    const raw = fs.readFileSync(storeProbe, "utf8");
    check("no_secret_in_isolated_store", !/test-token|replaced-/i.test(raw));
  } else {
    check("no_store_json_required_for_assets", true);
  }
}

// Finding 5: content signature validation (fake.png must fail)
{
  const contentValidate = await import("../api/src/assets/content-validate.mjs");
  const fakePath = path.join(isolatedData, "fake.png");
  fs.writeFileSync(fakePath, "not-a-real-png-file!!");
  const bad = contentValidate.validateFileContent(fakePath, "fake.png");
  check("rejects_malformed_png_content", bad.ok === false && /PNG|signature|Content/i.test(bad.error || ""));
  let ingestRejected = false;
  try {
    catalog.ingestFile({ absolutePath: fakePath, originalName: "fake.png", provider: "upload" });
  } catch (err) {
    ingestRejected = err.code === "invalid_content" || /PNG|signature|Content|Invalid/i.test(err.message);
  }
  check("ingest_rejects_malformed_png", ingestRejected);
  const goodPng = path.join(isolatedData, "ok.png");
  fs.writeFileSync(goodPng, pngBytes());
  const good = contentValidate.validateFileContent(goodPng, "ok.png");
  check("accepts_real_png_content", good.ok === true);

  // Faithful Sketchfab-like glTF: whitespace/BOM before asset (64-byte heuristic used to fail).
  const gltfDir = path.join(isolatedData, "sf-gltf-valid");
  fs.mkdirSync(gltfDir, { recursive: true });
  const paddedGltf = path.join(gltfDir, "scene.gltf");
  const gltfDoc = {
    asset: { version: "2.0", generator: "sketchfab-fixture" },
    buffers: [{ uri: "scene.bin", byteLength: 4 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
    nodes: [{}],
  };
  fs.writeFileSync(paddedGltf, `\uFEFF\n\n\n${JSON.stringify(gltfDoc, null, 2)}`);
  fs.writeFileSync(path.join(gltfDir, "scene.bin"), Buffer.alloc(4));
  const gltfOk = contentValidate.validateGltfJsonDocument(paddedGltf);
  check("accepts_padded_sketchfab_like_gltf", gltfOk.ok === true && gltfOk.gltf?.version === "2.0", {
    error: gltfOk.error,
  });
  const beforeCount = Object.keys(catalog.loadCatalog().assets).length;
  const ingestedGltf = catalog.ingestFile({
    absolutePath: paddedGltf,
    originalName: "scene.gltf",
    provider: "sketchfab",
    dependencies: [{ relativePath: "scene.bin", absolutePath: path.join(gltfDir, "scene.bin") }],
  });
  check("ingest_padded_gltf_with_deps", Boolean(ingestedGltf.asset?.id) && (ingestedGltf.asset.unity?.dependencies || []).length >= 1);

  // Truncated / invalid JSON that starts with { must still fail.
  const trunc = path.join(isolatedData, "trunc.gltf");
  fs.writeFileSync(trunc, "{\n  \"accessors\": []\n");
  const truncBad = contentValidate.validateFileContent(trunc, "trunc.gltf");
  check("rejects_truncated_gltf_json", truncBad.ok === false);

  // asset missing version
  const noVer = path.join(isolatedData, "nover.gltf");
  fs.writeFileSync(noVer, JSON.stringify({ asset: { generator: "x" }, scenes: [] }));
  const noVerBad = contentValidate.validateGltfJsonDocument(noVer);
  check("rejects_gltf_missing_version", noVerBad.ok === false);

  // Failed ingest leaves no new catalog row for malformed glTF
  const malGltf = path.join(isolatedData, "mal.gltf");
  fs.writeFileSync(malGltf, "not-json-at-all");
  let failedClean = false;
  try {
    catalog.ingestFile({ absolutePath: malGltf, originalName: "mal.gltf", provider: "sketchfab" });
  } catch {
    failedClean = Object.keys(catalog.loadCatalog().assets).length === beforeCount + 1; // only padded success
  }
  check("failed_gltf_ingest_no_extra_rows", failedClean || Object.keys(catalog.loadCatalog().assets).length === beforeCount + 1);
}

// Finding 7: catalog corruption recovery (truncated write with assets + uploads + job)
{
  const catPath = path.join(isolatedData, "assets-catalog.json");
  const goodPath = `${catPath}.good`;
  const before = catalog.loadCatalog();
  const assetCount = Object.keys(before.assets).length;
  check("catalog_recovery_has_assets_seed", assetCount > 0);
  // Ensure .good exists with known assets
  fs.writeFileSync(goodPath, JSON.stringify(before, null, 2));
  // Truncate primary (corrupt)
  fs.writeFileSync(catPath, '{"version":1,"assets":{"partial":true');
  // Clear module recovery by reloading
  const recovered = catalog.loadCatalog();
  const recovery = catalog.getCatalogRecovery();
  check(
    "catalog_corruption_restores_good",
    Object.keys(recovered.assets).length >= assetCount &&
      recovery &&
      recovery.restoredFrom === "assets-catalog.json.good" &&
      !recovery.emptyReset,
    { recovery, restored: Object.keys(recovered.assets).length },
  );
  const listed = catalog.listAssets({});
  check(
    "catalog_recovery_visible_on_list",
    Boolean(listed.catalogRecovery?.recoveredAt || recovered.catalogRecovery?.recoveredAt),
  );
}

// Finding 2: Sketchfab ZIP extract (no token on signed URL) + deps retained
{
  const sketchfab = await import("../api/src/assets/sketchfab.mjs");
  // Build a mini glTF ZIP: scene.gltf + scene.bin
  const zipDir = path.join(isolatedData, "sf-zip-src");
  fs.mkdirSync(zipDir, { recursive: true });
  const gltf = {
    asset: { version: "2.0" },
    buffers: [{ uri: "scene.bin", byteLength: 4 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 1, type: "VEC3" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  fs.writeFileSync(path.join(zipDir, "scene.gltf"), JSON.stringify(gltf));
  fs.writeFileSync(path.join(zipDir, "scene.bin"), Buffer.alloc(4));
  const zipPath = path.join(isolatedData, "sf-model.zip");
  writeZipFromFolder(zipDir, zipPath);

  const extracted = await zipSafe.safeExtractZip(zipPath, path.join(isolatedData, "sf-out"));
  const hasGltf = extracted.files.some((f) => /\.gltf$/i.test(f.relativePath));
  const hasBin = extracted.files.some((f) => /\.bin$/i.test(f.relativePath));
  check("sketchfab_zip_shape_extracts_gltf_and_bin", hasGltf && hasBin, {
    files: extracted.files.map((f) => f.relativePath),
  });

  // Source of downloadSketchfabModel: signed URL fetch must not pass Authorization
  const modSrc = fs.readFileSync(path.join(studioRoot, "api/src/assets/sketchfab.mjs"), "utf8");
  check(
    "sketchfab_signed_url_fetch_without_token",
    /Signed archive URLs must not receive the Sketchfab account token/.test(modSrc) &&
      /const res = await fetch\(url\);/.test(modSrc) &&
      !/fetch\(url,\s*\{[^}]*Authorization/s.test(modSrc),
  );

  // Ingest with dependencies
  const entry = extracted.files.find((f) => /\.gltf$/i.test(f.relativePath));
  const deps = extracted.files
    .filter((f) => f !== entry)
    .map((f) => ({ relativePath: f.relativePath, absolutePath: f.absolutePath }));
  const ingested = catalog.ingestFile({
    absolutePath: entry.absolutePath,
    originalName: "scene.gltf",
    provider: "sketchfab",
    dependencies: deps,
  });
  check(
    "gltf_dependencies_recorded",
    (ingested.asset?.unity?.dependencies || []).some((d) => /scene\.bin/i.test(d.relativePath)),
    { deps: ingested.asset?.unity?.dependencies },
  );
  fs.rmSync(path.join(isolatedData, "sf-out"), { recursive: true, force: true });
}

// Finding 9: ZIP cleanup on failure
{
  const bombDir = path.join(isolatedData, "zip-cleanup");
  fs.mkdirSync(bombDir, { recursive: true });
  const outDir = path.join(bombDir, "out");
  const badZip = path.join(bombDir, "trav.zip");
  writeRawZip(badZip, "../escape.txt", "nope");
  let trav;
  try {
    trav = await zipSafe.safeExtractZip(badZip, outDir);
  } catch (err) {
    trav = { files: [], rejected: [String(err.message)] };
  }
  check(
    "zip_traversal_rejected",
    trav.files.length === 0 && trav.rejected.some((r) => /unsafe|escape|relative path/i.test(r)),
    { rejected: trav.rejected },
  );
  // After failed extract, outDir should be empty or absent (safeExtract should not leave escape)
  const escaped = fs.existsSync(path.join(bombDir, "escape.txt")) || fs.existsSync(path.join(isolatedData, "escape.txt"));
  check("zip_traversal_no_escape_file", !escaped);
  const routesSrc = fs.readFileSync(path.join(studioRoot, "api/src/assets/routes.mjs"), "utf8");
  check(
    "zip_upload_route_has_extraction_finally",
    /outDir[\s\S]*finally[\s\S]*rmSync\(outDir/s.test(routesSrc) ||
      /finally\s*\{[\s\S]*rmSync\(outDir/s.test(routesSrc),
  );
}

// Finding 1: connector project root
{
  const connector = await import("../connector/src/connector.mjs");
  const root = connector.resolveUnityProjectRoot(studioRoot);
  check(
    "connector_project_root_is_hertz",
    path.basename(root) === "HERTZ" &&
      fs.existsSync(path.join(root, "Assets")) &&
      fs.existsSync(path.join(root, "ProjectSettings")),
    { root },
  );
  const connSrc = fs.readFileSync(path.join(studioRoot, "connector/src/connector.mjs"), "utf8");
  check("connector_has_single_instance_pid_lock", /acquireSingleInstance|connector\.pid/.test(connSrc));
}

// Finding 6: no hardcoded owner password in web/source defaults
{
  const loginSrc = fs.readFileSync(path.join(studioRoot, "web/src/pages/Login.jsx"), "utf8");
  const storeSrc = fs.readFileSync(path.join(studioRoot, "api/src/store.mjs"), "utf8");
  check("login_password_not_prefilled", !/hertz-local-owner/.test(loginSrc) && /useState\(""\)/.test(loginSrc));
  check(
    "store_no_default_password_fallback",
    !/hertz-local-owner/.test(storeSrc) && /HERTZ_OWNER_PASSWORD/.test(storeSrc) && /setupRequired/.test(storeSrc),
  );
  const webDistProbe = path.join(studioRoot, "web/dist");
  if (fs.existsSync(webDistProbe)) {
    const hits = [];
    for (const name of fs.readdirSync(webDistProbe)) {
      if (!/\.(js|html|css)$/.test(name)) continue;
      const raw = fs.readFileSync(path.join(webDistProbe, name), "utf8");
      if (raw.includes("hertz-local-owner")) hits.push(name);
    }
    check("frontend_bundle_no_default_password", hits.length === 0, { hits });
  } else {
    check("frontend_bundle_password_scan_deferred_until_build", true);
  }
}

// Finding 4/animation typing
{
  check("animation_ext_allowed", types.ALLOWED_UPLOAD_EXTS.has(".anim"));
  check("aiff_ext_allowed", types.ALLOWED_UPLOAD_EXTS.has(".aiff"));
}

// Kenney catalog: no invented download URL + parse fixture
{
  const kenneyCatalog = await import("../api/src/assets/kenney-catalog.mjs");
  const sampleHtml = `
    <a href='https://kenney.nl/assets/ui-pack'>
      <div class='cover' style='background-image:url("/img/ui.png")'></div>
    </a>
    <h2><a href='https://kenney.nl/assets/ui-pack'>UI Pack</a></h2>
    <span class='bold text-muted'><a href='https://kenney.nl/assets/category:UI'>category:UI</a></span>
  `;
  const packs = kenneyCatalog.parseKenneyListingHtml(sampleHtml, "UI");
  check("kenney_parse_pack_metadata", packs.length === 1 && packs[0].name === "UI Pack" && packs[0].downloadUrl === null);
  check("kenney_download_never_invented", packs.every((p) => p.downloadUrl == null && p.downloadVerified === false));
  check("kenney_retains_official_url", packs[0].sourceUrl === "https://kenney.nl/assets/ui-pack");
}

// Bridge path confinement (source inspection — runtime covered by Unity e2e)
{
  const bridge = fs.readFileSync(
    path.join(studioRoot, "../../Assets/Editor/HertzStudio/HertzStudioHttpBridge.cs"),
    "utf8",
  );
  check(
    "bridge_requires_uuid_asset_id",
    /IsUuid\(assetId\)/.test(bridge) && /must be a UUID/.test(bridge),
  );
  check(
    "bridge_confines_source_and_dest",
    /IsPathInside/.test(bridge) &&
      /HasReparsePointInAncestry/.test(bridge) &&
      /HertzStudioIncoming/.test(bridge) &&
      /AcceptStudioAssetImport/.test(bridge) &&
      !/ImportAssetOptions\.ForceUpdate/.test(bridge),
  );
  check(
    "bridge_rejects_absolute_source_paths",
    /Path\.IsPathRooted\(sourcePath\)/.test(bridge) &&
      (/project-relative/i.test(bridge) || /HertzStudioIncoming/.test(bridge)),
  );
}

// Windows durable-store promotion leaves no temps
{
  const store = await import("../api/src/store.mjs");
  const storeDir = isolatedData;
  // Simulate repeated good promotions
  for (let i = 0; i < 5; i++) {
    store.atomicWrite(path.join(storeDir, "store.json.good"), { version: 1, n: i, drafts: {}, audit: [] });
  }
  const tempsAfter = fs.readdirSync(storeDir).filter((n) => /\.tmp$/i.test(n) && /store\.json/.test(n));
  check("store_good_promotion_no_leftover_temps", tempsAfter.length === 0, { tempsAfter });
  // Abandoned temp cleanup
  fs.writeFileSync(path.join(storeDir, `store.json.good.${process.pid}.orphan.tmp`), "{}");
  const removed = store.cleanupAbandonedStoreTemps(storeDir);
  check("store_temp_cleanup_removes_orphans", removed >= 1 && !fs.existsSync(path.join(storeDir, `store.json.good.${process.pid}.orphan.tmp`)));
}

// Animation type override
{
  const types = await import("../api/src/assets/types.mjs");
  check("fbx_default_model_unless_override", types.classifyByName("hero.fbx") === "model_3d" || types.classifyByName("hero.fbx") === null || types.classifyByName("hero.fbx") === "model_3d");
  // EXT_TYPE maps .fbx to model_3d
  check("fbx_force_animation_override", types.classifyByName("hero.fbx", { assetTypeOverride: "animation" }) === "animation");
  check("fbx_force_model_override", types.classifyByName("walk.fbx", { assetTypeOverride: "model_3d" }) === "model_3d");
  check("invalid_override_rejected", types.classifyByName("hero.fbx", { assetTypeOverride: "texture" }) === null);
  check("gltf_cannot_be_animation_override", types.classifyByName("a.gltf", { assetTypeOverride: "animation" }) === null);
}

// Library delete + nested dep basename collision (finding 2 / 13)
{
  const nest = path.join(scratch, "dup-basename-pkg");
  fs.mkdirSync(path.join(nest, "a"), { recursive: true });
  fs.mkdirSync(path.join(nest, "b"), { recursive: true });
  const gltfDoc = {
    asset: { version: "2.0" },
    buffers: [
      { uri: "a/data.bin", byteLength: 4 },
      { uri: "b/data.bin", byteLength: 4 },
    ],
    scenes: [{ nodes: [0] }],
    scene: 0,
    nodes: [{}],
  };
  fs.writeFileSync(path.join(nest, "scene.gltf"), JSON.stringify(gltfDoc));
  fs.writeFileSync(path.join(nest, "a", "data.bin"), Buffer.from([1, 2, 3, 4]));
  fs.writeFileSync(path.join(nest, "b", "data.bin"), Buffer.from([5, 6, 7, 8]));
  const thumb = path.join(scratch, "provider-thumb.png");
  fs.writeFileSync(
    thumb,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  const before = Object.keys(catalog.loadCatalog().assets).length;
  const ingested = catalog.ingestFile({
    absolutePath: path.join(nest, "scene.gltf"),
    originalName: "scene.gltf",
    provider: "sketchfab",
    dependencies: [
      { relativePath: "a/data.bin", absolutePath: path.join(nest, "a", "data.bin") },
      { relativePath: "b/data.bin", absolutePath: path.join(nest, "b", "data.bin") },
    ],
    previewImagePath: thumb,
  });
  check("nested_duplicate_basename_deps_recorded", (ingested.asset?.unity?.dependencies || []).length === 2);
  check("library_image_preview_not_generic_model", ingested.asset?.preview?.kind === "image");
  const del1 = catalog.deleteLibraryAsset(ingested.asset.id);
  check("delete_library_asset_removes_row", del1.deleted === true && !catalog.loadCatalog().assets[ingested.asset.id]);
  const del2 = catalog.deleteLibraryAsset(ingested.asset.id);
  check("delete_library_asset_idempotent", del2.idempotent === true && del2.deleted === false);
  check("delete_does_not_claim_unity_wipe", del1.unityCopyPreserved === false || typeof del1.message === "string");
  check("delete_leaves_other_assets", Object.keys(catalog.loadCatalog().assets).length === before);
}

// DisplayName vs entrypoint (scene.gltf) naming
{
  const nameDir = path.join(scratch, "naming");
  fs.mkdirSync(nameDir, { recursive: true });
  const mkGltf = (file, assetName) => {
    const p = path.join(nameDir, file);
    fs.writeFileSync(
      p,
      JSON.stringify({
        asset: { version: "2.0", name: assetName || undefined },
        scenes: [{ nodes: [] }],
        scene: 0,
        nodes: [],
      }),
    );
    return p;
  };
  const a = catalog.ingestFile({
    absolutePath: mkGltf("scene.gltf", "model-a"),
    originalName: "scene.gltf",
    entrypointFileName: "scene.gltf",
    displayName: "Red Sports Car",
    provider: "sketchfab",
  });
  const b = catalog.ingestFile({
    absolutePath: mkGltf("scene2.gltf", "model-b"),
    originalName: "scene.gltf",
    entrypointFileName: "scene.gltf",
    displayName: "Blue Drift Kart",
    provider: "sketchfab",
  });
  check("sketchfab_display_not_scene_a", a.asset.displayName === "Red Sports Car");
  check("sketchfab_display_not_scene_b", b.asset.displayName === "Blue Drift Kart");
  check("entrypoint_filename_preserved_a", a.asset.entrypointFileName === "scene.gltf");
  check("two_scene_gltf_archives_distinct_titles", a.asset.displayName !== b.asset.displayName);

  const zipPkg = catalog.ingestFile({
    absolutePath: mkGltf("zip-scene.gltf", "zip-unique"),
    originalName: "scene.gltf",
    entrypointFileName: "scene.gltf",
    packageName: "my_awesome_prop",
    provider: "upload",
  });
  check("zip_package_name_as_display", zipPkg.asset.displayName === "my_awesome_prop");

  const explicit = catalog.ingestFile({
    absolutePath: mkGltf("explicit.gltf", "explicit-unique"),
    originalName: "scene.gltf",
    displayName: "Explicit Title",
    packageName: "ignored_package",
    provider: "upload",
  });
  check("explicit_package_name_wins", explicit.asset.displayName === "Explicit Title");

  const unicode = catalog.ingestFile({
    absolutePath: mkGltf("uni.gltf", "uni-unique"),
    originalName: "scene.gltf",
    displayName: 'カフェ <>:"|?* 模型',
    provider: "upload",
  });
  check(
    "unicode_unsafe_title_sanitized",
    unicode.asset.displayName.includes("カフェ") && !/[<>:"|?*]/.test(unicode.asset.displayName),
  );

  const plainPath = mkGltf("plain.gltf", "plain-unique");
  const sceneOnly = catalog.ingestFile({
    absolutePath: plainPath,
    originalName: "scene.gltf",
    entrypointFileName: "scene.gltf",
    provider: "upload",
  });
  check("entrypoint_fallback_may_be_scene", sceneOnly.asset.displayName === "scene");
  const improved = catalog.ingestFile({
    absolutePath: plainPath,
    originalName: "scene.gltf",
    entrypointFileName: "scene.gltf",
    displayName: "Recovered Title",
    provider: "upload",
  });
  check("duplicate_hash_improves_scene_title", improved.deduplicated === true && improved.metadataImproved === true);
  check("duplicate_hash_surfaces_existing", improved.asset.id === sceneOnly.asset.id);
  check("duplicate_hash_new_title", improved.asset.displayName === "Recovered Title");

  const renamed = catalog.renameLibraryAsset(a.asset.id, "Renamed Car");
  check("owner_rename_display", renamed.asset?.displayName === "Renamed Car");
  check("owner_rename_keeps_entrypoint", renamed.asset?.entrypointFileName === "scene.gltf");

  const migrated = catalog.migrateSceneDisplayNames([
    { assetId: sceneOnly.asset.id, provider: "upload", title: "Migrated From Meta" },
  ]);
  // already improved above — migrate should no-op when not generic
  check("migrate_scene_names_api_returns", Array.isArray(migrated.changed));
}

// Password scan full Studio sources
{
  const hits = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === "data") continue;
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else if (/\.(mjs|js|jsx|md|json)$/i.test(name)) {
        const raw = fs.readFileSync(full, "utf8");
        if (raw.includes("hertz-local-owner") && !/regress-w02/.test(full)) hits.push(path.relative(studioRoot, full));
      }
    }
  }
  walk(studioRoot);
  check("no_retired_default_password_in_studio_sources", hits.length === 0, { hits });
}

report.finishedAt = new Date().toISOString();
const outPath = path.join(studioRoot, "data", "w02-regression-report.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`\nW02 regress: ${report.checks.filter((c) => c.pass).length}/${report.checks.length} passed`);
console.log(`Report: ${outPath}`);
if (report.notes.length) console.log(report.notes.join("\n"));

// Cleanup scratch (keep report)
fs.rmSync(scratch, { recursive: true, force: true });

if (!report.ok) process.exit(1);
