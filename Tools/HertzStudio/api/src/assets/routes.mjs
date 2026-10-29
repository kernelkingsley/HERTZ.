import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  listAssets,
  getAsset,
  ingestFile,
  enqueueUnityImport,
  enqueuePlaceInScene,
  resolvePreviewFile,
  cleanupAbandonedUploads,
  getTmpDir,
  LIMITS,
  initChunkedUpload,
  appendUploadChunk,
  completeChunkedUpload,
  cancelChunkedUpload,
  getChunkedUpload,
  getAssetBlobPath,
  getDependencyBlobPath,
  deleteLibraryAsset,
  renameLibraryAsset,
  migrateSceneDisplayNames,
} from "./catalog.mjs";
import { safeExtractZip } from "./zip-safe.mjs";
import { importKenneyPack, kenneyInfo } from "./kenney.mjs";
import { searchKenneyCatalog, getKenneyPack, refreshKenneyCatalog } from "./kenney-catalog.mjs";
import {
  searchSketchfab,
  downloadSketchfabModel,
  validateSketchfabToken,
  getSketchfabModelDetail,
} from "./sketchfab.mjs";
import { describeAssetForBrowser, rejectUnsafeAssetId } from "../render-descriptors.mjs";
import {
  getSketchfabMeta,
  saveSketchfabToken,
  clearSketchfabToken,
  redactSecrets,
} from "./secrets.mjs";
import { ALLOWED_UPLOAD_EXTS } from "./types.mjs";

const upload = multer({
  dest: getTmpDir(),
  limits: { fileSize: LIMITS.maxZipBytes, files: 1 },
});

const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LIMITS.maxChunkBytes, files: 1 },
});

export function createAssetRouter({ requireOwner }) {
  const router = express.Router();

  router.get("/assets", requireOwner, (req, res) => {
    cleanupAbandonedUploads();
    res.json(listAssets(req.query));
  });

  router.get("/assets/kenney/info", requireOwner, (_req, res) => {
    res.json(kenneyInfo());
  });

  router.get("/assets/previews/:name", requireOwner, (req, res) => {
    const file = resolvePreviewFile(req.params.name);
    if (!file) return res.status(404).end();
    res.sendFile(file);
  });

  router.get("/assets/sketchfab/search", requireOwner, async (req, res) => {
    const result = await searchSketchfab({
      q: req.query.q || "",
      cursor: req.query.cursor || null,
    });
    res.json(result);
  });

  router.get("/find/search", requireOwner, async (req, res) => {
    const provider = String(req.query.provider || "all").toLowerCase();
    const q = req.query.q || "";
    const page = Number(req.query.page || 1);
    const pageSize = Number(req.query.pageSize || 24);
    const refresh = req.query.refresh === "1";

    const out = { provider, q, page, results: [], providers: {} };

    if (provider === "all" || provider === "kenney") {
      try {
        out.providers.kenney = await searchKenneyCatalog({
          q,
          page,
          pageSize,
          refresh,
          category: req.query.category || "",
        });
      } catch (err) {
        out.providers.kenney = { provider: "kenney", offline: true, error: err.message, results: [] };
      }
    }
    if (provider === "all" || provider === "sketchfab") {
      out.providers.sketchfab = await searchSketchfab({ q, cursor: req.query.cursor || null });
    }
    if (provider === "all" || provider === "library") {
      const local = listAssets({ q, provider: provider === "library" ? undefined : "kenney", page, pageSize });
      out.providers.library = {
        provider: "library",
        results: (local.assets || []).map((a) => ({
          ...a,
          kind: "library",
          name: a.displayName,
          thumbnailUrl: a.preview?.url || null,
        })),
        total: local.total,
        page: local.page,
        pageCount: local.pageCount,
      };
    }

    // Flatten for All tab: Kenney discovery + Sketchfab + already-imported Kenney hits labeled distinctly.
    if (provider === "all") {
      const kenney = (out.providers.kenney?.results || []).map((r) => ({ ...r, kind: "discovery" }));
      const sketchfab = (out.providers.sketchfab?.results || []).map((r) => ({ ...r, kind: "discovery" }));
      const library = (out.providers.library?.results || []).map((r) => ({
        ...r,
        kind: "library",
        note: "Already in your Asset Library",
      }));
      out.results = [...kenney, ...sketchfab, ...library];
    } else if (provider === "kenney") {
      const k = out.providers.kenney || {};
      out.results = (k.results || []).map((r) => ({ ...r, kind: "discovery" }));
      out.stale = k.stale;
      out.offline = k.offline;
      out.error = k.error;
      out.page = k.page ?? page;
      out.pageCount = k.pageCount ?? 1;
      out.total = k.total ?? out.results.length;
      out.indexedAt = k.indexedAt;
      out.lastError = k.lastError;
      out.note = k.note;
    } else if (provider === "sketchfab") {
      out.results = (out.providers.sketchfab?.results || []).map((r) => ({ ...r, kind: "discovery" }));
      out.pending = out.providers.sketchfab?.pending;
      out.error = out.providers.sketchfab?.error;
      out.message = out.providers.sketchfab?.message;
    }

    res.json(out);
  });

  router.get("/find/kenney/:id", requireOwner, async (req, res) => {
    try {
      await refreshKenneyCatalog({ force: false });
    } catch {
      /* use cache */
    }
    const pack = getKenneyPack(req.params.id);
    if (!pack) return res.status(404).json({ error: "Kenney pack not found in catalog cache." });
    res.json({
      ...pack,
      downloadVerified: false,
      actions: {
        openOnKenney: pack.sourceUrl,
        importDownloadedZip: true,
        oneClickDownload: false,
        note: "Official pack page only — direct ZIP URLs are not invented.",
      },
    });
  });

  router.get("/find/sketchfab/:uid", requireOwner, async (req, res) => {
    const detail = await getSketchfabModelDetail(req.params.uid);
    res.json(detail);
  });

  router.post("/assets/upload", requireOwner, upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "file required" });
    const original = req.file.originalname || req.file.filename;
    const ext = path.extname(original).toLowerCase();
    const tmpPath = req.file.path;
    const explicitName = (req.body?.displayName || req.body?.name || "").trim() || null;
    const packageName = path.basename(original, ext) || null;

    try {
      if (!ALLOWED_UPLOAD_EXTS.has(ext)) {
        return res.status(400).json({ error: `Unsupported file type: ${ext || "(none)"}` });
      }
      if (ext === ".zip") {
        const outDir = path.join(getTmpDir(), `zip-${randomUUID()}`);
        try {
          const extracted = await safeExtractZip(tmpPath, outDir);
          const created = [];
          const skipped = [];
          // Nested glTF/GLB packages must keep relative deps (Sketchfab-style), not flatten per-file.
          const gltfEntry =
            extracted.files.find((f) => /\.gltf$/i.test(f.relativePath)) ||
            extracted.files.find((f) => /\.glb$/i.test(f.relativePath));
          if (gltfEntry) {
            const entryRel = String(gltfEntry.relativePath || "").replace(/\\/g, "/");
            const entryDir = path.posix.dirname(entryRel);
            const dependencies = extracted.files
              .filter((f) => f.absolutePath !== gltfEntry.absolutePath)
              .map((f) => {
                let rel = String(f.relativePath || "").replace(/\\/g, "/");
                if (entryDir && entryDir !== "." && rel.startsWith(`${entryDir}/`)) {
                  rel = rel.slice(entryDir.length + 1);
                }
                return {
                  relativePath: rel,
                  absolutePath: f.absolutePath,
                  byteSize: f.size,
                };
              });
            try {
              const gltfAssetName = peekGltfAssetName(gltfEntry.absolutePath);
              const result = ingestFile({
                absolutePath: gltfEntry.absolutePath,
                originalName: path.basename(gltfEntry.relativePath),
                entrypointFileName: path.basename(gltfEntry.relativePath),
                displayName: explicitName,
                packageName,
                gltfAssetName,
                provider: "upload",
                license: "uploaded",
                dependencies,
              });
              if (result.deduplicated) {
                skipped.push({
                  file: gltfEntry.relativePath,
                  reason: "duplicate_hash",
                  metadataImproved: Boolean(result.metadataImproved),
                  asset: result.asset,
                });
                if (result.asset) created.push(result.asset);
              } else {
                created.push(result.asset);
              }
            } catch (err) {
              skipped.push({ file: gltfEntry.relativePath, reason: err.message });
            }
            return res.status(created.length ? 201 : 400).json({
              kind: "zip_gltf_package",
              created: created.length,
              skipped,
              rejected: extracted.rejected,
              assets: created,
              asset: created[0] || null,
            });
          }
          for (const file of extracted.files) {
            try {
              const result = ingestFile({
                absolutePath: file.absolutePath,
                originalName: path.basename(file.relativePath),
                provider: "upload",
                license: "uploaded",
              });
              if (result.deduplicated) skipped.push({ file: file.relativePath, reason: "duplicate_hash" });
              else created.push(result.asset);
            } catch (err) {
              skipped.push({ file: file.relativePath, reason: err.message });
            }
          }
          return res.status(201).json({
            kind: "zip",
            created: created.length,
            skipped,
            rejected: extracted.rejected,
            assets: created,
          });
        } finally {
          fs.rmSync(outDir, { recursive: true, force: true });
        }
      }

      const gltfAssetName =
        ext === ".gltf" || ext === ".glb" ? peekGltfAssetName(tmpPath) : null;
      const result = ingestFile({
        absolutePath: tmpPath,
        originalName: original,
        entrypointFileName: path.basename(original),
        displayName: explicitName,
        packageName,
        gltfAssetName,
        provider: "upload",
        license: "uploaded",
      });
      return res.status(result.deduplicated ? 200 : 201).json(result);
    } catch (err) {
      const status = err.code === "quota" || err.code === "too_large" ? 413 : 400;
      return res.status(status).json({ error: err.message });
    } finally {
      fs.rmSync(tmpPath, { force: true });
    }
  });

  // Resumable/chunked for large justified files (restart-safe sessions in catalog.uploads)
  router.post("/assets/upload/init", requireOwner, (req, res) => {
    try {
      const result = initChunkedUpload({
        fileName: req.body?.fileName,
        byteSize: req.body?.byteSize,
        contentHash: req.body?.contentHash || null,
        assetTypeOverride: req.body?.assetTypeOverride || null,
      });
      res.status(result.deduplicated ? 200 : 201).json(result);
    } catch (err) {
      const status = err.code === "too_large" ? 413 : 400;
      res.status(status).json({ error: err.message, code: err.code });
    }
  });

  router.get("/assets/upload/:uploadId", requireOwner, (req, res) => {
    const session = getChunkedUpload(req.params.uploadId);
    if (!session) return res.status(404).json({ error: "Unknown upload session." });
    res.json(session);
  });

  router.put(
    "/assets/upload/:uploadId/chunk",
    requireOwner,
    chunkUpload.single("chunk"),
    (req, res) => {
      try {
        const offset = Number(req.headers["x-hertz-chunk-offset"] ?? req.body?.offset ?? 0);
        const buf = req.file?.buffer;
        if (!buf) return res.status(400).json({ error: "chunk file field required" });
        const result = appendUploadChunk(req.params.uploadId, buf, offset);
        res.json(result);
      } catch (err) {
        const status = err.code === "not_found" ? 404 : err.code === "too_large" ? 413 : 400;
        res.status(status).json({ error: err.message, code: err.code });
      }
    },
  );

  router.post("/assets/upload/:uploadId/complete", requireOwner, (req, res) => {
    try {
      const result = completeChunkedUpload(req.params.uploadId, req.body || {});
      res.status(result.deduplicated ? 200 : 201).json(result);
    } catch (err) {
      const status = err.code === "not_found" ? 404 : 400;
      res.status(status).json({ error: err.message, code: err.code });
    }
  });

  router.delete("/assets/upload/:uploadId", requireOwner, (req, res) => {
    res.json(cancelChunkedUpload(req.params.uploadId));
  });

  router.post("/assets/kenney/import", requireOwner, upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Kenney ZIP or file required (field: file)" });
    const tmpPath = req.file.path;
    try {
      const packName = req.body?.packName || null;
      const result = await importKenneyPack({
        archivePath: tmpPath,
        packName,
        packVersion: req.body?.packVersion || null,
      });
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    } finally {
      fs.rmSync(tmpPath, { force: true });
    }
  });

  router.post("/assets/sketchfab/download", requireOwner, async (req, res) => {
    const uid = req.body?.uid;
    if (!uid) return res.status(400).json({ error: "uid required" });
    try {
      const result = await downloadSketchfabModel(uid);
      res.status(result.deduplicated ? 200 : 201).json(result);
    } catch (err) {
      res.status(err.code === "auth" ? 401 : 400).json({ error: redactSecrets(err.message), code: err.code });
    }
  });

  /** Repair existing provider assets named exactly "scene" using authoritative titles. */
  router.post("/assets/migrate-scene-names", requireOwner, (req, res) => {
    const repairs = Array.isArray(req.body?.repairs) ? req.body.repairs : [];
    res.json(migrateSceneDisplayNames(repairs));
  });

  router.post("/assets/:id/import-unity", requireOwner, (req, res) => {
    const requestId = req.body?.requestId || randomUUID();
    const scenePath = typeof req.body?.scenePath === "string" ? req.body.scenePath.trim() : null;
    const result = enqueueUnityImport(req.params.id, requestId, { scenePath, placement: req.body?.placement });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(result.status).json(result);
  });

  /** Place an already-imported asset into a chosen Unity scene (connector → bridge). */
  router.post("/assets/:id/place-in-scene", requireOwner, (req, res) => {
    const requestId = req.body?.requestId || randomUUID();
    const scenePath = typeof req.body?.scenePath === "string" ? req.body.scenePath.trim() : "";
    const result = enqueuePlaceInScene(req.params.id, scenePath, requestId, req.body?.placement);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(result.status).json(result);
  });

  router.get("/assets/:id", requireOwner, (req, res) => {
    const asset = getAsset(req.params.id);
    if (!asset) return res.status(404).json({ error: "Asset not found" });
    res.json(asset);
  });

  /** Owner-only rename: changes displayName only; entrypoint/blob filenames stay intact. */
  router.patch("/assets/:id", requireOwner, (req, res) => {
    const next = req.body?.displayName ?? req.body?.name;
    const result = renameLibraryAsset(req.params.id, next);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  });

  /** Safe browser render descriptor (owner only). Never exposes Unity project paths. */
  router.get("/assets/:id/render-descriptor", requireOwner, (req, res) => {
    const gate = rejectUnsafeAssetId(req.params.id);
    if (!gate.ok) return res.status(gate.status).json({ error: gate.error });
    res.json(describeAssetForBrowser(gate.assetId));
  });

  /** Browser model source for details-route lazy viewer (owner only). */
  router.get("/assets/:id/model", requireOwner, (req, res) => {
    const blob = getAssetBlobPath(req.params.id);
    if (!blob) return res.status(404).json({ error: "Model blob not found" });
    res.sendFile(blob);
  });

  router.get("/assets/:id/model-dep/:name", requireOwner, (req, res) => {
    const asset = getAsset(req.params.id);
    if (!asset) return res.status(404).json({ error: "Asset not found", failed: req.params.name });
    // name may be encodeURIComponent("scene.bin") or encodeURIComponent("textures/x.png")
    let want = String(req.params.name || "");
    try {
      want = decodeURIComponent(want);
    } catch {
      /* keep raw */
    }
    want = want.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!want || want.includes("..")) {
      return res.status(400).json({ error: "Invalid dependency path.", failed: want });
    }
    const deps = asset.unity?.dependencies || [];
    const dep =
      deps.find((d) => d.relativePath === want) ||
      deps.find((d) => path.basename(d.relativePath) === path.basename(want)) ||
      null;
    if (!dep) {
      // Self-contained GLB / mis-resolved primary URL: never pretend a missing sidecar exists.
      // Hint empty deps so clients can skip further dep fetches without treating it as a hard asset miss.
      return res.status(404).json({
        error: "Dependency not found",
        failed: want,
        status: 404,
        dependencyCount: deps.length,
        selfContained: deps.length === 0,
        hint:
          deps.length === 0
            ? "Asset has no external model dependencies (self-contained). Use /api/assets/:id/model as the GLTFLoader entry URL."
            : "Use relativePath from asset.unity.dependencies, or /api/assets/:id/model for the entrypoint.",
      });
    }
    const blob = getDependencyBlobPath(req.params.id, dep.blobName);
    if (!blob) {
      return res.status(404).json({ error: "Dependency blob missing", failed: want, status: 404 });
    }
    const ext = path.extname(want).toLowerCase();
    const mime =
      ext === ".bin"
        ? "application/octet-stream"
        : ext === ".png"
          ? "image/png"
          : ext === ".jpg" || ext === ".jpeg"
            ? "image/jpeg"
            : ext === ".webp"
              ? "image/webp"
              : ext === ".gltf"
                ? "model/gltf+json"
                : "application/octet-stream";
    res.setHeader("Cache-Control", "private, max-age=60");
    res.type(mime);
    res.sendFile(blob);
  });

  /** Owner-only library delete — never removes Unity Imported/ copies. */
  router.delete("/assets/:id", requireOwner, (req, res) => {
    try {
      const result = deleteLibraryAsset(req.params.id);
      res.json(result);
    } catch (err) {
      res.status(err.code === "not_found" ? 404 : 400).json({
        error: err.message,
        code: err.code || "delete_failed",
        recovery: err.recovery || null,
      });
    }
  });

  // --- Sketchfab connections (owner-only; never return raw secret) ---
  router.get("/connections/sketchfab", requireOwner, (_req, res) => {
    const meta = getSketchfabMeta();
    res.json({
      provider: "sketchfab",
      ...meta,
    });
  });

  router.post("/connections/sketchfab/test", requireOwner, async (req, res) => {
    const token = req.body?.credential;
    if (!token || typeof token !== "string") {
      return res.status(400).json({ error: "credential required" });
    }
    try {
      const validation = await validateSketchfabToken(token);
      res.json({
        ok: true,
        accountLabel: validation.accountLabel,
        scopes: validation.scopes,
        validatedAt: new Date().toISOString(),
      });
    } catch (err) {
      res.status(err.code === "unavailable" ? 503 : 400).json({
        ok: false,
        error: redactSecrets(err.message),
        code: err.code || "provider",
      });
    }
  });

  router.post("/connections/sketchfab", requireOwner, async (req, res) => {
    const token = req.body?.credential;
    if (!token || typeof token !== "string") {
      return res.status(400).json({ error: "credential required" });
    }
    try {
      const validation = await validateSketchfabToken(token);
      const meta = await saveSketchfabToken(token, validation);
      res.json(meta);
    } catch (err) {
      res.status(err.code === "unavailable" ? 503 : 400).json({
        error: redactSecrets(err.message),
        code: err.code || "provider",
      });
    }
  });

  router.delete("/connections/sketchfab", requireOwner, (_req, res) => {
    res.json(clearSketchfabToken());
  });

  return router;
}

/** Bounded peek of glTF JSON `asset.name` (not for GLB binary chunks). */
function peekGltfAssetName(absolutePath) {
  try {
    const ext = path.extname(absolutePath).toLowerCase();
    if (ext !== ".gltf") return null;
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 8 * 1024 * 1024) return null;
    const raw = fs.readFileSync(absolutePath, "utf8");
    const cleaned = raw.replace(/^\uFEFF/, "").trim();
    if (!cleaned.startsWith("{")) return null;
    const doc = JSON.parse(cleaned);
    const name = doc?.asset?.name;
    if (typeof name === "string" && name.trim()) return name.trim().slice(0, 120);
    return null;
  } catch {
    return null;
  }
}

export { upload };
