export const HEADSET_STALE_MS = Number(process.env.HERTZ_HEADSET_STALE_MS || 20000);
export const HEADSET_STATES = Object.freeze(["connected", "authorization_required", "offline", "disconnected", "unavailable", "unknown"]);

function safeText(value, max = 120) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function safeMaskedSerial(value) {
  const text = safeText(value, 32);
  if (!text) return null;
  // Treat connector input as untrusted and never reveal every supplied character.
  const visibleLength = Math.min(4, Math.max(0, text.length - 1));
  const tail = visibleLength > 0 ? text.slice(-visibleLength) : "";
  return `${"•".repeat(8)}${tail}`;
}

export function sanitizeHeadsetReport(input = {}, now = new Date().toISOString()) {
  const adbInput = input.adb && typeof input.adb === "object" ? input.adb : input;
  const adbStatus = HEADSET_STATES.includes(adbInput.status) ? adbInput.status : "unknown";
  const devices = Array.isArray(adbInput.devices) ? adbInput.devices.slice(0, 8).map((device) => ({
    state: ["device", "unauthorized", "offline"].includes(device?.state) ? device.state : "unknown",
    model: safeText(device?.model),
    transport: ["usb", "wireless"].includes(device?.transport) ? device.transport : null,
    maskedSerial: safeMaskedSerial(device?.maskedSerial),
  })) : [];
  const xr = input.openxr && typeof input.openxr === "object" ? input.openxr : {};
  return {
    reportedAt: now,
    observedAt: safeText(adbInput.observedAt) || now,
    lastSuccessfulProbeAt: safeText(adbInput.lastSuccessfulProbeAt),
    adb: {
      status: adbStatus,
      available: adbInput.adbAvailable === true,
      source: safeText(adbInput.adbSource, 40),
      deviceCount: Math.max(0, Math.min(32, Number(adbInput.deviceCount) || 0)),
      authorizedDeviceCount: Math.max(0, Math.min(32, Number(adbInput.authorizedDeviceCount) || 0)),
      model: safeText(adbInput.model),
      transport: ["usb", "wireless"].includes(adbInput.transport) ? adbInput.transport : null,
      maskedSerial: safeMaskedSerial(adbInput.maskedSerial),
      devices,
      error: safeText(adbInput.error, 80),
    },
    openxr: {
      unityConnected: input.unityConnected === true,
      loaderActive: xr.loaderActive === true,
      displayRunning: xr.displayRunning === true,
      hmdPresent: xr.hmdPresent === true,
      loaderName: safeText(xr.loaderName),
      runtimeName: safeText(xr.runtimeName),
      deviceName: safeText(xr.deviceName),
      observedAt: safeText(xr.observedAt) || now,
    },
  };
}

export function normalizeHeadsetConnection(report, { now = Date.now(), staleAfterMs = HEADSET_STALE_MS } = {}) {
  const empty = sanitizeHeadsetReport({}, new Date(now).toISOString());
  const value = report && typeof report === "object" ? report : empty;
  const seen = Date.parse(value.reportedAt || value.observedAt || 0);
  const stale = !Number.isFinite(seen) || now - seen > staleAfterMs;
  const adb = value.adb || empty.adb;
  const openxr = value.openxr || empty.openxr;
  let status = "unknown";
  if (!stale) {
    if (adb.status === "connected" || (openxr.displayRunning === true && openxr.hmdPresent === true)) status = "connected";
    else if (adb.status === "authorization_required") status = "authorization_required";
    else if (adb.status === "offline") status = "offline";
    else if (adb.status === "disconnected") status = "disconnected";
    else if (adb.status === "unavailable") status = "unavailable";
  }
  return {
    status,
    stale,
    staleAfterMs,
    observedAt: value.observedAt || null,
    reportedAt: value.reportedAt || null,
    lastSuccessfulProbeAt: value.lastSuccessfulProbeAt || null,
    deviceCount: adb.deviceCount || 0,
    model: adb.model || openxr.deviceName || null,
    transport: adb.transport || (openxr.displayRunning && openxr.hmdPresent ? "openxr" : null),
    maskedSerial: adb.maskedSerial || null,
    adb,
    openxr,
    blocking: false,
    pendingCapabilities: ["headset_verification", "quest_transfer", "performance_capture", "audible_headset_testing"],
  };
}
