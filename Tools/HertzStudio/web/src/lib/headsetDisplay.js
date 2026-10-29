export const HEADSET_STATUS_LABELS = Object.freeze({
  connected: "Connected",
  authorization_required: "Authorization required",
  offline: "Offline",
  disconnected: "Disconnected",
  unavailable: "Detection unavailable",
  unknown: "Unknown / stale",
});

export function headsetStatusLabel(headset) {
  if (!headset || headset.stale === true) return HEADSET_STATUS_LABELS.unknown;
  return HEADSET_STATUS_LABELS[headset.status] || HEADSET_STATUS_LABELS.unknown;
}

export function headsetRecovery(status) {
  if (status === "authorization_required") return "Accept the USB-debugging prompt inside the headset.";
  if (status === "offline") return "Reconnect and power on the headset, then restart ADB if it remains offline.";
  if (status === "unavailable") return "Install Android platform tools or configure ADB for the connector.";
  if (status === "disconnected") return "Connect and power on the headset. Enable Developer Mode and USB debugging when ADB is required.";
  if (status === "connected") return "Start Quest Link/OpenXR and Play Mode when testing PC VR runtime activity.";
  return "Refresh the connector. Connect and power on the headset if verification is required.";
}
