import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..");
const DATA = process.env.HERTZ_STUDIO_DATA
  ? path.resolve(process.env.HERTZ_STUDIO_DATA)
  : path.join(ROOT, "data");
const SECRETS_DIR = path.join(DATA, "secrets");
const META_PATH = path.join(SECRETS_DIR, "sketchfab.meta.json");
const BLOB_PATH = path.join(SECRETS_DIR, "sketchfab.dpapi.b64");

function ensureSecretsDir() {
  fs.mkdirSync(SECRETS_DIR, { recursive: true });
}

/**
 * Protect/unprotect with Windows DPAPI (CurrentUser) via PowerShell.
 * This is an OS credential store for the local Studio machine — never store.json / Git.
 */
async function dpapiProtect(plainText) {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$bytes = [System.Text.Encoding]::UTF8.GetBytes($env:HERTZ_SECRET_PLAIN)
$prot = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($prot)
`;
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: { ...process.env, HERTZ_SECRET_PLAIN: plainText },
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  return stdout.trim();
}

async function dpapiUnprotect(b64) {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$prot = [Convert]::FromBase64String($env:HERTZ_SECRET_B64)
$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($prot, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[System.Text.Encoding]::UTF8.GetString($bytes)
`;
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: { ...process.env, HERTZ_SECRET_B64: b64 },
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  return stdout.trim();
}

function maskToken(token) {
  if (!token || token.length < 8) return "••••";
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

export function getSketchfabMeta() {
  ensureSecretsDir();
  if (!fs.existsSync(META_PATH)) {
    return {
      configured: false,
      status: "not_configured",
      maskedId: null,
      validatedAt: null,
      accountLabel: null,
      scopes: [],
      lastError: null,
    };
  }
  try {
    return JSON.parse(fs.readFileSync(META_PATH, "utf8"));
  } catch {
    return {
      configured: false,
      status: "error",
      maskedId: null,
      validatedAt: null,
      accountLabel: null,
      scopes: [],
      lastError: "Credential metadata unreadable.",
    };
  }
}

export async function readSketchfabToken() {
  ensureSecretsDir();
  if (!fs.existsSync(BLOB_PATH)) return null;
  const b64 = fs.readFileSync(BLOB_PATH, "utf8").trim();
  if (!b64) return null;
  try {
    return await dpapiUnprotect(b64);
  } catch {
    return null;
  }
}

export async function saveSketchfabToken(token, validation) {
  ensureSecretsDir();
  const trimmed = String(token || "").trim();
  if (!trimmed) throw new Error("Credential required.");
  const protectedB64 = await dpapiProtect(trimmed);
  fs.writeFileSync(BLOB_PATH, protectedB64, { encoding: "utf8", mode: 0o600 });
  const meta = {
    configured: true,
    status: "connected",
    maskedId: maskToken(trimmed),
    validatedAt: new Date().toISOString(),
    accountLabel: validation?.accountLabel || null,
    scopes: validation?.scopes || [],
    lastError: null,
  };
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2));
  return meta;
}

export function clearSketchfabToken() {
  ensureSecretsDir();
  if (fs.existsSync(BLOB_PATH)) fs.unlinkSync(BLOB_PATH);
  const meta = {
    configured: false,
    status: "disconnected",
    maskedId: null,
    validatedAt: null,
    accountLabel: null,
    scopes: [],
    lastError: null,
  };
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2));
  return meta;
}

export function redactSecrets(text) {
  if (!text) return text;
  return String(text)
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9._\-]+/g, "[REDACTED]")
    .replace(/access_token[=:]\s*[^\s&"]+/gi, "access_token=[REDACTED]");
}
