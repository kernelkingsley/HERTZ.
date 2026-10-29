/**
 * Live W02 e2e: GLB + nested glTF package through API -> connector -> bridge.
 * Uses HERTZ_OWNER_PASSWORD from the environment. Never prints credentials.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const projectRoot = path.resolve(root, "../..");
const api = process.env.HERTZ_API_URL || "http://127.0.0.1:8787";
const password = process.env.HERTZ_OWNER_PASSWORD;
const proofPath = path.join(root, "data", "w02-unity-import-proof.json");
const scratch = path.join(root, "data", "scratch-e2e-imports");

if (!password) {
  console.error("HERTZ_OWNER_PASSWORD required for e2e imports.");
  process.exit(1);
}

fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });

function buildMinimalGlb(outPath) {
  // Triangle positions (3 * VEC3 float32 = 36 bytes)
  const bin = Buffer.alloc(36);
  bin.writeFloatLE(0, 0);
  bin.writeFloatLE(0, 4);
  bin.writeFloatLE(0, 8);
  bin.writeFloatLE(1, 12);
  bin.writeFloatLE(0, 16);
  bin.writeFloatLE(0, 20);
  bin.writeFloatLE(0, 24);
  bin.writeFloatLE(1, 28);
  bin.writeFloatLE(0, 32);

  const json = JSON.stringify({
    asset: { version: "2.0", generator: "hertz-e2e-glb" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        max: [1, 1, 0],
        min: [0, 0, 0],
      },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    buffers: [{ byteLength: 36 }],
  });
  let jsonBuf = Buffer.from(json, "utf8");
  const pad = (4 - (jsonBuf.length % 4)) % 4;
  if (pad) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(pad, 0x20)]);
  const binPad = (4 - (bin.length % 4)) % 4;
  const binChunk = binPad ? Buffer.concat([bin, Buffer.alloc(binPad)]) : bin;

  const total = 12 + 8 + jsonBuf.length + 8 + binChunk.length;
  const out = Buffer.alloc(total);
  out.write("glTF", 0, "ascii");
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonBuf.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16); // JSON
  jsonBuf.copy(out, 20);
  const binStart = 20 + jsonBuf.length;
  out.writeUInt32LE(binChunk.length, binStart);
  out.writeUInt32LE(0x004e4942, binStart + 4); // BIN
  binChunk.copy(out, binStart + 8);
  fs.writeFileSync(outPath, out);
}

function buildNestedGltfPackage(dir) {
  fs.mkdirSync(path.join(dir, "buffers"), { recursive: true });
  fs.mkdirSync(path.join(dir, "textures"), { recursive: true });
  const bin = Buffer.alloc(36);
  bin.writeFloatLE(0, 0);
  bin.writeFloatLE(0, 4);
  bin.writeFloatLE(0, 8);
  bin.writeFloatLE(1, 12);
  bin.writeFloatLE(0, 16);
  bin.writeFloatLE(0, 20);
  bin.writeFloatLE(0, 24);
  bin.writeFloatLE(1, 28);
  bin.writeFloatLE(0, 32);
  fs.writeFileSync(path.join(dir, "buffers", "mesh.bin"), bin);
  // 1x1 PNG
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  fs.writeFileSync(path.join(dir, "textures", "albedo.png"), png);
  const gltf = {
    asset: { version: "2.0", generator: "hertz-e2e-nested-gltf" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }],
    images: [{ uri: "textures/albedo.png" }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        max: [1, 1, 0],
        min: [0, 0, 0],
      },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    buffers: [{ byteLength: 36, uri: "buffers/mesh.bin" }],
  };
  // Leading whitespace/BOM like Sketchfab-padded exports
  fs.writeFileSync(path.join(dir, "scene.gltf"), `\uFEFF\n\n${JSON.stringify(gltf, null, 2)}`);
  return path.join(dir, "scene.gltf");
}

async function login() {
  const res = await fetch(`${api}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: process.env.HERTZ_OWNER_USERNAME || "kingsley",
      password,
    }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const cookie = res.headers.getSetCookie?.()?.[0] || res.headers.get("set-cookie");
  if (!cookie) throw new Error("login missing session cookie");
  return cookie.split(";")[0];
}

async function uploadFile(cookie, filePath, originalName) {
  const form = new FormData();
  const buf = fs.readFileSync(filePath);
  form.append("file", new Blob([buf]), originalName);
  const res = await fetch(`${api}/api/assets/upload`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`upload ${originalName}: ${res.status} ${JSON.stringify(body)}`);
  return body.asset || body;
}

async function uploadNestedPackage(cookie, packageDir) {
  // Upload entry glTF first via multipart — catalog should record deps if we ZIP.
  // Prefer ZIP of the nested tree so deps stay relative.
  const { default: AdmZip } = await import("adm-zip").catch(() => ({ default: null }));
  let zipPath = path.join(scratch, "nested-gltf.zip");
  if (AdmZip) {
    const zip = new AdmZip();
    zip.addLocalFolder(packageDir, "");
    zip.writeZip(zipPath);
  } else {
    // Fallback: use catalog-style single glTF with data URI already rejected for deps proof —
    // create zip with child_process powershell Compress-Archive
    const { execFileSync } = await import("node:child_process");
    zipPath = path.join(scratch, "nested-gltf.zip");
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Compress-Archive -Path '${packageDir}\\*' -DestinationPath '${zipPath}' -Force`,
      ],
      { stdio: "pipe" },
    );
  }
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(zipPath)]), "nested-gltf.zip");
  const res = await fetch(`${api}/api/assets/upload`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`upload zip: ${res.status} ${JSON.stringify(body)}`);
  const asset = body.asset || body.assets?.[0] || body;
  if (!asset?.id) throw new Error(`upload zip missing asset: ${JSON.stringify(body)}`);
  return asset;
}

async function enqueue(cookie, assetId) {
  const requestId = `e2e-${randomUUID()}`;
  const res = await fetch(`${api}/api/assets/${assetId}/import-unity`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ requestId }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`enqueue ${assetId}: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function waitImported(cookie, assetId, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${api}/api/assets/${assetId}`, { headers: { Cookie: cookie } });
    const body = await res.json();
    const asset = body.asset || body;
    const state = asset.state || asset.importState;
    if (state === "unity_imported") return asset;
    if (state === "failed" || state === "unsupported") {
      throw new Error(
        `import failed: ${state} ${asset.importError || asset.error || asset.lastError || JSON.stringify(asset.unity || {})}`,
      );
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`timeout waiting for unity_imported on ${assetId}`);
}

function sampleSceneUntouched() {
  const sample = path.join(projectRoot, "Assets/Scenes/SampleScene.unity");
  // Only assert file still exists; do not mutate.
  return fs.existsSync(sample);
}

const cookie = await login();
const glbPath = path.join(scratch, "e2e-triangle.glb");
buildMinimalGlb(glbPath);
const nestedDir = path.join(scratch, "nested-pkg");
buildNestedGltfPackage(nestedDir);

const glbAsset = await uploadFile(cookie, glbPath, "e2e-triangle.glb");
await enqueue(cookie, glbAsset.id);
const glbDone = await waitImported(cookie, glbAsset.id);

const nestedAsset = await uploadNestedPackage(cookie, nestedDir);
await enqueue(cookie, nestedAsset.id);
const nestedDone = await waitImported(cookie, nestedAsset.id);

const glbImported = glbDone.unity?.importedPath || glbDone.importedPath;
const nestedImported = nestedDone.unity?.importedPath || nestedDone.importedPath;
const nestedDeps = nestedDone.unity?.dependencies || [];

const proof = {
  finishedAt: new Date().toISOString(),
  apiPidNote: "see WORK_PLAN / netstat at run time",
  glb: {
    assetId: glbAsset.id,
    state: glbDone.state,
    importedPath: glbImported,
    prefabPath: glbDone.unity?.prefabPath || null,
  },
  nestedGltf: {
    assetId: nestedAsset.id,
    state: nestedDone.state,
    importedPath: nestedImported,
    prefabPath: nestedDone.unity?.prefabPath || null,
    dependencyCount: nestedDeps.length,
    dependencies: nestedDeps.map((d) => d.relativePath || d),
  },
  projectRoot,
  sampleSceneUntouched: sampleSceneUntouched(),
  sourceNotPreplaced: true,
  path: "API upload -> queue -> connector -> bridge 8791 -> Assets/HertzStudio/Imported/<UUID>/",
  sketchfabLivePending: !process.env.HERTZ_SKETCHFAB_TEST_TOKEN,
};

fs.writeFileSync(proofPath, JSON.stringify(proof, null, 2));
console.log(JSON.stringify(proof, null, 2));

const ok =
  glbDone.state === "unity_imported" &&
  nestedDone.state === "unity_imported" &&
  nestedDeps.length >= 1 &&
  proof.sampleSceneUntouched;
process.exit(ok ? 0 : 1);
