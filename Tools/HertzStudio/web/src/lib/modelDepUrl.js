/**
 * Rewrite GLTFLoader dependency requests onto the authenticated model-dep route.
 * Relative URIs resolved against /api/assets/:id/model become /api/assets/:id/scene.bin —
 * those must not pass through unchanged.
 *
 * Primary asset endpoints (model / file / preview / …) must never be rewritten to model-dep,
 * including self-contained GLBs that have zero unity.dependencies.
 */
const PRIMARY_ASSET_SEGMENTS = new Set([
  "model",
  "file",
  "preview",
  "render-descriptor",
  "thumbnail",
]);

export function rewriteModelDependencyUrl(requestUrl, assetId, origin = "http://127.0.0.1") {
  if (!assetId) return requestUrl;
  if (/^(blob:|data:)/i.test(requestUrl)) return requestUrl;
  const prefix = `/api/assets/${assetId}/`;
  let rel = String(requestUrl || "").split(/[?#]/)[0];
  try {
    const u = new URL(requestUrl, origin);
    if (u.pathname.includes(`${prefix}model-dep/`)) return `${u.pathname}${u.search}`;
    if (u.pathname === `${prefix}model` || u.pathname.endsWith(`${prefix}model`)) {
      return requestUrl;
    }
    if (u.pathname.startsWith(prefix)) {
      rel = decodeURIComponent(u.pathname.slice(prefix.length));
    } else if (/^https?:/i.test(requestUrl)) {
      return requestUrl;
    }
  } catch {
    /* keep rel */
  }
  rel = rel.replace(/^\.\//, "");
  if (!rel || PRIMARY_ASSET_SEGMENTS.has(rel.split("/")[0])) return requestUrl;
  return `/api/assets/${assetId}/model-dep/${encodeURIComponent(rel)}`;
}
