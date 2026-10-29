export const ASSET_TYPES = Object.freeze([
  "image_2d",
  "sprite",
  "model_3d",
  "ui",
  "audio",
  "pixel",
  "texture",
  "material",
  "animation",
]);

export const ASSET_STATES = Object.freeze([
  "uploading",
  "uploaded",
  "processing",
  "preview_ready",
  "pending_unity",
  "importing_unity",
  "unity_imported",
  "failed",
  "unsupported",
]);

export const STATE_LABELS = Object.freeze({
  uploading: "Uploading",
  uploaded: "Uploaded",
  processing: "Processing",
  preview_ready: "Preview ready",
  pending_unity: "Pending Unity",
  importing_unity: "Importing to Unity",
  unity_imported: "Unity imported",
  failed: "Failed",
  unsupported: "Unsupported",
});

/** Extension → type mapping for Kenney / uploads */
export const EXT_TYPE = Object.freeze({
  ".png": "image_2d",
  ".jpg": "image_2d",
  ".jpeg": "image_2d",
  ".webp": "image_2d",
  ".gif": "image_2d",
  ".svg": "ui",
  ".glb": "model_3d",
  ".gltf": "model_3d",
  ".fbx": "model_3d",
  ".obj": "model_3d",
  ".wav": "audio",
  ".mp3": "audio",
  ".ogg": "audio",
  ".aiff": "audio",
  ".ttf": "ui",
  ".otf": "ui",
  ".anim": "animation",
  ".fbx.anim": "animation",
  ".hdr": "texture",
  ".exr": "texture",
});

export const ALLOWED_UPLOAD_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".svg",
  ".glb",
  ".gltf",
  ".fbx",
  ".obj",
  ".wav",
  ".mp3",
  ".ogg",
  ".aiff",
  ".ttf",
  ".otf",
  ".anim",
  ".hdr",
  ".exr",
  ".zip",
]);

export const UNITY_IMPORTABLE_EXTS = new Set([
  ".glb",
  ".gltf",
  ".fbx",
  ".png",
  ".jpg",
  ".jpeg",
  ".wav",
  ".ogg",
  ".hdr",
  ".exr",
]);

export const LIMITS = Object.freeze({
  maxFileBytes: 40 * 1024 * 1024,
  maxZipBytes: 80 * 1024 * 1024,
  maxExtractedBytes: 120 * 1024 * 1024,
  maxZipEntries: 500,
  maxChunkBytes: 2 * 1024 * 1024,
  storageQuotaBytes: 512 * 1024 * 1024,
});

const VALID_OVERRIDES = new Set(["model_3d", "animation"]);

/**
 * @param {string} fileName
 * @param {{ pixelHint?: boolean, kenneyCategory?: string|null, assetTypeOverride?: string|null }} [opts]
 */
export function classifyByName(fileName, { pixelHint = false, kenneyCategory = null, assetTypeOverride = null } = {}) {
  const lower = fileName.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "";

  if (assetTypeOverride) {
    if (!VALID_OVERRIDES.has(assetTypeOverride)) {
      return null;
    }
    // FBX may be model or animation; .anim is animation-only; glTF/GLB stay models.
    if (assetTypeOverride === "animation") {
      if (ext === ".fbx" || ext === ".anim") return "animation";
      return null;
    }
    if (assetTypeOverride === "model_3d") {
      if ([".glb", ".gltf", ".fbx", ".obj"].includes(ext)) return "model_3d";
      return null;
    }
  }

  const lowerName = fileName.toLowerCase();
  if (kenneyCategory === "Pixel" || pixelHint || /pixel|1bit|8bit/i.test(fileName)) {
    if ([".png", ".gif", ".webp"].includes(ext)) return "pixel";
  }
  if (kenneyCategory === "UI" && [".png", ".svg", ".jpg", ".jpeg"].includes(ext)) return "ui";
  if (kenneyCategory === "Textures" && [".png", ".jpg", ".jpeg", ".webp"].includes(ext)) return "texture";
  if (kenneyCategory === "Audio" && [".wav", ".mp3", ".ogg"].includes(ext)) return "audio";
  if (kenneyCategory === "3D" && [".glb", ".gltf", ".fbx", ".obj"].includes(ext)) return "model_3d";
  if (kenneyCategory === "2D" && [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) return "sprite";
  if (ext === ".anim" || /\.anim$/i.test(lowerName) || /animation|animclip/i.test(fileName)) {
    if (ext === ".fbx" || ext === ".anim") return "animation";
  }
  // Animation-named FBX only — bare "mixamo" in a character filename is still a model.
  if (ext === ".fbx" && /(?:^|[^a-z])(anim|idle|walk|run|attack|dance|wave|jump)(?:[^a-z]|$)/i.test(fileName)) {
    return "animation";
  }
  return EXT_TYPE[ext] || null;
}

export { VALID_OVERRIDES as ASSET_TYPE_OVERRIDES };

export function isUnityImportable(fileName, assetType) {
  const lower = fileName.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "";
  if (ext === ".usdz" || ext === ".usd") return false;
  // Unity imports FBX models natively; browser preview uses FBXLoader separately.
  if (assetType === "model_3d") return ext === ".glb" || ext === ".gltf" || ext === ".fbx";
  return UNITY_IMPORTABLE_EXTS.has(ext);
}
