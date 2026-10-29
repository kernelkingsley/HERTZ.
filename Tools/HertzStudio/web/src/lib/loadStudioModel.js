/**
 * Load a Studio catalog model for browser preview (GLB/GLTF or FBX).
 * Returns { root, animations } for a consistent viewer path.
 */
export function inferModelFormat({ format = null, url = "", fileName = "" } = {}) {
  const tokens = [format, url, fileName].map((v) => String(v || "").toLowerCase());
  if (tokens.some((t) => t.includes(".fbx") || t === "fbx" || t.endsWith("fbx"))) return "fbx";
  if (tokens.some((t) => t.includes(".glb") || t === "glb")) return "glb";
  if (tokens.some((t) => t.includes(".gltf") || t === "gltf")) return "gltf";
  return "gltf";
}

/**
 * @param {object} opts
 * @param {string} opts.url
 * @param {string|null} [opts.assetId]
 * @param {string|null} [opts.format]
 * @param {string|null} [opts.fileName]
 * @param {(pct:number)=>void} [opts.onProgress]
 * @param {(requestUrl:string)=>string} [opts.urlModifier]
 */
export async function loadStudioModel({
  url,
  assetId = null,
  format = null,
  fileName = null,
  onProgress = null,
  urlModifier = null,
} = {}) {
  if (!url) throw new Error("Model URL required.");
  const THREE = await import("three");
  const kind = inferModelFormat({ format, url, fileName });

  if (kind === "fbx") {
    const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
    const loader = new FBXLoader();
    if (assetId && urlModifier) loader.manager.setURLModifier(urlModifier);
    const root = await new Promise((resolve, reject) => {
      loader.load(
        url,
        resolve,
        (e) => {
          if (onProgress && e.total) onProgress(Math.round((100 * e.loaded) / e.total));
        },
        (err) => reject(new Error(err?.message || "FBX preview failed")),
      );
    });
    return { root, animations: root.animations || [], THREE, kind: "fbx" };
  }

  const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
  const loader = new GLTFLoader();
  if (assetId && urlModifier) loader.manager.setURLModifier(urlModifier);
  const gltf = await new Promise((resolve, reject) => {
    loader.load(
      url,
      resolve,
      (e) => {
        if (onProgress && e.total) onProgress(Math.round((100 * e.loaded) / e.total));
      },
      (err) => {
        const msg = err?.message || String(err || "Model preview failed");
        reject(new Error(msg.includes("status") ? msg : `${msg} (check model-dep requests)`));
      },
    );
  });
  return { root: gltf.scene, animations: gltf.animations || [], THREE, kind: "gltf" };
}
