import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { safeExtractZip } from "./zip-safe.mjs";
import { ingestFile, getTmpDir } from "./catalog.mjs";
import { LIMITS } from "./types.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Official Kenney catalog categories — no invented API. */
export const KENNEY_CATEGORIES = Object.freeze(["2D", "3D", "UI", "Audio", "Pixel", "Textures"]);

export const KENNEY_SOURCE = "https://kenney.nl/assets";

function detectKenneyCategory(packName = "", fileList = []) {
  const blob = `${packName} ${fileList.join(" ")}`.toLowerCase();
  if (/pixel|1-bit|1bit|8-bit|8bit/.test(blob)) return "Pixel";
  if (/ui|interface|button|font/.test(blob)) return "UI";
  if (/audio|music|sound|sfx/.test(blob)) return "Audio";
  if (/texture|prototype|pattern/.test(blob)) return "Textures";
  if (/\.glb|\.gltf|\.fbx|\.obj/.test(blob) || /3d|model/.test(blob)) return "3D";
  return "2D";
}

/**
 * Import a downloaded Kenney ZIP or folder of files into the library.
 */
export async function importKenneyPack({
  archivePath = null,
  folderPath = null,
  packName = null,
  packVersion = null,
}) {
  const tmpRoot = path.join(getTmpDir(), `kenney-${Date.now()}`);
  fs.mkdirSync(tmpRoot, { recursive: true });
  const created = [];
  const skipped = [];
  const rejected = [];

  try {
    let workDir = folderPath;
    if (archivePath) {
      const st = fs.statSync(archivePath);
      if (st.size > LIMITS.maxZipBytes) {
        throw new Error(`Kenney ZIP exceeds max archive size (${LIMITS.maxZipBytes} bytes).`);
      }
      const extracted = await safeExtractZip(archivePath, tmpRoot);
      rejected.push(...extracted.rejected);
      workDir = tmpRoot;
    }
    if (!workDir || !fs.existsSync(workDir)) {
      throw new Error("Kenney pack path missing.");
    }

    const files = [];
    function walk(dir) {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) walk(full);
        else files.push(full);
      }
    }
    walk(workDir);

    const inferredName =
      packName ||
      (archivePath ? path.basename(archivePath, path.extname(archivePath)) : path.basename(workDir));
    const category = detectKenneyCategory(
      inferredName,
      files.map((f) => path.basename(f)),
    );

    for (const full of files) {
      const base = path.basename(full);
      const ext = path.extname(base).toLowerCase();
      if ([".txt", ".md", ".html", ".url", ".meta", ".pdf"].includes(ext)) {
        skipped.push({ file: base, reason: "documentation_skipped" });
        continue;
      }
      try {
        const result = ingestFile({
          absolutePath: full,
          originalName: base,
          provider: "kenney",
          sourceUrl: KENNEY_SOURCE,
          author: "Kenney",
          license: "CC0",
          packName: inferredName,
          packVersion: packVersion || null,
          description: `Kenney free individual pack (${category}).`,
          kenneyCategory: category,
          pixelHint: category === "Pixel",
        });
        if (result.deduplicated) {
          skipped.push({ file: base, reason: "duplicate_hash", assetId: result.asset.id });
        } else {
          created.push(result.asset);
        }
      } catch (err) {
        if (err.code === "unsupported") {
          skipped.push({ file: base, reason: err.message });
        } else {
          rejected.push(`${base}: ${err.message}`);
        }
      }
    }

    return {
      packName: inferredName,
      category,
      sourceUrl: KENNEY_SOURCE,
      license: "CC0",
      created: created.length,
      skipped: skipped.length,
      rejected,
      skipDetails: skipped.slice(0, 50),
      assets: created,
    };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

export function kenneyInfo() {
  return {
    provider: "kenney",
    sourceUrl: KENNEY_SOURCE,
    categories: KENNEY_CATEGORIES,
    credentialRequired: false,
    note: "Download free individual packs from kenney.nl and import the ZIP or extracted folder. The paid All-in-1 bundle is not required.",
  };
}
