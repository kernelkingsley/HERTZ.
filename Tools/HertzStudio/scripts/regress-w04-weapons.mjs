/**
 * W04 regression: API weapon catalog + sync job semantics (isolated data dir).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const r = spawnSync(process.execPath, ["--test", "api/src/weapons.test.mjs"], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});
process.exit(r.status === 0 ? 0 : 1);
