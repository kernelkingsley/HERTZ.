/**
 * Shared helpers for W08–W14 regression runners.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const STUDIO_ROOT = path.resolve(__dirname, "../..");
export const REPO_ROOT = path.resolve(STUDIO_ROOT, "../..");
export const DATA_DIR = path.join(STUDIO_ROOT, "data");
export const REVIEWS_DIR = path.join(DATA_DIR, "reviews");

export function runNodeTest(relPaths, { cwd = STUDIO_ROOT } = {}) {
  const files = (Array.isArray(relPaths) ? relPaths : [relPaths]).map((p) =>
    path.isAbsolute(p) ? p : path.join(STUDIO_ROOT, p),
  );
  const startedAt = new Date().toISOString();
  const r = spawnSync(process.execPath, ["--test", ...files], {
    cwd,
    encoding: "utf8",
    env: { ...process.env },
  });
  const completedAt = new Date().toISOString();
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;
  const passMatch = out.match(/# pass\s+(\d+)/);
  const failMatch = out.match(/# fail\s+(\d+)/);
  const testsMatch = out.match(/# tests\s+(\d+)/);
  return {
    command: `node --test ${files.map((f) => path.relative(STUDIO_ROOT, f)).join(" ")}`,
    workingDirectory: cwd,
    startedAt,
    completedAt,
    exitCode: r.status ?? 1,
    counts: `tests=${testsMatch?.[1] || "?"} pass=${passMatch?.[1] || "?"} fail=${failMatch?.[1] || "?"}`,
    result: (r.status ?? 1) === 0 ? "passed" : "failed",
    outputTail: out.slice(-2000),
  };
}

export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

export function getSampleSceneHash() {
  const p = path.join(REPO_ROOT, "Assets/Scenes/SampleScene.unity");
  if (!fs.existsSync(p)) return null;
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex").toUpperCase();
}

export function assertReviewManifest(milestone) {
  const file = path.join(REVIEWS_DIR, `${milestone.toLowerCase()}-review-manifest.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`Missing review manifest: ${file}`);
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (raw.schemaVersion !== 1) throw new Error(`${file}: schemaVersion must be 1`);
  if (raw.milestone !== milestone) throw new Error(`${file}: milestone mismatch`);
  if (!Array.isArray(raw.acceptanceCriteria) || raw.acceptanceCriteria.length < 1) {
    throw new Error(`${file}: acceptanceCriteria required`);
  }
  for (const c of raw.acceptanceCriteria) {
    if (c.status === "passed" && (!c.evidence || c.evidence.length === 0)) {
      throw new Error(`${file}: criterion "${c.criterion}" passed without evidence`);
    }
  }
  return raw;
}

export function rejectStaleProof(artifactPath, maxAgeHours = 72) {
  if (!fs.existsSync(artifactPath)) return { fresh: false, reason: "missing" };
  const raw = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  if (!raw.generatedAt) return { fresh: false, reason: "no generatedAt", raw };
  const ageMs = Date.now() - Date.parse(raw.generatedAt);
  if (!Number.isFinite(ageMs) || ageMs > maxAgeHours * 3600 * 1000) {
    return { fresh: false, reason: "stale", generatedAt: raw.generatedAt };
  }
  if (raw.fresh === false) return { fresh: false, reason: "labeled_stale", raw };
  return { fresh: true, raw };
}
