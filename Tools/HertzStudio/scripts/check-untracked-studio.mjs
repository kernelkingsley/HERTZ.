/**
 * Validate Studio/Editor text sources directly (including untracked files).
 * Ordinary `git diff --check` skips untracked paths — this fills that gap.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const studioRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(studioRoot, "../..");

const roots = [
  "Assets/Editor/HertzStudio",
  "Tools/HertzStudio/api/src",
  "Tools/HertzStudio/connector/src",
  "Tools/HertzStudio/web/src",
  "Tools/HertzStudio/scripts",
];

const textExt = new Set([
  ".cs",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".json",
  ".md",
  ".css",
]);

function gitPorcelainFiles() {
  const out = execSync("git status --porcelain -uall", {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const files = [];
  for (const raw of out.split(/\r?\n/)) {
    if (!raw || raw.length < 4) continue;
    // rename: "R  old -> new" — take the new path
    let file = raw.slice(3).trim();
    const arrow = file.indexOf(" -> ");
    if (arrow >= 0) file = file.slice(arrow + 4).trim();
    file = file.replace(/\\/g, "/").replace(/^"|"$/g, "");
    if (!file) continue;
    const under = roots.some((r) => file === r || file.startsWith(r + "/"));
    if (!under) continue;
    const abs = path.join(repoRoot, file);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) files.push(abs);
  }
  return files;
}

/** Also include every text file under the roots (covers brand-new untracked trees). */
function walkRoots() {
  const files = [];
  for (const rel of roots) {
    const absRoot = path.join(repoRoot, rel);
    if (!fs.existsSync(absRoot)) continue;
    walk(absRoot, files);
  }
  return files;
}

function walk(dir, files) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === "dist") continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, files);
    else if (textExt.has(path.extname(ent.name).toLowerCase())) files.push(p);
  }
}

const set = new Set([...gitPorcelainFiles(), ...walkRoots()]);
const files = [...set].sort();
const errors = [];
let checked = 0;

for (const file of files) {
  const ext = path.extname(file).toLowerCase();
  if (!textExt.has(ext)) continue;
  checked += 1;
  const rel = path.relative(repoRoot, file).replace(/\\/g, "/");
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (err) {
    errors.push(`${rel}: read failed (${err.message})`);
    continue;
  }
  if (buf.includes(0)) {
    errors.push(`${rel}: contains NUL byte`);
    continue;
  }
  const text = buf.toString("utf8");
  const lines = text.split(/\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (/[ \t]+$/.test(line)) {
      errors.push(`${rel}:${i + 1}: trailing whitespace`);
      break;
    }
  }
  if (ext === ".mjs" || ext === ".js" || ext === ".cjs") {
    try {
      execSync(`node --check "${file}"`, { stdio: "pipe" });
    } catch {
      errors.push(`${rel}: node --check failed`);
    }
  }
}

const report = {
  ok: errors.length === 0,
  checked,
  errorCount: errors.length,
  errors: errors.slice(0, 40),
  note: "Direct validation of Studio/Editor sources (untracked-safe; not git diff --check).",
};

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
