import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const ADB_TIMEOUT_MS = 3500;

export function maskSerial(serial) {
  const value = String(serial || "").trim();
  if (!value) return null;
  // Always hide at least one original character, including unusually short serials.
  const visibleLength = Math.min(4, Math.max(0, value.length - 1));
  const tail = visibleLength > 0 ? value.slice(-visibleLength) : "";
  return `${"•".repeat(8)}${tail}`;
}

export function parseAdbDevices(output, observedAt = new Date().toISOString()) {
  const devices = [];
  for (const rawLine of String(output || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^List of devices attached/i.test(line) || /^\* daemon/i.test(line)) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const serial = parts[0];
    const adbState = parts[1];
    if (!['device', 'unauthorized', 'offline'].includes(adbState)) continue;
    const modelMatch = line.match(/(?:^|\s)model:([^\s]+)/);
    devices.push({
      state: adbState,
      model: modelMatch ? modelMatch[1].replace(/_/g, " ") : null,
      transport: serial.includes(":") ? "wireless" : "usb",
      maskedSerial: maskSerial(serial),
    });
  }
  const authorized = devices.filter((d) => d.state === "device");
  const unauthorized = devices.filter((d) => d.state === "unauthorized");
  const offline = devices.filter((d) => d.state === "offline");
  const status = authorized.length ? "connected" : unauthorized.length ? "authorization_required" : offline.length ? "offline" : "disconnected";
  const primary = authorized[0] || unauthorized[0] || offline[0] || null;
  return {
    status,
    observedAt,
    lastSuccessfulProbeAt: observedAt,
    deviceCount: devices.length,
    authorizedDeviceCount: authorized.length,
    model: primary?.model || null,
    transport: primary?.transport || null,
    maskedSerial: primary?.maskedSerial || null,
    devices,
  };
}

function projectUnityVersion(projectRoot) {
  try {
    const text = fs.readFileSync(path.join(projectRoot, "ProjectSettings", "ProjectVersion.txt"), "utf8");
    return text.match(/^m_EditorVersion:\s*([^\s]+)\s*$/m)?.[1] || null;
  } catch { return null; }
}

export function resolveAdbCandidates({ config = {}, env = process.env, projectRoot, platform = process.platform } = {}) {
  const exe = platform === "win32" ? "adb.exe" : "adb";
  const candidates = [];
  const add = (value, source) => {
    if (!value) return;
    const executable = String(value);
    if (!candidates.some((c) => c.executable.toLowerCase() === executable.toLowerCase())) candidates.push({ executable, source });
  };
  add(config.adbPath, "connector_config");
  add(env.HERTZ_ADB_PATH, "HERTZ_ADB_PATH");
  add(exe, "PATH");
  if (env.ANDROID_SDK_ROOT) add(path.join(env.ANDROID_SDK_ROOT, "platform-tools", exe), "ANDROID_SDK_ROOT");
  const version = projectRoot ? projectUnityVersion(projectRoot) : null;
  if (platform === "win32" && version) {
    const programFiles = env.ProgramFiles || "C:\\Program Files";
    add(path.join(programFiles, "Unity", "Hub", "Editor", version, "Editor", "Data", "PlaybackEngines", "AndroidPlayer", "SDK", "platform-tools", exe), "unity_android_sdk");
  }
  return candidates;
}

function runAdb(executable, timeoutMs) {
  return new Promise((resolve) => {
    execFile(executable, ["devices", "-l"], { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024, shell: false }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

export async function probeHeadsets(options = {}) {
  const observedAt = new Date().toISOString();
  const candidates = resolveAdbCandidates(options);
  let executableFound = false;
  let lastError = null;
  const runner = options.runAdb || runAdb;
  for (const candidate of candidates) {
    const result = await runner(candidate.executable, options.timeoutMs || ADB_TIMEOUT_MS);
    if (result.error?.code === "ENOENT") continue;
    executableFound = true;
    if (result.error) {
      lastError = result.error.code || result.error.message || "adb_probe_failed";
      continue;
    }
    return { ...parseAdbDevices(result.stdout, observedAt), adbAvailable: true, adbSource: candidate.source };
  }
  return {
    status: executableFound ? "unknown" : "unavailable",
    observedAt,
    lastSuccessfulProbeAt: null,
    deviceCount: 0,
    authorizedDeviceCount: 0,
    model: null,
    transport: null,
    maskedSerial: null,
    devices: [],
    adbAvailable: executableFound,
    adbSource: null,
    error: lastError ? "adb_probe_failed" : "adb_not_found",
  };
}
