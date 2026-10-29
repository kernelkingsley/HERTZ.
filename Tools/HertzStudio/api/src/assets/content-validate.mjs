import fs from "node:fs";
import path from "node:path";
import { LIMITS } from "./types.mjs";

const MAX_GLTF_JSON_BYTES = Math.min(LIMITS.maxFileBytes || 40 * 1024 * 1024, 32 * 1024 * 1024);

function readHead(absolutePath, max = 64) {
  const fd = fs.openSync(absolutePath, "r");
  try {
    const size = fs.fstatSync(fd).size || 0;
    const buf = Buffer.alloc(Math.min(max, size));
    if (buf.length) fs.readSync(fd, buf, 0, buf.length, 0);
    return { buf, size };
  } finally {
    fs.closeSync(fd);
  }
}

function stripBom(text) {
  return text.replace(/^\uFEFF/, "");
}

function isSafeRelativeUri(uri) {
  if (!uri || typeof uri !== "string") return false;
  if (/^(data:|https?:|blob:)/i.test(uri)) return true;
  const normalized = uri.replace(/\\/g, "/");
  if (path.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) return false;
  if (normalized.includes("\0")) return false;
  if (normalized.split("/").some((p) => p === "..")) return false;
  return true;
}

/**
 * Full bounded glTF JSON parse — first-64-byte heuristics reject real Sketchfab exports
 * that put whitespace/BOM before `{` or `"asset"` later in the document.
 */
export function validateGltfJsonDocument(absolutePath, { maxBytes = MAX_GLTF_JSON_BYTES } = {}) {
  const st = fs.statSync(absolutePath);
  if (st.size <= 0) return { ok: false, error: "Empty glTF rejected." };
  if (st.size > maxBytes) return { ok: false, error: `glTF JSON exceeds max size (${maxBytes} bytes).` };

  let raw;
  try {
    raw = fs.readFileSync(absolutePath);
  } catch (err) {
    return { ok: false, error: `Cannot read glTF: ${err.message}` };
  }

  const text = stripBom(raw.toString("utf8")).trimStart();
  if (!text.startsWith("{")) {
    return { ok: false, error: "Content is not a glTF JSON document." };
  }

  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `glTF JSON parse failed: ${err.message}` };
  }

  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, error: "Content is not a glTF JSON document." };
  }
  if (!doc.asset || typeof doc.asset !== "object" || !doc.asset.version) {
    return { ok: false, error: "glTF missing required asset.version." };
  }
  const version = String(doc.asset.version);
  if (!/^2\./.test(version) && version !== "2.0") {
    // Accept glTF 2.x only for Studio/glTFast path.
    if (!version.startsWith("2")) {
      return { ok: false, error: `Unsupported glTF version: ${version}` };
    }
  }

  const badUris = [];
  for (const buffer of doc.buffers || []) {
    if (buffer?.uri && !isSafeRelativeUri(buffer.uri)) badUris.push(buffer.uri);
  }
  for (const image of doc.images || []) {
    if (image?.uri && !isSafeRelativeUri(image.uri)) badUris.push(image.uri);
  }
  for (const shader of [...(doc.shaders || []), ...((doc.extensionsUsed && []) || [])]) {
    if (shader?.uri && !isSafeRelativeUri(shader.uri)) badUris.push(shader.uri);
  }
  if (badUris.length) {
    return { ok: false, error: `glTF has unsafe dependency URI: ${badUris[0]}` };
  }

  return {
    ok: true,
    kind: "model",
    gltf: {
      version: doc.asset.version,
      generator: doc.asset.generator || null,
      meshCount: Array.isArray(doc.meshes) ? doc.meshes.length : 0,
      materialCount: Array.isArray(doc.materials) ? doc.materials.length : 0,
      animationCount: Array.isArray(doc.animations) ? doc.animations.length : 0,
      hasSkins: Array.isArray(doc.skins) && doc.skins.length > 0,
      bufferUris: (doc.buffers || []).map((b) => b.uri).filter(Boolean),
      imageUris: (doc.images || []).map((i) => i.uri).filter(Boolean),
    },
  };
}

function validateGlbStructure(absolutePath) {
  const st = fs.statSync(absolutePath);
  if (st.size < 20) return { ok: false, error: "GLB too small." };
  const fd = fs.openSync(absolutePath, "r");
  try {
    const header = Buffer.alloc(12);
    fs.readSync(fd, header, 0, 12, 0);
    if (header.slice(0, 4).toString("ascii") !== "glTF") {
      return { ok: false, error: "Content is not a GLB (bad signature)." };
    }
    const version = header.readUInt32LE(4);
    const length = header.readUInt32LE(8);
    if (version !== 2) return { ok: false, error: `Unsupported GLB version: ${version}` };
    if (length !== st.size) {
      return { ok: false, error: "GLB declared length does not match file size." };
    }
    const chunkHeader = Buffer.alloc(8);
    fs.readSync(fd, chunkHeader, 0, 8, 12);
    const chunkLen = chunkHeader.readUInt32LE(0);
    const chunkType = chunkHeader.readUInt32LE(4);
    if (chunkType !== 0x4e4f534a) {
      return { ok: false, error: "GLB missing JSON chunk." };
    }
    if (12 + 8 + chunkLen > st.size) {
      return { ok: false, error: "GLB JSON chunk extends past file end." };
    }
    return { ok: true, kind: "model" };
  } finally {
    fs.closeSync(fd);
  }
}

function validateFont(absolutePath) {
  const { buf } = readHead(absolutePath, 8);
  if (buf.length < 4) return { ok: false, error: "Font file too small." };
  const tag = buf.slice(0, 4).toString("latin1");
  const sfnt = buf.readUInt32BE(0);
  // TrueType / OpenType / WOFF-ish SFNT
  if (sfnt === 0x00010000 || tag === "OTTO" || tag === "true" || tag === "typ1") {
    return { ok: true, kind: "ui" };
  }
  return { ok: false, error: "Content does not look like TTF/OTF." };
}

function validateAnim(absolutePath) {
  const { buf, size } = readHead(absolutePath, 256);
  if (!size) return { ok: false, error: "Empty animation rejected." };
  const text = buf.toString("utf8");
  if (text.startsWith("%YAML") || text.includes("AnimationClip") || text.includes("m_AnimationClip")) {
    return { ok: true, kind: "animation" };
  }
  // Unity binary serialized assets are opaque; require a non-empty bounded file with no path tricks.
  if (size >= 16 && size <= LIMITS.maxFileBytes) {
    return { ok: true, kind: "animation", note: "binary_anim_accepted_by_size" };
  }
  return { ok: false, error: "Content does not look like a Unity animation clip." };
}

/**
 * Server-side content/signature validation — extension alone is not enough.
 * @returns {{ ok: true, kind: string, gltf?: object } | { ok: false, error: string }}
 */
export function validateFileContent(absolutePath, originalName) {
  const ext = path.extname(originalName || absolutePath).toLowerCase();
  let head;
  try {
    head = readHead(absolutePath, 64);
  } catch (err) {
    return { ok: false, error: `Cannot read file: ${err.message}` };
  }
  const { buf, size } = head;

  if (!buf.length || !size) {
    return { ok: false, error: "Empty file rejected." };
  }

  // Reject "looks like magic but truncated" for formats that declare longer structures later.
  const isPng = buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const isJpeg = buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const gifHead = buf.length >= 6 ? buf.slice(0, 6).toString("ascii") : "";
  const isGif = gifHead === "GIF89a" || gifHead === "GIF87a";
  const isWebp =
    buf.length >= 12 &&
    buf.slice(0, 4).toString("ascii") === "RIFF" &&
    buf.slice(8, 12).toString("ascii") === "WEBP";
  const isWav =
    buf.length >= 12 &&
    buf.slice(0, 4).toString("ascii") === "RIFF" &&
    buf.slice(8, 12).toString("ascii") === "WAVE";
  const isOgg = buf.length >= 4 && buf.slice(0, 4).toString("ascii") === "OggS";
  const isMp3 =
    (buf.length >= 3 && buf.slice(0, 3).toString("ascii") === "ID3") ||
    (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);
  const isZip =
    buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
  const isSvg = buf.slice(0, Math.min(buf.length, 256)).toString("utf8").includes("<svg");
  const textHead = stripBom(buf.slice(0, Math.min(buf.length, 256)).toString("utf8")).trimStart();
  const isObj = /^o\s|^v\s|#/.test(textHead);
  const isAiff =
    buf.length >= 12 &&
    buf.slice(0, 4).toString("ascii") === "FORM" &&
    buf.slice(8, 12).toString("ascii") === "AIFF";

  const imageExts = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
  const audioExts = new Set([".wav", ".mp3", ".ogg", ".aiff"]);

  if (ext === ".png") {
    if (!isPng || size < 67) return { ok: false, error: "Content is not a PNG (bad signature)." };
    return { ok: true, kind: "image" };
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    if (!isJpeg || size < 100) return { ok: false, error: "Content is not a JPEG (bad signature)." };
    return { ok: true, kind: "image" };
  }
  if (ext === ".gif") {
    if (!isGif || size < 14) return { ok: false, error: "Content is not a GIF (bad signature)." };
    return { ok: true, kind: "image" };
  }
  if (ext === ".webp") {
    if (!isWebp || size < 16) return { ok: false, error: "Content is not a WEBP (bad signature)." };
    return { ok: true, kind: "image" };
  }
  if (ext === ".wav") {
    if (!isWav || size < 44) return { ok: false, error: "Content is not a WAV (bad signature)." };
    return { ok: true, kind: "audio" };
  }
  if (ext === ".ogg") {
    if (!isOgg || size < 28) return { ok: false, error: "Content is not Ogg (bad signature)." };
    return { ok: true, kind: "audio" };
  }
  if (ext === ".mp3") {
    if (!isMp3 || size < 128) return { ok: false, error: "Content is not MP3 (bad signature)." };
    return { ok: true, kind: "audio" };
  }
  if (ext === ".aiff") {
    if (!isAiff || size < 54) return { ok: false, error: "Content is not AIFF (bad signature)." };
    return { ok: true, kind: "audio" };
  }
  if (ext === ".glb") return validateGlbStructure(absolutePath);
  if (ext === ".gltf") return validateGltfJsonDocument(absolutePath);
  if (ext === ".zip") {
    if (!isZip || size < 30) return { ok: false, error: "Content is not a ZIP archive." };
    return { ok: true, kind: "zip" };
  }
  if (ext === ".svg") {
    // Need more than a truncated magic; re-read a larger head for SVG.
    const bigger = readHead(absolutePath, 4096).buf.toString("utf8");
    if (!bigger.includes("<svg")) return { ok: false, error: "Content is not SVG." };
    return { ok: true, kind: "ui" };
  }
  if (ext === ".obj") {
    if (!isObj) return { ok: false, error: "Content does not look like Wavefront OBJ." };
    return { ok: true, kind: "model" };
  }
  if (ext === ".fbx") {
    const head = buf.slice(0, Math.min(buf.length, 23)).toString("latin1");
    if (!head.includes("Kaydara FBX Binary") && !head.includes("; FBX")) {
      return { ok: false, error: "Content does not look like FBX." };
    }
    if (size < 64) return { ok: false, error: "FBX file too small." };
    return { ok: true, kind: "model" };
  }
  if (ext === ".ttf" || ext === ".otf") return validateFont(absolutePath);
  if (ext === ".anim") return validateAnim(absolutePath);

  if (imageExts.has(ext)) return { ok: true, kind: "image" };
  if (audioExts.has(ext)) return { ok: true, kind: "audio" };
  return { ok: false, error: `Unsupported or unvalidated type: ${ext || "(none)"}` };
}
