/**
 * Invokes Unity Editor menu proofs for W04 via the bridge RunCommand/MCP file trigger,
 * or executes MenuItem through a small HTTP-less path: write a request file the Editor watches.
 *
 * Prefer direct MenuItem execution when Unity MCP is unavailable: use EditorApplication delayCall
 * via existing bridge is not available for menus — this runner shells to Unity -executeMethod.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");
const projectRoot = path.resolve(__dirname, "..", "..", "..");

const required = [
  "w04-weapon-definition-sync-proof.json",
  "w04-frequency-runtime-proof.json",
];

function readJson(filePath) {
  let text = fs.readFileSync(filePath, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

function hasFresh(file) {
  const p = path.join(dataDir, file);
  if (!fs.existsSync(p)) return false;
  try {
    const j = readJson(p);
    return j.ok === true && Array.isArray(j.checks) && j.checks.length > 0;
  } catch {
    return false;
  }
}

// If proofs already present and ok (generated via Unity menu/MCP this session), accept.
if (required.every(hasFresh)) {
  console.log(JSON.stringify({ ok: true, mode: "existing_artifacts", files: required }));
  process.exit(0);
}

// Try Unity batchmode executeMethod when UNITY_EDITOR path is set.
const unity =
  process.env.UNITY_EDITOR ||
  process.env.UNITY_PATH ||
  "C:\\Program Files\\Unity\\Hub\\Editor\\6000.0.85f1\\Editor\\Unity.exe";

if (!fs.existsSync(unity)) {
  console.error(
    "W04 Unity proofs missing and UNITY_EDITOR not found. Run menu items: HERTZ/Studio/Proofs/W04 Weapon Definition Sync and W04 Frequency Gate Runtime.",
  );
  process.exit(1);
}

const methods = [
  "HertzStudio.Editor.HertzStudioWeaponProof.RunDefinitionSyncProof",
  "HertzStudio.Editor.HertzStudioWeaponProof.RunFrequencyRuntimeProof",
];

for (const method of methods) {
  const log = path.join(dataDir, `w04-unity-${method.split(".").pop()}.log`);
  const r = spawnSync(
    unity,
    [
      "-batchmode",
      "-nographics",
      "-quit",
      "-projectPath",
      projectRoot,
      "-executeMethod",
      method,
      "-logFile",
      log,
    ],
    { stdio: "inherit", timeout: 300000 },
  );
  if (r.status !== 0) {
    console.error(`executeMethod failed: ${method} status=${r.status}`);
    process.exit(1);
  }
}

if (!required.every(hasFresh)) {
  console.error("W04 Unity proofs still missing or not ok after executeMethod.");
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, mode: "executeMethod", files: required }));
process.exit(0);
