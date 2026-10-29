import path from "node:path";
import { getAsset as catalogGetAsset, getAssetBlobPath as catalogGetAssetBlobPath } from "./assets/catalog.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BROWSER_MODEL_EXTS = new Set([".glb", ".gltf", ".fbx"]);

export function isValidAssetId(assetId) {
  return typeof assetId === "string" && UUID_RE.test(assetId.trim());
}

export function rejectUnsafeAssetId(assetId) {
  if (assetId == null || assetId === "") return { ok: false, status: 400, error: "assetId required" };
  const raw = String(assetId);
  if (raw.includes("..") || raw.includes("/") || raw.includes("\\") || raw.includes("\0")) {
    return { ok: false, status: 400, error: "Invalid assetId (path traversal rejected)." };
  }
  if (!isValidAssetId(raw)) {
    return { ok: false, status: 400, error: "assetId must be a UUID." };
  }
  return { ok: true, assetId: raw.trim() };
}

/**
 * Normalize catalog metadata into a browser model extension (".gltf" | ".glb" | ".fbx" | ""…).
 * Prefers authoritative Studio catalog fields used in production assets-catalog.json.
 * Does not treat arbitrary Unity project paths as browser URLs.
 */
export function normalizeBrowserModelExt(asset) {
  if (!asset || typeof asset !== "object") return "";

  const candidates = [];

  // Production catalog shape
  if (asset.fileFormat) candidates.push(String(asset.fileFormat));
  if (asset.entrypointFileName) candidates.push(String(asset.entrypointFileName));
  // Internal blobPath basename only (catalog-owned), never a user Unity path
  if (asset.blobPath) candidates.push(path.basename(String(asset.blobPath)));

  // Legacy / alternate shapes
  if (asset.unity?.entrypoint) candidates.push(String(asset.unity.entrypoint));
  if (asset.unity?.entrypointFileName) candidates.push(String(asset.unity.entrypointFileName));
  if (asset.originalName) candidates.push(String(asset.originalName));
  if (asset.fileName) candidates.push(String(asset.fileName));

  for (const raw of candidates) {
    const token = String(raw || "").trim().toLowerCase();
    if (!token) continue;
    if (token === "gltf" || token === "glb" || token === "fbx" || token === "obj") {
      return `.${token}`;
    }
    const ext = path.extname(token);
    if (ext) return ext;
  }
  return "";
}

/**
 * Safe browser render descriptor for one Hertz asset. Never exposes Unity filesystem paths.
 * @param {string} assetId
 * @param {{ getAsset?: Function, getAssetBlobPath?: Function }} [deps] injectable for fixture tests
 */
export function describeAssetForBrowser(assetId, deps = {}) {
  const getAssetFn = deps.getAsset || catalogGetAsset;
  const getBlobFn = deps.getAssetBlobPath || catalogGetAssetBlobPath;

  const gate = rejectUnsafeAssetId(assetId);
  if (!gate.ok) {
    return {
      assetId: String(assetId || ""),
      supported: false,
      status: "invalid",
      format: null,
      modelUrl: null,
      dependencyBase: null,
      fallbackReason: gate.error,
    };
  }
  const id = gate.assetId;
  const asset = getAssetFn(id);
  if (!asset) {
    return {
      assetId: id,
      supported: false,
      status: "missing",
      format: null,
      modelUrl: null,
      dependencyBase: null,
      fallbackReason: "Asset not found in catalog.",
    };
  }
  if (asset.deleted || asset.state === "deleted") {
    return {
      assetId: id,
      supported: false,
      status: "deleted",
      format: null,
      modelUrl: null,
      dependencyBase: null,
      fallbackReason: "Asset was deleted.",
    };
  }
  const ext = normalizeBrowserModelExt(asset);
  const blob = getBlobFn(id);
  if (!blob) {
    return {
      assetId: id,
      supported: false,
      status: "unsupported",
      format: ext ? ext.replace(".", "") : null,
      modelUrl: null,
      dependencyBase: null,
      fallbackReason: "Model blob missing.",
    };
  }
  if (!BROWSER_MODEL_EXTS.has(ext)) {
    return {
      assetId: id,
      supported: false,
      status: "unsupported",
      format: ext ? ext.replace(".", "") : null,
      modelUrl: null,
      dependencyBase: null,
      fallbackReason: `Format ${ext || "(unknown)"} is not browser-previewable (use GLB/GLTF/FBX).`,
    };
  }
  return {
    assetId: id,
    supported: true,
    status: "ready",
    format: ext.replace(".", ""),
    modelUrl: `/api/assets/${id}/model`,
    dependencyBase: `/api/assets/${id}/model-dep/`,
    fallbackReason: null,
    displayName: asset.displayName || null,
    assetType: asset.assetType || null,
  };
}

/**
 * Index native mesh files from a render-snapshot manifest (already loaded) or summary.
 * Manifest meshes[]: { objectId, file, category }.
 */
export function indexNativeMeshUrls(renderSnapshot, manifestMeshes = null) {
  const byObjectId = new Map();
  const snapshotId = renderSnapshot?.snapshotId || null;
  if (!snapshotId) return byObjectId;
  const list = Array.isArray(manifestMeshes)
    ? manifestMeshes
    : Array.isArray(renderSnapshot?.meshes)
      ? renderSnapshot.meshes
      : [];
  for (const entry of list) {
    if (!entry?.objectId || !entry?.file) continue;
    const file = String(entry.file).replace(/^\/+/, "");
    if (file.includes("..")) continue;
    const base = path.basename(file);
    if (!/^[A-Za-z0-9._-]+\.(glb|hmsh)$/i.test(base)) continue;
    const declaredFormat = String(entry.meshFormat || "").toLowerCase();
    // Prefer declared format; bare .hmsh without declaration is treated as legacy hmsh1.
    // The loader also reads the binary version and rejects unknown versions.
    const meshFormat = base.toLowerCase().endsWith(".hmsh")
      ? declaredFormat === "hmsh2"
        ? "hmsh2"
        : "hmsh1"
      : "glb";
    byObjectId.set(entry.objectId, {
      modelUrl: `/api/render-snapshots/${snapshotId}/meshes/${base}`,
      category: entry.category || "native_mesh",
      meshKey: entry.meshKey || null,
      meshFormat,
      baseColor: entry.baseColor || null,
      materials: Array.isArray(entry.materials) ? entry.materials : null,
    });
  }
  return byObjectId;
}

/**
 * Batched descriptors for a draft's objects. Deduplicates by assetId.
 * @param {object[]} objects
 * @param {{ getAsset?: Function, getAssetBlobPath?: Function, renderSnapshot?: object, nativeMeshByObjectId?: Map }} [deps]
 */
export function buildDraftRenderDescriptors(objects = [], deps = {}) {
  const byAssetId = new Map();
  const objectsOut = [];
  const nativeById =
    deps.nativeMeshByObjectId ||
    indexNativeMeshUrls(deps.renderSnapshot || null, deps.renderSnapshot?.meshes || null);

  for (const obj of Array.isArray(objects) ? objects : []) {
    if (!obj || obj.removed) continue;
    const objectId = obj.objectId || obj.unityObjectId || null;
    const assetId = obj.assetId || null;
    const renderRole = obj.renderRole || null;
    const renderCategory = obj.renderCategory || null;
    const native = objectId ? nativeById.get(objectId) : null;

    // Catalog model roots keep catalog GLTF priority.
    const isCatalogRoot =
      Boolean(assetId) &&
      (renderRole === "model_root" ||
        renderCategory === "catalog_model_root" ||
        obj.prefabInstanceRoot === true);

    if (assetId && isCatalogRoot) {
      let assetDesc = byAssetId.get(assetId);
      if (!assetDesc) {
        assetDesc = describeAssetForBrowser(assetId, deps);
        byAssetId.set(assetId, assetDesc);
      }
      objectsOut.push({
        objectId,
        assetId,
        renderRole,
        renderCategory: renderCategory || "catalog_model_root",
        supported: Boolean(assetDesc.supported),
        status: assetDesc.status,
        format: assetDesc.format,
        modelUrl: assetDesc.supported ? assetDesc.modelUrl : null,
        dependencyBase: assetDesc.supported ? assetDesc.dependencyBase : null,
        fallbackReason: assetDesc.fallbackReason,
        sourceType: "catalog",
        bounds: obj.bounds || null,
      });
      continue;
    }

    if (assetId && !isCatalogRoot) {
      objectsOut.push({
        objectId,
        assetId,
        renderRole,
        renderCategory: renderCategory || "native_mesh",
        supported: false,
        status: "delegated_to_root",
        format: null,
        modelUrl: null,
        dependencyBase: null,
        fallbackReason: "Descendant of a model root - not loaded separately.",
        sourceType: "catalog_child",
        bounds: obj.bounds || null,
      });
      continue;
    }

    if (native?.modelUrl) {
      objectsOut.push({
        objectId,
        assetId: null,
        renderRole,
        renderCategory: renderCategory || native.category || "native_mesh",
        supported: true,
        status: "ready",
        format: native.meshFormat || "hmsh2",
        modelUrl: native.modelUrl,
        dependencyBase: null,
        fallbackReason: null,
        sourceType: "native_snapshot",
        baseColor: native.baseColor || null,
        materials: native.materials || null,
        bounds: obj.bounds || null,
      });
      continue;
    }

    objectsOut.push({
      objectId,
      assetId: null,
      renderRole,
      renderCategory: renderCategory || null,
      supported: false,
      status: "unsupported",
      format: null,
      modelUrl: null,
      dependencyBase: null,
      fallbackReason:
        renderCategory === "camera" || renderCategory === "light" || renderCategory === "xr_protected"
          ? "Helper / protected Unity object (not a browsable model)."
          : renderCategory === "empty" || renderCategory === "collider_only"
            ? "Hierarchy container or collider-only (no mesh geometry)."
            : "No Hertz assetId and no native mesh snapshot for this object.",
      sourceType: "none",
      bounds: obj.bounds || null,
    });
  }
  return {
    objects: objectsOut,
    assets: [...byAssetId.values()],
    renderSnapshot: deps.renderSnapshot
      ? {
          snapshotId: deps.renderSnapshot.snapshotId || null,
          manifestUrl: deps.renderSnapshot.manifestUrl || null,
          meshCount: deps.renderSnapshot.meshCount ?? null,
        }
      : null,
  };
}

/** True when a cached scene export predates hierarchy/renderRole/native-mesh provenance. */
export function isLegacySceneExport(exportPayload) {
  if (!exportPayload || !Array.isArray(exportPayload.objects) || exportPayload.objects.length === 0) {
    return true;
  }
  const schema = Number(exportPayload.exportSchemaVersion || 0);
  // Schema 3 adds renderSnapshot + renderCategory for native Unity meshes.
  if (schema >= 3) return false;
  if (schema >= 2 && exportPayload.renderSnapshot?.snapshotId) return false;
  if (schema >= 2) return false;
  return !exportPayload.objects.some(
    (o) => o && (o.renderRole || o.parentObjectId !== undefined || o.rootObjectId || o.assetId),
  );
}
