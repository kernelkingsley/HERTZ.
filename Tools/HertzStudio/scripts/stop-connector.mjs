#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pidPath = path.join(root, "data/connector.pid");
const identityPath = path.join(root, "data/connector.identity.json");

function clearFiles() {
  for (const p of [pidPath, identityPath]) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

function readIdentity() {
  if (!fs.existsSync(identityPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(identityPath, "utf8"));
  } catch {
    return null;
  }
}

function commandLineForPid(pid) {
  if (process.platform !== "win32") {
    try {
      return execFileSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  }
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    return String(out || "").trim();
  } catch {
    return null;
  }
}

if (!fs.existsSync(pidPath)) {
  console.log("No connector.pid — nothing to stop.");
  process.exit(0);
}

const pid = Number(fs.readFileSync(pidPath, "utf8").trim());
if (!Number.isFinite(pid)) {
  clearFiles();
  console.log("Removed invalid connector.pid");
  process.exit(0);
}

const identity = readIdentity();
const cmdline = commandLineForPid(pid);
const looksLikeConnector =
  cmdline &&
  /connector\.mjs/i.test(cmdline) &&
  (!identity?.nonce || !cmdline.includes("foreign"));

if (!cmdline) {
  console.log(`PID ${pid} not running; clearing pid/identity files.`);
  clearFiles();
  process.exit(0);
}

if (!looksLikeConnector) {
  console.error(
    `Refusing to stop PID ${pid}: command line is not the HERTZ connector.\n  ${cmdline.slice(0, 200)}`,
  );
  process.exit(1);
}

if (identity?.startedAt) {
  // Soft check: identity file belongs to this studio root.
  if (identity.studioRoot && path.resolve(identity.studioRoot) !== root) {
    console.error(`Refusing to stop PID ${pid}: identity studioRoot mismatch.`);
    process.exit(1);
  }
}

try {
  process.kill(pid, "SIGTERM");
  console.log(`Stopped connector PID ${pid}`);
} catch (err) {
  console.log(`PID ${pid} not running (${err.code || err.message}); clearing files.`);
}
clearFiles();
