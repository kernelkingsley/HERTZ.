import fs from "fs";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const catalog = require("../data/assets-catalog.json");
const id = process.argv[2] || "ab7afcbf-a39e-4b94-ba9a-912d83ef1288";
const asset = catalog.assets[id];
if (!asset) {
  console.error(JSON.stringify({ error: "asset_not_found", id }));
  process.exit(1);
}
const studioRoot = path.resolve("C:/Users/Kingsley/HERTZ/Tools/HertzStudio");
const absCandidates = [
  path.resolve(studioRoot, "data", asset.blobPath),
  path.resolve(studioRoot, asset.blobPath),
  path.isAbsolute(asset.blobPath) ? asset.blobPath : null,
].filter(Boolean);
const abs = absCandidates.find((p) => fs.existsSync(p));
if (!abs) {
  console.error(JSON.stringify({ error: "blob_missing", tried: absCandidates }));
  process.exit(1);
}
const buf = fs.readFileSync(abs);
const text = buf.toString("latin1");

const models = new Set();
for (const m of text.matchAll(/Model::([A-Za-z0-9_:|.]+)/g)) models.add(m[1]);

const materials = new Set();
for (const m of text.matchAll(/Material::([A-Za-z0-9_ .\\/-]+)/g)) materials.add(m[1]);

const textures = new Set();
for (const m of text.matchAll(/Texture::([A-Za-z0-9_ .\\/-]+)/g)) textures.add(m[1]);
for (const m of text.matchAll(/Video::([A-Za-z0-9_ .\\/-]+)/g)) textures.add(m[1]);

const fileRefs = [...new Set([...text.matchAll(/[A-Za-z0-9_./\\-]+\.(?:png|jpe?g|tga|tif|bmp|dds)/gi)].map((x) => x[0]))];

const all = [...models].sort();
const handish = all.filter((n) => /hand|thumb|index|middle|ring|pinky|finger/i.test(n));
const fingerish = all.filter((n) => /thumb|index|middle|ring|pinky|finger/i.test(n));
const limbish = all.filter((n) => /arm|forearm|shoulder|spine|hips|leg|foot|head|neck|clavicle|upleg/i.test(n));

console.log(
  JSON.stringify(
    {
      id,
      displayName: asset.displayName,
      abs,
      byteSize: buf.length,
      modelCount: all.length,
      models: all,
      handBones: handish,
      fingerBones: fingerish,
      limbBones: limbish,
      materials: [...materials],
      textures: [...textures],
      textureFileRefs: fileRefs,
      likelyHasFingerRig: fingerish.length >= 6,
      likelyMissingExternalTextures: fileRefs.length === 0 && textures.size === 0,
    },
    null,
    2,
  ),
);
