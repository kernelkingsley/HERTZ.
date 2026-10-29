import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  ASSET_STATES,
  STATE_LABELS,
  LIMITS,
  classifyByName,
  isUnityImportable,
  ALLOWED_UPLOAD_EXTS,
} from "./types.mjs";
import { validateFileContent } from "./content-validate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..");
const DATA = process.env.HERTZ_STUDIO_DATA
  ? path.resolve(process.env.HERTZ_STUDIO_DATA)
  : path.join(ROOT, "data");
const CATALOG_PATH = path.join(DATA, "assets-catalog.json");
const CATALOG_GOOD_PATH = path.join(DATA, "assets-catalog.json.good");
const BLOBS = path.join(DATA, "private", "assets");
const PREVIEWS = path.join(DATA, "previews");
const TMP = path.join(DATA, "tmp", "uploads");

let lastCatalogRecovery = null;

function ensureDirs() {
  for (const d of [DATA, BLOBS, PREVIEWS, TMP, path.dirname(CATALOG_PATH)]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function emptyCatalog() {
  return { version: 1, assets: {}, uploads: {}, jobs: [], updatedAt: new Date().toISOString() };
}

function tryParseCatalog(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.assets) return { catalog: null, raw };
    return { catalog: parsed, raw };
  } catch {
    return { catalog: null, raw };
  }
}

function atomicWriteJson(filePath, data) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, JSON.stringify(data, null, 2), "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    try {
      fs.renameSync(tmp, filePath);
    } catch (err) {
      if (err.code === "EPERM" || err.code === "EEXIST" || err.code === "EACCES") {
        fs.copyFileSync(tmp, filePath);
      } else {
        throw err;
      }
    }
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

export function getCatalogRecovery() {
  return lastCatalogRecovery;
}

export function loadCatalog() {
  ensureDirs();
  const primary = tryParseCatalog(CATALOG_PATH);
  if (primary?.catalog) {
    if (primary.catalog.catalogRecovery) lastCatalogRecovery = primary.catalog.catalogRecovery;
    return primary.catalog;
  }

  if (primary?.raw != null) {
    const backup = `${CATALOG_PATH}.corrupt.${Date.now()}.bak`;
    fs.writeFileSync(backup, primary.raw);
    const good = tryParseCatalog(CATALOG_GOOD_PATH);
    if (good?.catalog) {
      lastCatalogRecovery = {
        recoveredAt: new Date().toISOString(),
        reason: "primary_catalog_corrupt",
        corruptBackup: path.basename(backup),
        restoredFrom: "assets-catalog.json.good",
        emptyReset: false,
      };
      good.catalog.catalogRecovery = lastCatalogRecovery;
      atomicWriteJson(CATALOG_PATH, good.catalog);
      console.error(
        `HERTZ assets-catalog.json corrupt; restored last-known-good (backup ${path.basename(backup)}).`,
      );
      return good.catalog;
    }
    lastCatalogRecovery = {
      recoveredAt: new Date().toISOString(),
      reason: "primary_corrupt_no_good_generation",
      corruptBackup: path.basename(backup),
      restoredFrom: null,
      emptyReset: true,
    };
    const fresh = { ...emptyCatalog(), catalogRecovery: lastCatalogRecovery };
    atomicWriteJson(CATALOG_PATH, fresh);
    atomicWriteJson(CATALOG_GOOD_PATH, fresh);
    console.error(`HERTZ assets-catalog.json corrupt; empty reset after ${path.basename(backup)}.`);
    return fresh;
  }

  const goodOnly = tryParseCatalog(CATALOG_GOOD_PATH);
  if (goodOnly?.catalog) {
    lastCatalogRecovery = {
      recoveredAt: new Date().toISOString(),
      reason: "primary_missing_restored_good",
      restoredFrom: "assets-catalog.json.good",
      emptyReset: false,
    };
    goodOnly.catalog.catalogRecovery = lastCatalogRecovery;
    atomicWriteJson(CATALOG_PATH, goodOnly.catalog);
    return goodOnly.catalog;
  }

  const empty = emptyCatalog();
  atomicWriteJson(CATALOG_PATH, empty);
  atomicWriteJson(CATALOG_GOOD_PATH, empty);
  return empty;
}

function saveCatalog(catalog) {
  ensureDirs();
  catalog.updatedAt = new Date().toISOString();
  atomicWriteJson(CATALOG_PATH, catalog);
  try {
    atomicWriteJson(CATALOG_GOOD_PATH, catalog);
  } catch (err) {
    console.error(`HERTZ assets-catalog.json.good promotion failed: ${err.message}`);
    catalog.catalogRecovery = {
      ...(catalog.catalogRecovery || {}),
      goodPromotionFailedAt: new Date().toISOString(),
      goodPromotionError: err.message,
    };
  }
}

export function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

export function storageUsedBytes(catalog = loadCatalog()) {
  return Object.values(catalog.assets).reduce((sum, a) => sum + (a.byteSize || 0), 0);
}

/** Sanitize a user-facing title; keep Unicode; strip path/control chars. */
export function sanitizeDisplayName(raw, fallback = "Asset") {
  let s = String(raw ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/<>:"|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) s = String(fallback || "Asset").trim() || "Asset";
  if (s.length > 120) s = s.slice(0, 120).trim();
  return s || "Asset";
}

export function isGenericSceneDisplayName(name) {
  return /^scene$/i.test(String(name || "").trim());
}

/** Priority: explicit → package → glTF asset.name → entrypoint basename (last resort). */
export function resolveIngestDisplayName({
  displayNameOpt = null,
  packageName = null,
  gltfAssetName = null,
  entryName = null,
  ext = "",
  provider = "upload",
} = {}) {
  const candidates = [displayNameOpt, packageName, gltfAssetName];
  for (const c of candidates) {
    if (c == null || String(c).trim() === "") continue;
    const cleaned = sanitizeDisplayName(c, "");
    if (cleaned && !isGenericSceneDisplayName(cleaned)) return cleaned;
  }
  const entryBase = path.basename(entryName || "asset", ext || path.extname(entryName || ""));
  if (entryBase && !isGenericSceneDisplayName(entryBase)) {
    return sanitizeDisplayName(entryBase);
  }
  // Final fallback may still be "scene" for Sketchfab archives with no title (caller should pass meta).
  if (provider === "sketchfab") {
    return sanitizeDisplayName(displayNameOpt || packageName || gltfAssetName || entryBase || "Sketchfab model");
  }
  return sanitizeDisplayName(entryBase || "Asset");
}

/** Owner rename; does not alter blob/entrypoint filenames. */
export function renameLibraryAsset(assetId, nextName) {
  const catalog = loadCatalog();
  const asset = catalog.assets[assetId];
  if (!asset) return { error: "Asset not found", status: 404 };
  const cleaned = sanitizeDisplayName(nextName, "");
  if (!cleaned) return { error: "displayName required", status: 400 };
  asset.displayName = cleaned;
  asset.updatedAt = new Date().toISOString();
  catalog.assets[assetId] = asset;
  saveCatalog(catalog);
  return { asset: publicAsset(asset), status: 200 };
}

/**
 * Repair provider assets named exactly "scene" when authoritative metadata is supplied.
 * Never guesses titles for unrelated uploads.
 */
export function migrateSceneDisplayNames(repairs = []) {
  const catalog = loadCatalog();
  const changed = [];
  for (const row of repairs) {
    const asset = catalog.assets[row?.assetId];
    if (!asset || !isGenericSceneDisplayName(asset.displayName)) continue;
    if (row.provider && asset.provider !== row.provider) continue;
    const title = sanitizeDisplayName(row.title, "");
    if (!title || isGenericSceneDisplayName(title)) continue;
    asset.displayName = title;
    asset.updatedAt = new Date().toISOString();
    catalog.assets[asset.id] = asset;
    changed.push(asset.id);
  }
  if (changed.length) saveCatalog(catalog);
  return { changed };
}

export function publicAsset(asset) {
  if (!asset) return null;
  return {
    id: asset.id,
    displayName: asset.displayName,
    entrypointFileName: asset.entrypointFileName || null,
    description: asset.description,
    assetType: asset.assetType,
    provider: asset.provider,
    sourceUrl: asset.sourceUrl,
    author: asset.author,
    license: asset.license,
    packName: asset.packName,
    packVersion: asset.packVersion,
    fileFormat: asset.fileFormat,
    byteSize: asset.byteSize,
    contentHash: asset.contentHash,
    preview: asset.preview
      ? {
          kind: asset.preview.kind,
          url: asset.preview.url,
          width: asset.preview.width || null,
          height: asset.preview.height || null,
        }
      : null,
    unity: {
      readiness: asset.unity?.readiness || "unknown",
      importedPath: asset.unity?.importedPath || null,
      prefabPath: asset.unity?.prefabPath || null,
      prefabGuid: asset.unity?.prefabGuid || asset.unity?.guid || null,
      guid: asset.unity?.guid || asset.unity?.prefabGuid || null,
      clipPath: asset.unity?.clipPath || null,
      controllerPath: asset.unity?.controllerPath || null,
      incompatibleRig: asset.unity?.incompatibleRig === true,
      rigged: asset.unity?.rigged ?? null,
      dependencies: asset.unity?.dependencies || [],
      lastPlacedScene: asset.unity?.lastPlacedScene || null,
      lastPlacedAt: asset.unity?.lastPlacedAt || null,
      lastPlacedGlobalObjectId: asset.unity?.lastPlacedGlobalObjectId || null,
      lastPlacedUnityRevision: asset.unity?.lastPlacedUnityRevision ?? null,
      // Distinct scenes this asset was successfully placed into (not the same as import).
      placedScenes: (() => {
        if (Array.isArray(asset.unity?.placedScenes) && asset.unity.placedScenes.length) {
          return asset.unity.placedScenes;
        }
        // Do not invent scene membership from a failed place attempt.
        if (asset.placeError) return [];
        if (asset.unity?.lastPlacedScene) return [asset.unity.lastPlacedScene];
        return [];
      })(),
    },
    state: asset.state,
    stateLabel: STATE_LABELS[asset.state] || asset.state,
    importError: asset.importError || null,
    placeError: asset.placeError || null,
    placeCode: asset.placeCode || null,
    placeBlockingScenes: asset.placeBlockingScenes || null,
    placeStatus: asset.placeStatus || null,
    validationState: asset.validationState || "ok",
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  };
}

/** Older catalogs marked FBX model_3d as unsupported; Unity and Studio now accept them. */
function repairLegacyFbxModelGate(asset) {
  if (!asset || asset.assetType !== "model_3d") return false;
  const name = String(asset.entrypointFileName || asset.originalName || asset.blobPath || "").toLowerCase();
  const format = String(asset.fileFormat || "").toLowerCase();
  const isFbx = format === "fbx" || name.endsWith(".fbx");
  if (!isFbx) return false;
  if (asset.state !== "unsupported" && asset.unity?.readiness !== "unsupported") return false;
  asset.state = "preview_ready";
  asset.importError = null;
  asset.unity = { ...(asset.unity || {}), readiness: "pending" };
  asset.updatedAt = new Date().toISOString();
  return true;
}

export function listAssets(query = {}) {
  const catalog = loadCatalog();
  let repaired = false;
  for (const asset of Object.values(catalog.assets)) {
    if (repairLegacyFbxModelGate(asset)) repaired = true;
  }
  if (repaired) saveCatalog(catalog);
  let items = Object.values(catalog.assets);
  const {
    q,
    type,
    provider,
    pack,
    license,
    state,
    unityReady,
    page = 1,
    pageSize = 24,
  } = query;

  if (q) {
    const needle = String(q).toLowerCase();
    items = items.filter(
      (a) =>
        a.displayName?.toLowerCase().includes(needle) ||
        a.description?.toLowerCase().includes(needle) ||
        a.packName?.toLowerCase().includes(needle) ||
        a.author?.toLowerCase().includes(needle),
    );
  }
  if (type) items = items.filter((a) => a.assetType === type);
  if (provider) items = items.filter((a) => a.provider === provider);
  if (pack) items = items.filter((a) => a.packName === pack);
  if (license) items = items.filter((a) => a.license === license);
  if (state) items = items.filter((a) => a.state === state);
  if (unityReady === "1" || unityReady === "true") {
    items = items.filter((a) => a.state === "unity_imported" || a.unity?.readiness === "ready");
  }

  items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const total = items.length;
  const p = Math.max(1, Number(page) || 1);
  const size = Math.min(100, Math.max(1, Number(pageSize) || 24));
  const start = (p - 1) * size;
  const slice = items.slice(start, start + size);
  return {
    total,
    page: p,
    pageSize: size,
    pageCount: Math.max(1, Math.ceil(total / size)),
    storageUsedBytes: storageUsedBytes(catalog),
    storageQuotaBytes: LIMITS.storageQuotaBytes,
    catalogRecovery: catalog.catalogRecovery || lastCatalogRecovery || null,
    assets: slice.map(publicAsset),
  };
}

export function getAsset(id) {
  const catalog = loadCatalog();
  const asset = catalog.assets[id];
  if (asset && repairLegacyFbxModelGate(asset)) saveCatalog(catalog);
  return publicAsset(catalog.assets[id]);
}

export function findByHash(contentHash) {
  const catalog = loadCatalog();
  return Object.values(catalog.assets).find((a) => a.contentHash === contentHash) || null;
}

function makePreviewForFile(assetId, absPath, assetType) {
  const ext = path.extname(absPath).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) {
    const destName = `${assetId}${ext}`;
    const dest = path.join(PREVIEWS, destName);
    fs.copyFileSync(absPath, dest);
    return {
      kind: assetType === "pixel" ? "pixel_image" : "image",
      url: `/api/assets/previews/${destName}`,
      relativePath: destName,
    };
  }
  if ([".wav", ".mp3", ".ogg", ".aiff"].includes(ext)) {
    const destName = `${assetId}${ext}`;
    const dest = path.join(PREVIEWS, destName);
    fs.copyFileSync(absPath, dest);
    return {
      kind: "audio",
      url: `/api/assets/previews/${destName}`,
      relativePath: destName,
    };
  }
  if ([".glb", ".gltf"].includes(ext)) {
    const destName = `${assetId}${ext}`;
    const dest = path.join(PREVIEWS, destName);
    fs.copyFileSync(absPath, dest);
    return {
      kind: "model",
      url: `/api/assets/previews/${destName}`,
      relativePath: destName,
      note: "model_preview_on_details_route",
    };
  }
  return { kind: "none", url: null, relativePath: null };
}

/**
 * Register a local file as a library asset (upload or Kenney/Sketchfab ingest).
 */
/**
 * Prefer a validated local image still for library cards (Sketchfab/Kenney thumbs).
 * Falls back to makePreviewForFile when absent/invalid.
 */
export function buildImagePreview(assetId, absolutePath) {
  if (!absolutePath || !fs.existsSync(absolutePath)) return null;
  const check = validateFileContent(absolutePath, path.basename(absolutePath));
  if (!check.ok) return null;
  const ext = path.extname(absolutePath).toLowerCase() || ".png";
  if (![".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) return null;
  ensureDirs();
  const destName = `${assetId}${ext}`;
  const dest = path.join(PREVIEWS, destName);
  fs.copyFileSync(absolutePath, dest);
  return {
    kind: "image",
    url: `/api/assets/previews/${destName}`,
    relativePath: destName,
  };
}

/**
 * Ingest a validated file into the private catalog.
 * @param {object} opts
 * @param {string} [opts.displayName] explicit user-facing title (preferred over entrypoint basename)
 * @param {string} [opts.packageName] archive/package filename without extension
 * @param {string} [opts.gltfAssetName] glTF JSON asset.name when safely available
 * @param {string} [opts.entrypointFileName] on-disk entrypoint basename (keeps Unity/glTF deps correct)
 */
export function ingestFile({
  absolutePath,
  originalName,
  displayName: displayNameOpt = null,
  packageName = null,
  gltfAssetName = null,
  entrypointFileName = null,
  provider = "upload",
  sourceUrl = null,
  author = null,
  license = "unknown",
  packName = null,
  packVersion = null,
  description = "",
  kenneyCategory = null,
  pixelHint = false,
  dependencies = [],
  assetTypeOverride = null,
  previewImagePath = null,
}) {
  ensureDirs();
  const entryName = path.basename(entrypointFileName || originalName || absolutePath);
  const ext = path.extname(entryName || originalName || absolutePath).toLowerCase();
  if (ext === ".zip") {
    throw new Error("ZIP must be expanded before ingestFile.");
  }
  if (!ALLOWED_UPLOAD_EXTS.has(ext)) {
    const err = new Error(`Unsupported file type: ${ext || "(none)"}`);
    err.code = "unsupported";
    throw err;
  }

  const contentCheck = validateFileContent(absolutePath, entryName || originalName || absolutePath);
  if (!contentCheck.ok) {
    const err = new Error(contentCheck.error || "Invalid file content.");
    err.code = "invalid_content";
    throw err;
  }

  const catalog = loadCatalog();
  const used = storageUsedBytes(catalog);
  const byteSize = fs.statSync(absolutePath).size;
  if (used + byteSize > LIMITS.storageQuotaBytes) {
    const err = new Error("Storage quota exceeded.");
    err.code = "quota";
    throw err;
  }
  if (byteSize > LIMITS.maxFileBytes) {
    const err = new Error(`File exceeds max size (${LIMITS.maxFileBytes} bytes).`);
    err.code = "too_large";
    throw err;
  }

  const resolvedDisplay = resolveIngestDisplayName({
    displayNameOpt,
    packageName,
    gltfAssetName,
    entryName,
    ext,
    provider,
  });

  const contentHash = sha256File(absolutePath);
  const existing = findByHash(contentHash);
  if (existing) {
    let metadataImproved = false;
    if (
      isGenericSceneDisplayName(existing.displayName) &&
      !isGenericSceneDisplayName(resolvedDisplay) &&
      resolvedDisplay
    ) {
      existing.displayName = resolvedDisplay;
      existing.updatedAt = new Date().toISOString();
      if (!existing.entrypointFileName) existing.entrypointFileName = entryName;
      catalog.assets[existing.id] = existing;
      saveCatalog(catalog);
      metadataImproved = true;
    }
    return {
      asset: publicAsset(existing),
      deduplicated: true,
      metadataImproved,
    };
  }

  const assetType = classifyByName(entryName || originalName || absolutePath, {
    pixelHint,
    kenneyCategory,
    assetTypeOverride,
  });
  if (!assetType) {
    const err = new Error(
      assetTypeOverride
        ? `Invalid type override "${assetTypeOverride}" for ${originalName}`
        : `Could not classify file: ${originalName}`,
    );
    err.code = "unsupported";
    throw err;
  }

  const id = randomUUID();
  const blobName = `${id}${ext}`;
  const blobPath = path.join(BLOBS, blobName);
  fs.copyFileSync(absolutePath, blobPath);

  const depRecords = [];
  const missingDeps = [];
  for (const dep of dependencies || []) {
    const rel = String(dep?.relativePath || path.basename(dep?.absolutePath || "")).replace(/\\/g, "/");
    if (!rel || rel.includes("..") || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
      missingDeps.push(rel || "(invalid)");
      continue;
    }
    if (!dep?.absolutePath || !fs.existsSync(dep.absolutePath)) {
      missingDeps.push(rel);
      continue;
    }
    const depBlob = `${id}__${rel.replace(/[^\w.\-]+/g, "_")}`;
    const depAbs = path.join(BLOBS, depBlob);
    fs.mkdirSync(path.dirname(depAbs), { recursive: true });
    fs.copyFileSync(dep.absolutePath, depAbs);
    if (!fs.existsSync(depAbs)) {
      missingDeps.push(rel);
      continue;
    }
    depRecords.push({
      relativePath: rel,
      blobName: depBlob,
      byteSize: fs.statSync(depAbs).size,
    });
  }

  if (missingDeps.length) {
    fs.rmSync(blobPath, { force: true });
    for (const d of depRecords) {
      fs.rmSync(path.join(BLOBS, d.blobName), { force: true });
    }
    const err = new Error(`Missing or invalid glTF dependency: ${missingDeps[0]}`);
    err.code = "invalid_content";
    throw err;
  }

  const now = new Date().toISOString();
  const unityOk = isUnityImportable(entryName || originalName || absolutePath, assetType);
  const imagePreview = buildImagePreview(id, previewImagePath);
  const preview = imagePreview || makePreviewForFile(id, blobPath, assetType);
  const state = unityOk ? "preview_ready" : ext === ".usdz" ? "unsupported" : "preview_ready";

  const asset = {
    id,
    displayName: resolvedDisplay,
    entrypointFileName: entryName,
    description: description || "",
    assetType,
    provider,
    sourceUrl,
    author,
    license,
    packName,
    packVersion,
    fileFormat: ext.replace(".", ""),
    byteSize,
    contentHash,
    blobPath: path.relative(DATA, blobPath).replace(/\\/g, "/"),
    preview,
    unity: {
      readiness: unityOk ? "pending" : "unsupported",
      importedPath: null,
      prefabPath: null,
      dependencies: depRecords,
    },
    state: unityOk ? state : assetType === "model_3d" && !unityOk ? "unsupported" : state,
    importError: null,
    validationState: "ok",
    createdAt: now,
    updatedAt: now,
  };

  if (ext === ".usdz" || ext === ".usd") {
    asset.state = "unsupported";
    asset.importError = "USDZ/USD is not supported: no Unity USD importer is installed in this project.";
    asset.unity.readiness = "unsupported";
  }

  catalog.assets[id] = asset;
  saveCatalog(catalog);
  return { asset: publicAsset(asset), deduplicated: false };
}

export function updateAssetState(id, patch) {
  const catalog = loadCatalog();
  const asset = catalog.assets[id];
  if (!asset) return null;
  Object.assign(asset, patch, { updatedAt: new Date().toISOString() });
  if (patch.state && STATE_LABELS[patch.state]) {
    /* stateLabel derived in publicAsset */
  }
  catalog.assets[id] = asset;
  saveCatalog(catalog);
  return publicAsset(asset);
}

function normalizePlacement(scenePath, placement) {
  if (!scenePath || typeof scenePath !== "string" || !scenePath.startsWith("Assets/") || !scenePath.endsWith(".unity")) {
    return { error: "scenePath must be an Assets/…/*.unity path." };
  }
  if (scenePath.includes("..")) return { error: "Invalid scenePath." };
  if (!placement || placement.confirmSave !== true) {
    return { error: "Explicit save confirmation is required." };
  }
  if (placement.scenePath !== scenePath || placement.assetId == null) {
    return { error: "Placement confirmation does not match the requested asset and scene." };
  }
  if (!Number.isInteger(placement.expectedUnityRevision) || placement.expectedUnityRevision < 0) {
    return { error: "A known non-negative expectedUnityRevision is required. Refresh the Unity scene list." };
  }
  const readVector = (value, fallback, label) => {
    const candidate = value ?? fallback;
    if (!candidate || ![candidate.x, candidate.y, candidate.z].every(Number.isFinite)) {
      return { error: `${label} must contain finite x, y, z numbers.` };
    }
    return { value: { x: candidate.x, y: candidate.y, z: candidate.z } };
  };
  const position = readVector(placement.position, { x: 0, y: 0, z: 0 }, "position");
  const rotation = readVector(placement.rotation, { x: 0, y: 0, z: 0 }, "rotation");
  const scale = readVector(placement.scale, { x: 1, y: 1, z: 1 }, "scale");
  if (position.error || rotation.error || scale.error) return { error: position.error || rotation.error || scale.error };
  if (![scale.value.x, scale.value.y, scale.value.z].every((v) => v >= 0.001 && v <= 1000)) {
    return { error: "scale components must be between 0.001 and 1000." };
  }
  return {
    value: {
      assetId: placement.assetId,
      scenePath,
      confirmSave: true,
      expectedUnityRevision: placement.expectedUnityRevision,
      position: position.value,
      rotation: rotation.value,
      scale: scale.value,
    },
  };
}

function samePlacement(left, right) {
  return JSON.stringify(left || null) === JSON.stringify(right || null);
}

export function enqueueUnityImport(assetId, requestId, { scenePath = null, placement = null } = {}) {
  const catalog = loadCatalog();
  const asset = catalog.assets[assetId];
  if (!asset) return { error: "Asset not found", status: 404 };
  if (repairLegacyFbxModelGate(asset)) saveCatalog(catalog);
  if (asset.state === "unsupported" || asset.unity?.readiness === "unsupported") {
    return { error: asset.importError || "Asset cannot be imported to Unity.", status: 400 };
  }
  let confirmedPlacement = null;
  if (scenePath) {
    const normalized = normalizePlacement(scenePath, placement);
    if (normalized.error || normalized.value?.assetId !== assetId) {
      return { error: normalized.error || "Placement confirmation assetId mismatch.", status: 400 };
    }
    confirmedPlacement = normalized.value;
  }
  const existing = catalog.jobs.find((j) => j.requestId === requestId);
  if (existing) {
    if (existing.assetId !== assetId || existing.scenePath !== (scenePath || null) || !samePlacement(existing.placement, confirmedPlacement)) {
      return { error: "requestId reused with a different import or placement payload.", status: 409 };
    }
    return { deduplicated: true, job: existing, status: 200 };
  }

  const job = {
    id: randomUUID(),
    requestId,
    type: "import_asset",
    assetId,
    scenePath: scenePath || null,
    placement: confirmedPlacement,
    status: "pending_unity",
    createdAt: new Date().toISOString(),
    attempts: 0,
  };
  catalog.jobs.push(job);
  asset.state = "pending_unity";
  asset.placeError = null;
  asset.updatedAt = new Date().toISOString();
  saveCatalog(catalog);
  return { deduplicated: false, job, status: 202 };
}

/** Place an already-imported asset into a chosen Unity scene. */
export function enqueuePlaceInScene(assetId, scenePath, requestId, placement) {
  const catalog = loadCatalog();
  const asset = catalog.assets[assetId];
  if (!asset) return { error: "Asset not found", status: 404 };
  if (asset.state !== "unity_imported" && asset.unity?.readiness !== "ready") {
    return { error: "Import the asset to Unity before placing it in a scene.", status: 400 };
  }
  const normalized = normalizePlacement(scenePath, placement);
  if (normalized.error || normalized.value?.assetId !== assetId) {
    return { error: normalized.error || "Placement confirmation assetId mismatch.", status: 400 };
  }
  const existing = catalog.jobs.find((j) => j.requestId === requestId);
  if (existing) {
    if (existing.type !== "place_in_scene" || existing.assetId !== assetId || !samePlacement(existing.placement, normalized.value)) {
      return { error: "requestId reused with a different placement payload.", status: 409 };
    }
    return { deduplicated: true, job: existing, status: 200 };
  }

  const job = {
    id: randomUUID(),
    requestId,
    type: "place_in_scene",
    assetId,
    scenePath,
    placement: normalized.value,
    status: "pending_unity",
    createdAt: new Date().toISOString(),
    attempts: 0,
  };
  catalog.jobs.push(job);
  asset.placeError = null;
  asset.updatedAt = new Date().toISOString();
  saveCatalog(catalog);
  return { deduplicated: false, job, status: 202 };
}

export function nextAssetJob() {
  const catalog = loadCatalog();
  return catalog.jobs.find((j) => j.status === "pending_unity" || j.status === "importing_unity") || null;
}

export function markAssetJobApplying(jobId) {
  const catalog = loadCatalog();
  const job = catalog.jobs.find((j) => j.id === jobId);
  if (!job) return;
  job.status = "importing_unity";
  job.attempts += 1;
  job.startedAt = new Date().toISOString();
  const asset = catalog.assets[job.assetId];
  if (asset && job.type !== "place_in_scene") {
    asset.state = "importing_unity";
    asset.updatedAt = new Date().toISOString();
  }
  saveCatalog(catalog);
}

export function acknowledgeAssetJob({
  requestId,
  ok,
  error,
  importedPath,
  prefabPath,
  placedScenePath,
  placeError,
  globalObjectId,
  unityRevision,
  placeCode,
  blockingScenes,
  deduplicated,
}) {
  const catalog = loadCatalog();
  const job = catalog.jobs.find((j) => j.requestId === requestId);
  if (!job) return null;
  if (["applied", "failed"].includes(job.status)) return { deduplicated: true, job };
  const asset = catalog.assets[job.assetId];
  const isPlace = job.type === "place_in_scene";
  if (ok) {
    job.status = "applied";
    job.appliedAt = new Date().toISOString();
    if (deduplicated) job.deduplicated = true;
    if (asset) {
      if (!isPlace) {
        asset.state = "unity_imported";
        asset.unity = {
          ...(asset.unity || {}),
          readiness: "ready",
          importedPath: importedPath || asset.unity?.importedPath || null,
          prefabPath: prefabPath || asset.unity?.prefabPath || null,
        };
        asset.importError = null;
      }
      if (isPlace && (placedScenePath || job.scenePath)) {
        const scenePath = placedScenePath || job.scenePath;
        const priorScenes = Array.isArray(asset.unity?.placedScenes)
          ? asset.unity.placedScenes.filter(Boolean)
          : asset.unity?.lastPlacedScene
            ? [asset.unity.lastPlacedScene]
            : [];
        const placedScenes = priorScenes.includes(scenePath)
          ? priorScenes
          : [...priorScenes, scenePath];
        asset.unity = {
          ...(asset.unity || {}),
          lastPlacedScene: scenePath,
          lastPlacedAt: new Date().toISOString(),
          lastPlacedGlobalObjectId: globalObjectId || asset.unity?.lastPlacedGlobalObjectId || null,
          lastPlacedUnityRevision:
            Number.isFinite(unityRevision) ? unityRevision : asset.unity?.lastPlacedUnityRevision || null,
          placedScenes,
        };
      }
      asset.placeError = placeError || null;
      asset.placeCode = null;
      asset.placeBlockingScenes = null;
      asset.placeStatus = "applied";
      asset.updatedAt = new Date().toISOString();
    }
  } else {
    job.status = "failed";
    job.error = error || (isPlace ? "Place in scene failed" : "Import failed");
    if (asset) {
      if (isPlace && (asset.state === "unity_imported" || asset.unity?.readiness === "ready")) {
        asset.placeError = job.error;
        asset.placeCode = placeCode || null;
        asset.placeBlockingScenes = Array.isArray(blockingScenes) ? blockingScenes : null;
        asset.placeStatus = placeCode === "unsaved_unity_changes" ? "stale" : "failed";
      } else {
        asset.state = "failed";
        asset.importError = job.error;
      }
      asset.updatedAt = new Date().toISOString();
    }
  }
  saveCatalog(catalog);
  return { job, asset: asset ? publicAsset(asset) : null };
}

export function getAssetBlobPath(assetId) {
  const catalog = loadCatalog();
  const asset = catalog.assets[assetId];
  if (!asset?.blobPath) return null;
  const abs = path.resolve(DATA, asset.blobPath);
  const blobsRoot = path.resolve(BLOBS);
  if (
    !abs.toLowerCase().startsWith(blobsRoot.toLowerCase() + path.sep) &&
    abs.toLowerCase() !== blobsRoot.toLowerCase()
  ) {
    return null;
  }
  return fs.existsSync(abs) ? abs : null;
}

export function getDependencyBlobPath(assetId, blobName) {
  const catalog = loadCatalog();
  const asset = catalog.assets[assetId];
  if (!asset) return null;
  const safe = path.basename(blobName || "");
  const allowed = (asset.unity?.dependencies || []).some((d) => d.blobName === safe);
  if (!allowed) return null;
  const abs = path.join(BLOBS, safe);
  return fs.existsSync(abs) ? abs : null;
}

/** Resumable/chunked upload session (restart-safe via catalog.uploads). */
export function initChunkedUpload({ fileName, byteSize, contentHash = null, assetTypeOverride = null }) {
  ensureDirs();
  const catalog = loadCatalog();
  const size = Number(byteSize) || 0;
  if (size <= 0 || size > LIMITS.maxFileBytes) {
    const err = new Error(`Invalid byteSize (max ${LIMITS.maxFileBytes}).`);
    err.code = "too_large";
    throw err;
  }
  const ext = path.extname(fileName || "").toLowerCase();
  if (!ALLOWED_UPLOAD_EXTS.has(ext) || ext === ".zip") {
    const err = new Error(`Unsupported or non-chunkable type: ${ext || "(none)"}`);
    err.code = "unsupported";
    throw err;
  }
  if (assetTypeOverride) {
    const classified = classifyByName(fileName, { assetTypeOverride });
    if (!classified) {
      const err = new Error(`Invalid assetTypeOverride "${assetTypeOverride}" for ${fileName}`);
      err.code = "unsupported";
      throw err;
    }
  }
  if (contentHash) {
    const existing = findByHash(contentHash);
    if (existing) {
      return { deduplicated: true, asset: publicAsset(existing) };
    }
  }
  const uploadId = randomUUID();
  const partDir = path.join(TMP, `chunk-${uploadId}`);
  fs.mkdirSync(partDir, { recursive: true });
  catalog.uploads[uploadId] = {
    id: uploadId,
    fileName,
    byteSize: size,
    contentHash,
    assetTypeOverride: assetTypeOverride || null,
    received: 0,
    partDir: path.relative(DATA, partDir).replace(/\\/g, "/"),
    createdAt: new Date().toISOString(),
    status: "uploading",
  };
  saveCatalog(catalog);
  return {
    deduplicated: false,
    uploadId,
    chunkSize: LIMITS.maxChunkBytes,
    byteSize: size,
    received: 0,
  };
}

export function getChunkedUpload(uploadId) {
  const catalog = loadCatalog();
  const session = catalog.uploads[uploadId];
  if (!session) return null;
  return {
    uploadId: session.id,
    fileName: session.fileName,
    byteSize: session.byteSize,
    received: session.received,
    status: session.status,
    assetTypeOverride: session.assetTypeOverride || null,
  };
}

export function appendUploadChunk(uploadId, chunkBuffer, offset) {
  const catalog = loadCatalog();
  const session = catalog.uploads[uploadId];
  if (!session || session.status !== "uploading") {
    const err = new Error("Unknown or completed upload session.");
    err.code = "not_found";
    throw err;
  }
  const partDir = path.resolve(DATA, session.partDir);
  const tmpRoot = path.resolve(TMP);
  if (!partDir.toLowerCase().startsWith(tmpRoot.toLowerCase() + path.sep)) {
    throw new Error("Invalid upload session path.");
  }
  const off = Number(offset);
  if (!Number.isFinite(off) || off !== session.received) {
    const err = new Error(`Unexpected chunk offset ${off}; expected ${session.received}.`);
    err.code = "offset";
    throw err;
  }
  if (chunkBuffer.length > LIMITS.maxChunkBytes) {
    const err = new Error("Chunk exceeds maxChunkBytes.");
    err.code = "too_large";
    throw err;
  }
  if (session.received + chunkBuffer.length > session.byteSize) {
    const err = new Error("Chunk would exceed declared byteSize.");
    err.code = "too_large";
    throw err;
  }
  const partPath = path.join(partDir, `part-${String(off).padStart(12, "0")}`);
  fs.writeFileSync(partPath, chunkBuffer);
  session.received += chunkBuffer.length;
  session.updatedAt = new Date().toISOString();
  saveCatalog(catalog);
  return { uploadId, received: session.received, byteSize: session.byteSize, complete: session.received === session.byteSize };
}

export function completeChunkedUpload(uploadId, meta = {}) {
  const catalog = loadCatalog();
  const session = catalog.uploads[uploadId];
  if (!session) {
    const err = new Error("Unknown upload session.");
    err.code = "not_found";
    throw err;
  }
  if (session.received !== session.byteSize) {
    const err = new Error(`Incomplete upload: ${session.received}/${session.byteSize}.`);
    err.code = "incomplete";
    throw err;
  }
  const partDir = path.resolve(DATA, session.partDir);
  const parts = fs.readdirSync(partDir).filter((n) => n.startsWith("part-")).sort();
  const assembled = path.join(partDir, "assembled.bin");
  fs.writeFileSync(
    assembled,
    Buffer.concat(parts.map((n) => fs.readFileSync(path.join(partDir, n)))),
  );

  let result;
  try {
    result = ingestFile({
      absolutePath: assembled,
      originalName: session.fileName,
      provider: meta.provider || "upload",
      license: meta.license || "uploaded",
      packName: meta.packName || null,
      assetTypeOverride: meta.assetTypeOverride || session.assetTypeOverride || null,
    });
  } catch (err) {
    // Failed complete must not leave assembled parts or a half session marked done.
    // Reload before writing — never save the pre-ingest snapshot (it would wipe ingest).
    try {
      fs.rmSync(partDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    const failed = loadCatalog();
    if (failed.uploads[uploadId]) {
      delete failed.uploads[uploadId];
      saveCatalog(failed);
    }
    throw err;
  }
  // ingestFile() loads/saves its own catalog. Reloading prevents this completion write
  // from overwriting the newly ingested asset (stale pre-ingest snapshot).
  const fresh = loadCatalog();
  const liveSession = fresh.uploads[uploadId];
  if (liveSession) {
    liveSession.status = "completed";
    liveSession.assetId = result.asset?.id || null;
    liveSession.completedAt = new Date().toISOString();
    liveSession.updatedAt = liveSession.completedAt;
    saveCatalog(fresh);
  }
  fs.rmSync(partDir, { recursive: true, force: true });
  return result;
}

function orphanBlobPathForSession(session) {
  if (!session?.assetId || !session?.fileName) return null;
  const ext = path.extname(session.fileName).toLowerCase() || ".bin";
  return path.join(BLOBS, `${session.assetId}${ext}`);
}

function removeOrphanBlobAndPreview(assetId, fileName) {
  const ext = path.extname(fileName || "").toLowerCase() || ".bin";
  const blob = path.join(BLOBS, `${assetId}${ext}`);
  const preview = path.join(PREVIEWS, `${assetId}${ext}`);
  for (const p of [blob, preview]) {
    try {
      if (fs.existsSync(p)) fs.rmSync(p, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Rebuild a catalog asset row from a retained private blob after a stale completion overwrite.
 * Reuses the orphaned asset id so upload sessions stay linked.
 */
function rebuildAssetRecordFromBlob(assetId, fileName, { provider = "upload", license = "uploaded" } = {}) {
  const ext = path.extname(fileName || "").toLowerCase();
  const blobPath = path.join(BLOBS, `${assetId}${ext}`);
  if (!fs.existsSync(blobPath)) return null;
  const entryName = path.basename(fileName || `${assetId}${ext}`);
  const contentCheck = validateFileContent(blobPath, entryName);
  if (!contentCheck.ok) return null;
  const byteSize = fs.statSync(blobPath).size;
  const contentHash = sha256File(blobPath);
  const assetType = classifyByName(entryName, { assetTypeOverride: null });
  if (!assetType) return null;
  const unityOk = isUnityImportable(entryName, assetType);
  const previewExisting = path.join(PREVIEWS, `${assetId}${ext}`);
  let preview = null;
  if (fs.existsSync(previewExisting)) {
    preview = {
      kind: ["glb", "gltf"].includes(ext.replace(".", "")) ? "model" : "none",
      url: `/api/assets/previews/${assetId}${ext}`,
      relativePath: `${assetId}${ext}`,
      note: "model_preview_on_details_route",
    };
  } else {
    preview = makePreviewForFile(assetId, blobPath, assetType);
  }
  const now = new Date().toISOString();
  const state = unityOk ? "preview_ready" : "preview_ready";
  return {
    id: assetId,
    displayName: resolveIngestDisplayName({ entryName, ext, provider }),
    entrypointFileName: entryName,
    description: "",
    assetType,
    provider,
    sourceUrl: null,
    author: null,
    license,
    packName: null,
    packVersion: null,
    fileFormat: ext.replace(".", ""),
    byteSize,
    contentHash,
    blobPath: path.relative(DATA, blobPath).replace(/\\/g, "/"),
    preview,
    unity: {
      readiness: unityOk ? "pending" : "unsupported",
      importedPath: null,
      prefabPath: null,
      dependencies: [],
    },
    state: unityOk ? state : assetType === "model_3d" && !unityOk ? "unsupported" : state,
    importError: null,
    validationState: "ok",
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Repair completed upload sessions whose assetId is missing from the catalog but whose
 * private blob (and usually preview) still exist. Identical content hashes collapse to one
 * catalog asset; duplicate orphan blobs are removed.
 */
export function repairOrphanedCompletedUploads() {
  ensureDirs();
  const catalog = loadCatalog();
  const report = {
    restored: [],
    relinked: [],
    skipped: [],
    removedOrphanBlobs: [],
  };
  const sessions = Object.values(catalog.uploads || {}).filter(
    (s) => s && s.status === "completed" && s.assetId,
  );
  // Oldest first so the first successful restore becomes the shared hash survivor.
  sessions.sort((a, b) => String(a.completedAt || a.createdAt || "").localeCompare(String(b.completedAt || b.createdAt || "")));

  for (const session of sessions) {
    if (catalog.assets[session.assetId]) {
      report.skipped.push({ uploadId: session.id, reason: "asset_present", assetId: session.assetId });
      continue;
    }
    const blobPath = orphanBlobPathForSession(session);
    if (!blobPath || !fs.existsSync(blobPath)) {
      report.skipped.push({ uploadId: session.id, reason: "blob_missing", assetId: session.assetId });
      continue;
    }
    const contentHash = sha256File(blobPath);
    const existing = Object.values(catalog.assets).find((a) => a.contentHash === contentHash);
    if (existing) {
      const orphanId = session.assetId;
      session.assetId = existing.id;
      session.updatedAt = new Date().toISOString();
      catalog.uploads[session.id] = session;
      removeOrphanBlobAndPreview(orphanId, session.fileName);
      report.relinked.push({ uploadId: session.id, from: orphanId, to: existing.id });
      report.removedOrphanBlobs.push(orphanId);
      continue;
    }
    const rebuilt = rebuildAssetRecordFromBlob(session.assetId, session.fileName, {
      provider: "upload",
      license: "uploaded",
    });
    if (!rebuilt) {
      report.skipped.push({ uploadId: session.id, reason: "rebuild_failed", assetId: session.assetId });
      continue;
    }
    catalog.assets[rebuilt.id] = rebuilt;
    report.restored.push({ uploadId: session.id, assetId: rebuilt.id, displayName: rebuilt.displayName });
  }

  if (report.restored.length || report.relinked.length) {
    saveCatalog(catalog);
  }
  return report;
}

export function cancelChunkedUpload(uploadId) {
  const catalog = loadCatalog();
  const session = catalog.uploads[uploadId];
  if (!session) return { cancelled: false };
  const partDir = path.resolve(DATA, session.partDir);
  fs.rmSync(partDir, { recursive: true, force: true });
  delete catalog.uploads[uploadId];
  saveCatalog(catalog);
  return { cancelled: true };
}

export function resolvePreviewFile(name) {
  const safe = path.basename(name);
  const abs = path.join(PREVIEWS, safe);
  if (!abs.startsWith(PREVIEWS)) return null;
  return fs.existsSync(abs) ? abs : null;
}

export function cleanupAbandonedUploads(maxAgeMs = 60 * 60 * 1000) {
  ensureDirs();
  const now = Date.now();
  let removed = 0;
  for (const name of fs.readdirSync(TMP)) {
    const full = path.join(TMP, name);
    try {
      const st = fs.statSync(full);
      if (now - st.mtimeMs > maxAgeMs) {
        fs.rmSync(full, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      /* ignore */
    }
  }
  return removed;
}

function isAssetUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

/**
 * Owner library delete: catalog + private blobs + previews + jobs/uploads for this asset.
 * Never deletes Unity Assets/HertzStudio/Imported copies, prefabs, scenes, or GUIDs.
 * Idempotent when the asset is already gone.
 */
export function deleteLibraryAsset(assetId) {
  ensureDirs();
  if (!isAssetUuid(assetId)) {
    const err = new Error("assetId must be a UUID.");
    err.code = "invalid_id";
    throw err;
  }

  const catalog = loadCatalog();
  const asset = catalog.assets[assetId];
  if (!asset) {
    return {
      ok: true,
      deleted: false,
      idempotent: true,
      unityCopyPreserved: true,
      message: "Asset already absent from the library.",
      storageUsedBytes: storageUsedBytes(catalog),
    };
  }

  const unityCopyPreserved = Boolean(asset.unity?.importedPath || asset.unity?.prefabPath);
  const removed = { blob: false, dependencies: 0, preview: false, jobs: 0, uploads: 0 };
  const failures = [];

  try {
    // Cancel/remove queued or in-flight jobs for this asset.
    const beforeJobs = catalog.jobs.length;
    catalog.jobs = (catalog.jobs || []).filter((j) => {
      if (j.assetId === assetId) {
        removed.jobs += 1;
        return false;
      }
      return true;
    });
    if (catalog.jobs.length !== beforeJobs - removed.jobs) {
      /* filter count already applied */
    }

    // Drop incomplete chunk uploads that completed into this assetId (rare).
    for (const [uploadId, session] of Object.entries(catalog.uploads || {})) {
      if (session?.assetId === assetId) {
        try {
          if (session.partDir) fs.rmSync(path.resolve(DATA, session.partDir), { recursive: true, force: true });
        } catch (err) {
          failures.push(`upload:${uploadId}:${err.message}`);
        }
        delete catalog.uploads[uploadId];
        removed.uploads += 1;
      }
    }

    if (asset.blobPath) {
      try {
        const abs = path.resolve(DATA, asset.blobPath);
        if (abs.toLowerCase().startsWith(path.resolve(BLOBS).toLowerCase() + path.sep)) {
          fs.rmSync(abs, { force: true });
          removed.blob = true;
        }
      } catch (err) {
        failures.push(`blob:${err.message}`);
      }
    }

    for (const dep of asset.unity?.dependencies || []) {
      try {
        const abs = path.join(BLOBS, path.basename(dep.blobName || ""));
        if (fs.existsSync(abs)) {
          fs.rmSync(abs, { force: true });
          removed.dependencies += 1;
        }
      } catch (err) {
        failures.push(`dep:${dep.relativePath}:${err.message}`);
      }
    }

    if (asset.preview?.relativePath) {
      try {
        const prev = path.join(PREVIEWS, path.basename(asset.preview.relativePath));
        if (fs.existsSync(prev)) {
          fs.rmSync(prev, { force: true });
          removed.preview = true;
        }
      } catch (err) {
        failures.push(`preview:${err.message}`);
      }
    }

    delete catalog.assets[assetId];
    saveCatalog(catalog);
  } catch (err) {
    const wrapped = new Error(`Delete partially failed: ${err.message}`);
    wrapped.code = "delete_partial";
    wrapped.recovery = { assetId, removed, failures: [...failures, err.message] };
    throw wrapped;
  }

  if (failures.length) {
    const wrapped = new Error(`Asset removed from catalog with storage cleanup warnings.`);
    wrapped.code = "delete_partial";
    wrapped.recovery = { assetId, removed, failures };
    // Catalog row already gone — surface warning but treat as success with recovery.
    return {
      ok: true,
      deleted: true,
      idempotent: false,
      unityCopyPreserved,
      message: unityCopyPreserved
        ? "Removed from library with cleanup warnings. Unity Imported copy was preserved."
        : "Removed from library with cleanup warnings.",
      removed,
      recovery: wrapped.recovery,
      storageUsedBytes: storageUsedBytes(loadCatalog()),
    };
  }

  return {
    ok: true,
    deleted: true,
    idempotent: false,
    unityCopyPreserved,
    message: unityCopyPreserved
      ? `Deleted "${asset.displayName}" from the library. The Unity Imported copy was preserved and was not deleted.`
      : `Deleted "${asset.displayName}" from the library.`,
    removed,
    storageUsedBytes: storageUsedBytes(loadCatalog()),
  };
}

export function getTmpDir() {
  ensureDirs();
  return TMP;
}

export function getBlobsDir() {
  ensureDirs();
  return BLOBS;
}

export { ASSET_STATES, LIMITS, ROOT };
