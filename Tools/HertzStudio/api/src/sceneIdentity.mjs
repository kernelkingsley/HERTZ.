/**
 * Canonical scene-path identity checks. Never use case-sensitive substring matching.
 */
import path from "node:path";

/** Normalize a Unity Assets/ scene path for identity comparison. */
export function canonicalizeSceneAssetPath(raw) {
  if (raw == null) return "";
  let s = String(raw).trim().replace(/\\/g, "/");
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep raw if malformed percent-encoding */
  }
  s = s.replace(/\/+/g, "/");
  // Reject absolute / drive / UNC / traversal before joining.
  if (!s || s.includes("\0")) return "";
  if (/^[a-zA-Z]:/.test(s) || s.startsWith("/") || s.startsWith("//")) return "";
  const parts = s.split("/").filter((p) => p && p !== ".");
  if (parts.some((p) => p === "..")) return "";
  if (parts[0]?.toLowerCase() !== "assets") return "";
  return parts.join("/");
}

export function isSampleScenePath(raw) {
  const c = canonicalizeSceneAssetPath(raw);
  if (!c) return false;
  const base = path.posix.basename(c).toLowerCase();
  return base === "samplescene.unity";
}

/**
 * Dedicated HERTZ test/editor scenes only — never SampleScene or lookalikes via substring.
 */
export function assertDedicatedStudioScene(raw) {
  const c = canonicalizeSceneAssetPath(raw);
  if (!c || !c.toLowerCase().endsWith(".unity")) {
    const err = new Error("scenePath must be a canonical Assets/.../*.unity path.");
    err.code = "invalid_scene_path";
    throw err;
  }
  if (isSampleScenePath(c)) {
    const err = new Error("SampleScene is protected and cannot be targeted.");
    err.code = "protected_scene";
    throw err;
  }
  return c;
}

/** Any canonical Unity scene selected through the shared Studio target control. */
export function assertStudioTargetScene(raw) {
  const c = canonicalizeSceneAssetPath(raw);
  if (!c || !c.toLowerCase().endsWith(".unity")) {
    const err = new Error("scenePath must be a canonical Assets/.../*.unity path.");
    err.code = "invalid_scene_path";
    throw err;
  }
  return c;
}
export function scenePathsEqual(a, b) {
  const ca = canonicalizeSceneAssetPath(a);
  const cb = canonicalizeSceneAssetPath(b);
  return Boolean(ca) && ca.toLowerCase() === cb.toLowerCase();
}
