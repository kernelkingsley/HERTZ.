/**
 * Local-only helper: owner login + pairing code + connector pair redeem.
 * Requires HERTZ_OWNER_PASSWORD — never falls back to a hardcoded default.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.HERTZ_API_URL || "http://127.0.0.1:8787";
const password = process.env.HERTZ_OWNER_PASSWORD;
if (!password) {
  console.error("Set HERTZ_OWNER_PASSWORD before pairing. No default password is allowed.");
  process.exit(1);
}
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const login = await fetch(`${API}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "kingsley", password }),
});
const loginData = await login.json().catch(() => ({}));
if (!login.ok) {
  console.error(loginData.error || "login failed");
  process.exit(1);
}
const cookie = login.headers.get("set-cookie")?.split(";")[0];
const start = await fetch(`${API}/api/connections/pair/start`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: cookie },
  body: "{}",
});
const pair = await start.json();
if (!start.ok) {
  console.error(pair.error || "pair start failed");
  process.exit(1);
}
console.log(`Pairing code: ${pair.code}`);
const result = spawnSync("npm", ["run", "pair", "-w", "connector", "--", pair.code], {
  cwd: root,
  stdio: "inherit",
  shell: true,
  env: process.env,
});
process.exit(result.status ?? 1);
