import { api } from "../api.js";

const RESUME_KEY = "hertz.studio.upload.resume/v1";

/**
 * Persist non-secret resume metadata (never file bytes or credentials).
 */
export function loadResumeMeta() {
  try {
    const raw = localStorage.getItem(RESUME_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.uploadId || !parsed?.fileName || !parsed?.byteSize) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveResumeMeta(meta) {
  localStorage.setItem(RESUME_KEY, JSON.stringify(meta));
}

export function clearResumeMeta() {
  localStorage.removeItem(RESUME_KEY);
}

async function putChunk(uploadId, blob, offset, signal) {
  const fd = new FormData();
  fd.append("chunk", blob, `chunk-${offset}`);
  const res = await fetch(`/api/assets/upload/${uploadId}/chunk`, {
    method: "PUT",
    credentials: "include",
    headers: { "x-hertz-chunk-offset": String(offset) },
    body: fd,
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Chunk failed (${res.status})`);
  return data;
}

/**
 * Resumable chunked upload with progress, cancel (server session delete), and
 * restart-safe resume from persisted uploadId + server-reported offset.
 */
export async function uploadFileChunked(
  file,
  { onProgress, signal, chunkSize = 2 * 1024 * 1024, assetTypeOverride = null } = {},
) {
  const init = await api("/api/assets/upload/init", {
    method: "POST",
    body: JSON.stringify({
      fileName: file.name,
      byteSize: file.size,
      assetTypeOverride: assetTypeOverride || undefined,
    }),
    signal,
  });
  if (init.deduplicated) {
    clearResumeMeta();
    onProgress?.({ loaded: file.size, total: file.size, pct: 100 });
    return init;
  }

  const uploadId = init.uploadId;
  let offset = Number(init.received || 0);
  const size = file.size;
  saveResumeMeta({
    uploadId,
    fileName: file.name,
    byteSize: size,
    offset,
    assetTypeOverride: assetTypeOverride || null,
    updatedAt: new Date().toISOString(),
  });

  try {
    while (offset < size) {
      if (signal?.aborted) {
        await api(`/api/assets/upload/${uploadId}`, { method: "DELETE" }).catch(() => {});
        clearResumeMeta();
        const err = new Error("Upload cancelled");
        err.code = "cancelled";
        throw err;
      }
      const end = Math.min(offset + chunkSize, size);
      const blob = file.slice(offset, end);
      let data;
      try {
        data = await putChunk(uploadId, blob, offset, signal);
      } catch (err) {
        if (signal?.aborted || err.name === "AbortError") {
          await api(`/api/assets/upload/${uploadId}`, { method: "DELETE" }).catch(() => {});
          clearResumeMeta();
          const cancelErr = new Error("Upload cancelled");
          cancelErr.code = "cancelled";
          throw cancelErr;
        }
        // Leave session for resume; refresh offset from server if present.
        err.uploadId = uploadId;
        err.offset = data?.received ?? offset;
        saveResumeMeta({
          uploadId,
          fileName: file.name,
          byteSize: size,
          offset: err.offset,
          assetTypeOverride: assetTypeOverride || null,
          updatedAt: new Date().toISOString(),
        });
        throw err;
      }
      offset = data.received ?? end;
      saveResumeMeta({
        uploadId,
        fileName: file.name,
        byteSize: size,
        offset,
        assetTypeOverride: assetTypeOverride || null,
        updatedAt: new Date().toISOString(),
      });
      onProgress?.({
        loaded: offset,
        total: size,
        pct: Math.round((100 * offset) / size),
        uploadId,
      });
    }

    const completed = await api(`/api/assets/upload/${uploadId}/complete`, {
      method: "POST",
      body: JSON.stringify({ assetTypeOverride: assetTypeOverride || undefined }),
      signal,
    });
    clearResumeMeta();
    return completed;
  } catch (err) {
    if (err.code === "cancelled") throw err;
    err.uploadId = err.uploadId || uploadId;
    err.offset = err.offset ?? offset;
    throw err;
  }
}

export async function resumeChunkedUpload(
  file,
  uploadId,
  offset,
  { onProgress, signal, chunkSize = 2 * 1024 * 1024, assetTypeOverride = null } = {},
) {
  // Reconcile with server session if available.
  let pos = Number(offset) || 0;
  try {
    const status = await api(`/api/assets/upload/${uploadId}`);
    if (typeof status.received === "number") pos = status.received;
  } catch {
    /* use local offset */
  }

  if (file.size !== (loadResumeMeta()?.byteSize || file.size) && loadResumeMeta()?.fileName === file.name) {
    // Allow reselect of same name/size; size mismatch rejects.
  }
  const meta = loadResumeMeta();
  if (meta && meta.fileName === file.name && meta.byteSize !== file.size) {
    const err = new Error("Selected file size does not match the interrupted upload. Clear and start over.");
    err.code = "resume_mismatch";
    throw err;
  }

  const size = file.size;
  while (pos < size) {
    if (signal?.aborted) {
      await api(`/api/assets/upload/${uploadId}`, { method: "DELETE" }).catch(() => {});
      clearResumeMeta();
      const err = new Error("Upload cancelled");
      err.code = "cancelled";
      throw err;
    }
    const end = Math.min(pos + chunkSize, size);
    const blob = file.slice(pos, end);
    try {
      const data = await putChunk(uploadId, blob, pos, signal);
      pos = data.received ?? end;
    } catch (err) {
      if (signal?.aborted || err.name === "AbortError") {
        await api(`/api/assets/upload/${uploadId}`, { method: "DELETE" }).catch(() => {});
        clearResumeMeta();
        const cancelErr = new Error("Upload cancelled");
        cancelErr.code = "cancelled";
        throw cancelErr;
      }
      saveResumeMeta({
        uploadId,
        fileName: file.name,
        byteSize: size,
        offset: pos,
        assetTypeOverride: assetTypeOverride || meta?.assetTypeOverride || null,
        updatedAt: new Date().toISOString(),
      });
      err.uploadId = uploadId;
      err.offset = pos;
      throw err;
    }
    saveResumeMeta({
      uploadId,
      fileName: file.name,
      byteSize: size,
      offset: pos,
      assetTypeOverride: assetTypeOverride || meta?.assetTypeOverride || null,
      updatedAt: new Date().toISOString(),
    });
    onProgress?.({ loaded: pos, total: size, pct: Math.round((100 * pos) / size), uploadId });
  }
  const completed = await api(`/api/assets/upload/${uploadId}/complete`, {
    method: "POST",
    body: JSON.stringify({
      assetTypeOverride: assetTypeOverride || meta?.assetTypeOverride || undefined,
    }),
    signal,
  });
  clearResumeMeta();
  return completed;
}

export const LIBRARY_DRAG_MIME = "application/x-hertz-asset";

export function libraryDragPayload(asset) {
  return JSON.stringify({
    schema: "hertz.studio.asset/v1",
    id: asset.id,
    assetType: asset.assetType,
    displayName: asset.displayName,
    provider: asset.provider,
    state: asset.state,
    previewUrl: asset.preview?.url || null,
  });
}
