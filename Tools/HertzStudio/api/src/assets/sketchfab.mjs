import fs from "node:fs";
import path from "node:path";
import { readSketchfabToken, redactSecrets } from "./secrets.mjs";
import { ingestFile, getTmpDir } from "./catalog.mjs";
import { LIMITS } from "./types.mjs";
import { safeExtractZip } from "./zip-safe.mjs";

const API = "https://api.sketchfab.com/v3";

async function sketchfabFetch(pathname, { token, method = "GET", body } = {}) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      Authorization: `Token ${token}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text?.slice(0, 200) };
  }
  if (!res.ok) {
    const err = new Error(redactSecrets(data.error || data.detail || `Sketchfab HTTP ${res.status}`));
    err.status = res.status;
    err.code =
      res.status === 401 || res.status === 403
        ? "auth"
        : res.status === 429
          ? "rate_limit"
          : "provider";
    throw err;
  }
  return data;
}

export async function validateSketchfabToken(token) {
  const trimmed = String(token || "").trim();
  if (!trimmed) {
    const err = new Error("Credential required.");
    err.code = "auth";
    throw err;
  }
  try {
    const me = await sketchfabFetch("/me", { token: trimmed });
    return {
      ok: true,
      accountLabel: me.displayName || me.username || me.uid || "Sketchfab account",
      scopes: Array.isArray(me.subscriptions) ? me.subscriptions.map((s) => s.type || "sub") : [],
      uid: me.uid || null,
    };
  } catch (err) {
    if (err.code === "auth") throw err;
    if (err.cause || /fetch failed|ENOTFOUND|network/i.test(err.message)) {
      const e = new Error("Sketchfab unreachable. Credential not saved. Verification pending.");
      e.code = "unavailable";
      throw e;
    }
    throw err;
  }
}

export async function searchSketchfab({ q = "", cursor = null, type = "models" } = {}) {
  const token = await readSketchfabToken();
  if (!token) {
    return {
      pending: true,
      configured: false,
      results: [],
      next: null,
      message: "Sketchfab credential not configured. Add it on Connections.",
    };
  }
  const params = new URLSearchParams({
    type,
    q: q || "game",
    downloadable: "true",
    count: "24",
  });
  if (cursor) params.set("cursor", cursor);
  try {
    const data = await sketchfabFetch(`/search?${params}`, { token });
    const results = (data.results || []).map((m) => ({
      uid: m.uid,
      id: `sketchfab:${m.uid}`,
      name: m.name,
      description: (m.description || "").slice(0, 280),
      author: m.user?.displayName || m.user?.username || null,
      license: m.license?.label || m.license?.slug || null,
      sourceUrl: m.viewerUrl || `https://sketchfab.com/3d-models/${m.uid}`,
      thumbnails: m.thumbnails?.images?.[0]?.url || null,
      thumbnailUrl: m.thumbnails?.images?.[0]?.url || null,
      isDownloadable: Boolean(m.isDownloadable),
      provider: "sketchfab",
      assetTypes: ["model_3d"],
    }));
    return {
      pending: false,
      configured: true,
      results,
      next: data.cursors?.next || null,
    };
  } catch (err) {
    if (err.code === "rate_limit") {
      return {
        pending: false,
        configured: true,
        results: [],
        next: null,
        error: "Sketchfab rate limit reached. Try again later.",
      };
    }
    if (err.code === "auth") {
      return {
        pending: false,
        configured: true,
        results: [],
        next: null,
        error: "Sketchfab credential rejected or missing scope. Replace it on Connections.",
      };
    }
    return {
      pending: true,
      configured: true,
      results: [],
      next: null,
      error: redactSecrets(err.message),
      message: "Sketchfab search unavailable; provider verification pending.",
    };
  }
}

/** Provider metadata for details screen — Unknown when fields are absent. */
export async function getSketchfabModelDetail(uid) {
  const token = await readSketchfabToken();
  if (!token) {
    return {
      uid,
      id: `sketchfab:${uid}`,
      name: uid,
      provider: "sketchfab",
      sourceUrl: `https://sketchfab.com/3d-models/${uid}`,
      pending: true,
      configured: false,
      kind: "discovery",
      embedAvailable: true,
      message: "Sketchfab credential not configured. Preview embed may still load; import requires a credential.",
      providerDimensions: "Unknown",
      providerTriangles: "Unknown",
      providerVertices: "Unknown",
      providerRigged: "Unknown",
      providerAnimations: "Unknown",
    };
  }
  try {
    const m = await sketchfabFetch(`/models/${encodeURIComponent(uid)}`, { token });
    const faceCount = m.faceCount ?? m.animationCount ?? null;
    return {
      uid: m.uid || uid,
      id: `sketchfab:${m.uid || uid}`,
      name: m.name || uid,
      description: (m.description || "").slice(0, 500),
      author: m.user?.displayName || m.user?.username || null,
      license: m.license?.label || m.license?.slug || null,
      sourceUrl: m.viewerUrl || `https://sketchfab.com/3d-models/${uid}`,
      thumbnailUrl: m.thumbnails?.images?.[0]?.url || null,
      thumbnails: m.thumbnails?.images?.[0]?.url || null,
      byteSize: m.archives?.gltf?.size || m.archives?.glb?.size || null,
      isDownloadable: Boolean(m.isDownloadable),
      provider: "sketchfab",
      kind: "discovery",
      configured: true,
      pending: false,
      embedAvailable: true,
      providerDimensions: m.sound || m.dimensions || "Unknown",
      providerTriangles: m.faceCount ?? "Unknown",
      providerVertices: m.vertexCount ?? "Unknown",
      providerRigged: typeof m.isRigged === "boolean" ? (m.isRigged ? "Yes" : "No") : "Unknown",
      providerAnimations: m.animationCount ?? "Unknown",
      faceCount,
      vertexCount: m.vertexCount ?? null,
      animationCount: m.animationCount ?? null,
      isRigged: typeof m.isRigged === "boolean" ? (m.isRigged ? "Yes" : "No") : "Unknown",
    };
  } catch (err) {
    return {
      uid,
      id: `sketchfab:${uid}`,
      name: uid,
      provider: "sketchfab",
      sourceUrl: `https://sketchfab.com/3d-models/${uid}`,
      configured: true,
      pending: err.code === "unavailable",
      kind: "discovery",
      embedAvailable: true,
      error: redactSecrets(err.message),
      message: "Could not load Sketchfab metadata. Embed may still work; values shown as Unknown.",
      providerDimensions: "Unknown",
      providerTriangles: "Unknown",
      providerVertices: "Unknown",
      providerRigged: "Unknown",
      providerAnimations: "Unknown",
    };
  }
}

/**
 * Download Sketchfab glTF archive (ZIP) without sending the account token to the signed URL.
 * Extracts safely and ingests the entrypoint while retaining dependency files.
 */
export async function downloadSketchfabModel(uid) {
  const token = await readSketchfabToken();
  if (!token) {
    const err = new Error("Sketchfab credential not configured.");
    err.code = "auth";
    throw err;
  }
  const meta = await sketchfabFetch(`/models/${encodeURIComponent(uid)}`, { token });
  let downloadInfo;
  try {
    downloadInfo = await sketchfabFetch(`/models/${encodeURIComponent(uid)}/download`, { token });
  } catch (err) {
    if (err.code === "auth") throw err;
    const e = new Error(redactSecrets(err.message || "Download not permitted for this model."));
    e.code = err.code || "provider";
    throw e;
  }

  const gltfArchive = downloadInfo.gltf || downloadInfo.archives?.gltf;
  const glbDirect = downloadInfo.glb;
  const url = gltfArchive?.url || glbDirect?.url;
  if (!url) {
    const err = new Error("No permitted glTF/GLB download URL for this model.");
    err.code = "unsupported";
    throw err;
  }

  // Signed archive URLs must not receive the Sketchfab account token.
  const res = await fetch(url);
  if (!res.ok) {
    const err = new Error(`Sketchfab download failed (${res.status}).`);
    err.code = res.status === 429 ? "rate_limit" : "provider";
    throw err;
  }

  const contentLength = Number(res.headers.get("content-length") || 0);
  if (contentLength > LIMITS.maxZipBytes) {
    throw new Error("Downloaded archive exceeds max size.");
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > LIMITS.maxZipBytes) {
    throw new Error("Downloaded archive exceeds max size.");
  }

  const tmpRoot = path.join(getTmpDir(), `sketchfab-${uid}-${Date.now()}`);
  fs.mkdirSync(tmpRoot, { recursive: true });
  const archivePath = path.join(tmpRoot, "download.bin");
  fs.writeFileSync(archivePath, buf);

  try {
    const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
    let entryPath = archivePath;
    let dependencies = [];
    // Entrypoint filename stays as archive provides (often scene.gltf); display uses provider title.
    let originalName = `${(meta.name || uid).replace(/[^\w\-]+/g, "_")}.glb`;
    let entrypointFileName = originalName;

    if (isZip || gltfArchive) {
      const outDir = path.join(tmpRoot, "extracted");
      const extracted = await safeExtractZip(archivePath, outDir);
      const entry =
        extracted.files.find((f) => /\.gltf$/i.test(f.relativePath)) ||
        extracted.files.find((f) => /\.glb$/i.test(f.relativePath));
      if (!entry) {
        throw new Error("Sketchfab archive contained no glTF/GLB entrypoint.");
      }
      entryPath = entry.absolutePath;
      originalName = path.basename(entry.relativePath);
      entrypointFileName = originalName;
      const entryRel = String(entry.relativePath || "").replace(/\\/g, "/");
      const entryDir = path.posix.dirname(entryRel);
      dependencies = extracted.files
        .filter((f) => f.absolutePath !== entry.absolutePath)
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
    }

    // Bounded public CDN thumbnail (no Sketchfab credential on this URL).
    let previewImagePath = null;
    const thumbImages = [...(meta.thumbnails?.images || [])].sort(
      (a, b) => (Number(b.width) || 0) - (Number(a.width) || 0),
    );
    const thumbUrl = thumbImages[0]?.url || meta.thumbnails?.url || null;
    if (thumbUrl && /^https:\/\//i.test(thumbUrl)) {
      try {
        const tRes = await fetch(thumbUrl);
        if (tRes.ok) {
          const tBuf = Buffer.from(await tRes.arrayBuffer());
          if (tBuf.length > 0 && tBuf.length <= 8 * 1024 * 1024) {
            const tExt = /\.jpe?g/i.test(thumbUrl) ? ".jpg" : /\.webp/i.test(thumbUrl) ? ".webp" : ".png";
            previewImagePath = path.join(tmpRoot, `thumb${tExt}`);
            fs.writeFileSync(previewImagePath, tBuf);
          }
        }
      } catch {
        previewImagePath = null;
      }
    }

    const result = ingestFile({
      absolutePath: entryPath,
      originalName,
      entrypointFileName,
      displayName: meta.name || meta.title || uid,
      provider: "sketchfab",
      sourceUrl: meta.viewerUrl || `https://sketchfab.com/3d-models/${uid}`,
      author: meta.user?.displayName || meta.user?.username || null,
      license: meta.license?.label || meta.license?.slug || "sketchfab",
      description: (meta.description || "").slice(0, 500),
      dependencies,
      previewImagePath,
    });

    return {
      asset: result.asset,
      deduplicated: result.deduplicated,
      attribution: {
        author: meta.user?.displayName || meta.user?.username || null,
        sourceUrl: meta.viewerUrl || `https://sketchfab.com/3d-models/${uid}`,
        license: meta.license?.label || meta.license?.slug || null,
        title: meta.name || uid,
      },
    };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}
