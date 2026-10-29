/**
 * W08 Poly Haven — authoritative metadata, server-selected download URLs, typed Asset Library ingest.
 * Never accepts caller-supplied fileUrl. Never labels intent_recorded as imported.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ingestFile, enqueueUnityImport, getTmpDir, getAsset } from "./assets/catalog.mjs";
import { LIMITS } from "./assets/types.mjs";
import { safeExtractZip } from "./assets/zip-safe.mjs";
import { loadStore, saveStore } from "./store.mjs";

const USER_AGENT = "HERTZ-Studio/0.1 (https://studio.hertz.software; educational VR project)";
const API_ROOT = "https://api.polyhaven.com";
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;
const MAX_REDIRECTS = 3;
const DOWNLOAD_TIMEOUT_MS = 60000;

const IMPORT_STATUSES = Object.freeze([
  "metadata_ready",
  "downloading",
  "downloaded",
  "queued_unity",
  "importing",
  "unity_imported",
  "failed",
]);

function ensurePolyHavenStore(store) {
  if (!store.polyHaven) store.polyHaven = { cache: {}, imports: [] };
  if (!store.polyHaven.cache) store.polyHaven.cache = {};
  if (!Array.isArray(store.polyHaven.imports)) store.polyHaven.imports = [];
  // Legacy intent list kept for migration visibility but never treated as imported.
  if (!Array.isArray(store.polyHaven.downloads)) store.polyHaven.downloads = [];
  return store;
}

function cacheGet(store, key) {
  const hit = store.polyHaven.cache[key];
  if (!hit) return null;
  if (Date.now() - hit.cachedAt > CACHE_TTL_MS) {
    delete store.polyHaven.cache[key];
    return null;
  }
  return hit.payload;
}

function cacheSet(store, key, payload) {
  const keys = Object.keys(store.polyHaven.cache);
  if (keys.length >= MAX_CACHE_ENTRIES) {
    const oldest = keys.sort((a, b) => store.polyHaven.cache[a].cachedAt - store.polyHaven.cache[b].cachedAt)[0];
    delete store.polyHaven.cache[oldest];
  }
  store.polyHaven.cache[key] = { cachedAt: Date.now(), payload };
}

async function polyHavenFetch(apiPath, { timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_ROOT}${apiPath}`, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: ctrl.signal,
      redirect: "error",
    });
    if (res.status === 429) {
      const err = new Error("Poly Haven rate limit. Retry later.");
      err.code = "rate_limit";
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`Poly Haven HTTP ${res.status}`);
      err.code = "provider_failure";
      throw err;
    }
    return await res.json();
  } catch (e) {
    if (e.name === "AbortError") {
      const err = new Error("Poly Haven request timed out.");
      err.code = "timeout";
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export async function listPolyHavenAssets({ type = "textures", q = "" } = {}) {
  const store = ensurePolyHavenStore(loadStore());
  const cacheKey = `list:${type}:${q}`;
  const cached = cacheGet(store, cacheKey);
  if (cached) return { ...cached, cached: true };

  const typePath =
    type === "hdris" ? "/assets?t=hdris" : type === "models" ? "/assets?t=models" : "/assets?t=textures";
  const raw = await polyHavenFetch(typePath);
  if (!raw || typeof raw !== "object") {
    const err = new Error("Malformed Poly Haven assets response.");
    err.code = "malformed_response";
    throw err;
  }
  let entries = Object.entries(raw).map(([id, meta]) => ({
    id,
    name: meta.name || id,
    type: meta.type || type,
    categories: meta.categories || [],
    tags: meta.tags || [],
    credit: meta.authors ? Object.keys(meta.authors).join(", ") : "Poly Haven",
    license: "CC0",
    downloadCount: meta.download_count || 0,
  }));
  if (q) {
    const needle = String(q).toLowerCase();
    entries = entries.filter(
      (e) =>
        e.id.toLowerCase().includes(needle) ||
        e.name.toLowerCase().includes(needle) ||
        (e.tags || []).some((t) => String(t).toLowerCase().includes(needle)),
    );
  }
  const payload = {
    provider: "polyhaven",
    type,
    count: entries.length,
    assets: entries.slice(0, 100),
    credit: "Assets from Poly Haven (polyhaven.com), CC0.",
    userAgent: USER_AGENT,
  };
  cacheSet(store, cacheKey, payload);
  saveStore(store);
  return { ...payload, cached: false };
}

export async function getPolyHavenAssetInfo(assetId) {
  const store = ensurePolyHavenStore(loadStore());
  const cacheKey = `info:${assetId}`;
  const cached = cacheGet(store, cacheKey);
  if (cached) return { ...cached, cached: true };
  const info = await polyHavenFetch(`/info/${encodeURIComponent(assetId)}`);
  const files = await polyHavenFetch(`/files/${encodeURIComponent(assetId)}`);
  const resolutions = files && typeof files === "object" ? Object.keys(files) : [];
  const payload = {
    id: assetId,
    info,
    files,
    resolutions,
    credit: "Poly Haven — CC0. Credit appreciated.",
    license: "CC0",
  };
  cacheSet(store, cacheKey, payload);
  saveStore(store);
  return { ...payload, cached: false };
}

/**
 * Select a downloadable file URL from Poly Haven /files response.
 * Never uses a caller-supplied URL.
 */
export function selectPolyHavenDownload(files, { type = "textures", resolution = "1k" } = {}) {
  if (!files || typeof files !== "object") {
    const err = new Error("Malformed Poly Haven files payload.");
    err.code = "malformed_response";
    throw err;
  }
  const resKey = String(resolution);
  const resNode = files[resKey];
  if (!resNode || typeof resNode !== "object") {
    const err = new Error(`Resolution '${resKey}' is unavailable for this asset.`);
    err.code = "unavailable_resolution";
    throw err;
  }

  const pickUrl = (node) => {
    if (!node || typeof node !== "object") return null;
    if (typeof node.url === "string" && /^https:\/\//i.test(node.url)) {
      return { url: node.url, size: Number(node.size) || null, format: null };
    }
    for (const [fmt, meta] of Object.entries(node)) {
      if (meta && typeof meta.url === "string" && /^https:\/\//i.test(meta.url)) {
        return { url: meta.url, size: Number(meta.size) || null, format: fmt };
      }
    }
    return null;
  };

  if (type === "hdris" || files.hdri || resNode.hdr || resNode.exr) {
    const hdr = pickUrl(resNode.hdr) || pickUrl(resNode.exr) || pickUrl(resNode);
    if (hdr) return { ...hdr, map: "hdri", extension: hdr.format === "exr" ? ".exr" : ".hdr" };
  }

  if (type === "models") {
    const gltf = pickUrl(resNode.gltf) || pickUrl(resNode.blend) || pickUrl(resNode);
    if (gltf) return { ...gltf, map: "model", extension: ".zip" };
  }

  // Textures: prefer color/diffuse/albedo maps (not previews).
  const mapOrder = ["Diffuse", "diff", "albedo", "Color", "col", "BaseColor", "basecolor", "Diffuse_png"];
  for (const mapName of mapOrder) {
    if (resNode[mapName]) {
      const picked = pickUrl(resNode[mapName]);
      if (picked) {
        const ext = picked.format === "jpg" || picked.format === "jpeg" ? ".jpg" : ".png";
        return { ...picked, map: mapName, extension: ext };
      }
    }
  }
  // Fallback: first map with a https url that is not a thumbnail/include.
  for (const [mapName, node] of Object.entries(resNode)) {
    if (/thumb|preview|include/i.test(mapName)) continue;
    const picked = pickUrl(node);
    if (picked) {
      const ext = picked.format === "jpg" || picked.format === "jpeg" ? ".jpg" : picked.format === "exr" ? ".exr" : ".png";
      return { ...picked, map: mapName, extension: ext };
    }
  }

  const err = new Error("No permitted downloadable file found for the selected resolution.");
  err.code = "unavailable_resolution";
  throw err;
}

async function downloadBounded(url, { maxBytes = LIMITS.maxZipBytes, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(current, {
        redirect: "manual",
        headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
        signal: ctrl.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc || !/^https:\/\//i.test(loc)) {
          const err = new Error("Poly Haven redirect not https.");
          err.code = "provider_failure";
          throw err;
        }
        current = loc;
        continue;
      }
      if (!res.ok) {
        const err = new Error(`Poly Haven download HTTP ${res.status}`);
        err.code = res.status === 429 ? "rate_limit" : "provider_failure";
        throw err;
      }
      const contentLength = Number(res.headers.get("content-length") || 0);
      if (contentLength > maxBytes) {
        const err = new Error("Download exceeds maximum allowed size.");
        err.code = "too_large";
        throw err;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) {
        const err = new Error("Download exceeds maximum allowed size.");
        err.code = "too_large";
        throw err;
      }
      if (buf.length === 0) {
        const err = new Error("Empty download.");
        err.code = "provider_failure";
        throw err;
      }
      return buf;
    } catch (e) {
      if (e.name === "AbortError") {
        const err = new Error("Poly Haven download timed out.");
        err.code = "timeout";
        throw err;
      }
      throw e;
    } finally {
      clearTimeout(t);
    }
  }
  const err = new Error("Too many redirects during Poly Haven download.");
  err.code = "provider_failure";
  throw err;
}

function safeFilename(name, fallbackExt) {
  const base = String(name || "polyhaven")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  if (!base) return `polyhaven${fallbackExt}`;
  if (!path.extname(base) && fallbackExt) return `${base}${fallbackExt}`;
  return base;
}

/**
 * Full vertical import: metadata → download → Asset Library → Unity import queue.
 * Rejects any caller-supplied fileUrl.
 */
export async function startPolyHavenImport(body = {}) {
  if (body.fileUrl || body.url || body.downloadUrl) {
    const err = new Error("Caller-supplied file URLs are rejected. Studio selects URLs from Poly Haven metadata.");
    err.code = "caller_url_rejected";
    throw err;
  }
  const assetId = String(body.assetId || body.providerId || "").trim();
  if (!assetId) {
    const err = new Error("assetId required.");
    err.code = "invalid_request";
    throw err;
  }
  const type = body.type === "hdris" || body.type === "models" ? body.type : "textures";
  const resolution = String(body.resolution || "1k");

  const store = ensurePolyHavenStore(loadStore());
  const jobId = randomUUID();
  const record = {
    id: jobId,
    provider: "polyhaven",
    providerId: assetId,
    type,
    resolution,
    status: "metadata_ready",
    license: "CC0",
    attribution: "Poly Haven",
    libraryAssetId: null,
    contentHash: null,
    unityJobId: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.polyHaven.imports.unshift(record);
  store.polyHaven.imports = store.polyHaven.imports.slice(0, 200);
  saveStore(store);

  try {
    const info = await getPolyHavenAssetInfo(assetId);
    const selected = selectPolyHavenDownload(info.files, { type, resolution });
    record.status = "downloading";
    record.map = selected.map;
    record.downloadSize = selected.size;
    record.updatedAt = new Date().toISOString();
    saveStore(ensurePolyHavenStore(loadStore()));

    const buf = await downloadBounded(selected.url, {
      maxBytes: selected.extension === ".zip" ? LIMITS.maxZipBytes : LIMITS.maxFileBytes,
    });
    const contentHash = createHash("sha256").update(buf).digest("hex");
    record.contentHash = contentHash;

    // Deduplicate prior import by provider/type/resolution/hash.
    const prior = store.polyHaven.imports.find(
      (i) =>
        i.id !== jobId &&
        i.providerId === assetId &&
        i.type === type &&
        i.resolution === resolution &&
        i.contentHash === contentHash &&
        i.libraryAssetId,
    );
    if (prior?.libraryAssetId) {
      record.status = prior.status === "unity_imported" ? "unity_imported" : "downloaded";
      record.libraryAssetId = prior.libraryAssetId;
      record.deduplicated = true;
      record.updatedAt = new Date().toISOString();
      const s = ensurePolyHavenStore(loadStore());
      const idx = s.polyHaven.imports.findIndex((i) => i.id === jobId);
      if (idx >= 0) s.polyHaven.imports[idx] = record;
      saveStore(s);
      return { record, asset: getAsset(prior.libraryAssetId) };
    }

    const tmpRoot = path.join(getTmpDir(), `polyhaven-${assetId}-${Date.now()}`);
    fs.mkdirSync(tmpRoot, { recursive: true });
    const filename = safeFilename(`${assetId}_${resolution}_${selected.map || "map"}`, selected.extension);
    const archivePath = path.join(tmpRoot, filename);
    fs.writeFileSync(archivePath, buf);

    let entryPath = archivePath;
    let originalName = filename;
    let dependencies = [];
    const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
    try {
      if (isZip || selected.extension === ".zip") {
        const outDir = path.join(tmpRoot, "extracted");
        const extracted = await safeExtractZip(archivePath, outDir);
        if (extracted.rejected?.length) {
          const err = new Error(`Archive rejected unsafe entries: ${extracted.rejected.slice(0, 3).join("; ")}`);
          err.code = "archive_traversal";
          throw err;
        }
        const entry =
          extracted.files.find((f) => /\.(png|jpe?g|hdr|exr|glb|gltf)$/i.test(f.relativePath)) ||
          extracted.files[0];
        if (!entry) {
          const err = new Error("Poly Haven archive contained no usable texture/model file.");
          err.code = "provider_failure";
          throw err;
        }
        entryPath = entry.absolutePath;
        originalName = path.basename(entry.relativePath);
        dependencies = extracted.files
          .filter((f) => f.absolutePath !== entry.absolutePath)
          .map((f) => ({
            relativePath: f.relativePath,
            absolutePath: f.absolutePath,
            byteSize: f.size,
          }));
      }

      record.status = "downloaded";
      record.updatedAt = new Date().toISOString();

      const assetTypeOverride = type === "models" ? "model_3d" : null;
      const ingested = ingestFile({
        absolutePath: entryPath,
        originalName,
        displayName: info.info?.name || assetId,
        provider: "polyhaven",
        sourceUrl: `https://polyhaven.com/a/${assetId}`,
        author: record.attribution,
        license: "CC0",
        description: `Poly Haven ${type} ${assetId} @ ${resolution} (${selected.map || "file"})`,
        dependencies,
        assetTypeOverride,
        kenneyCategory: type === "textures" || type === "hdris" ? "Textures" : null,
      });

      record.libraryAssetId = ingested.asset.id;
      record.deduplicated = Boolean(ingested.deduplicated);
      record.status = "queued_unity";
      record.updatedAt = new Date().toISOString();

      const requestId = `polyhaven-import-${contentHash.slice(0, 24)}`;
      const queued = enqueueUnityImport(ingested.asset.id, requestId);
      if (queued.error) {
        record.status = "downloaded";
        record.error = queued.error;
      } else {
        record.unityJobId = queued.job?.id || null;
        record.status = queued.job?.status === "pending_unity" ? "queued_unity" : record.status;
      }

      const s = ensurePolyHavenStore(loadStore());
      const idx = s.polyHaven.imports.findIndex((i) => i.id === jobId);
      if (idx >= 0) s.polyHaven.imports[idx] = { ...record };
      else s.polyHaven.imports.unshift(record);
      saveStore(s);

      return {
        record: { ...record },
        asset: ingested.asset,
        unityImport: queued.error ? { error: queued.error } : queued.job,
        note: "Preview images are never treated as source assets. Import status is not intent_recorded.",
      };
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  } catch (e) {
    record.status = "failed";
    record.error = e.message;
    record.code = e.code || "failed";
    record.updatedAt = new Date().toISOString();
    const s = ensurePolyHavenStore(loadStore());
    const idx = s.polyHaven.imports.findIndex((i) => i.id === jobId);
    if (idx >= 0) s.polyHaven.imports[idx] = record;
    else s.polyHaven.imports.unshift(record);
    saveStore(s);
    throw e;
  }
}

export function listPolyHavenImports() {
  const store = ensurePolyHavenStore(loadStore());
  return {
    imports: store.polyHaven.imports,
    note: "Only statuses in the import state machine are authoritative. Legacy intent_recorded rows are not imported assets.",
    statuses: IMPORT_STATUSES,
  };
}

export function getPolyHavenImport(id) {
  const store = ensurePolyHavenStore(loadStore());
  return store.polyHaven.imports.find((i) => i.id === id) || null;
}

/** @deprecated Do not use — kept only to fail closed if old clients call it. */
export function recordPolyHavenDownloadIntent(body = {}) {
  if (body.fileUrl || body.url || body.downloadUrl) {
    const err = new Error("Caller-supplied file URLs are rejected.");
    err.code = "caller_url_rejected";
    throw err;
  }
  const err = new Error(
    "download-intent is retired. Use POST /api/polyhaven/import which downloads and creates a typed Asset Library record.",
  );
  err.code = "intent_retired";
  throw err;
}

// silence unused in some bundlers
void fileURLToPath;
