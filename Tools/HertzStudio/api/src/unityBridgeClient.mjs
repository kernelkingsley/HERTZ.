/**
 * Local Unity Editor bridge probe helper (Studio API → http://127.0.0.1:{port}).
 * Never invents success when the bridge is down.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(HERE, "../data");

export function readBridgeCredential() {
  const tokenPath = path.join(DATA_DIR, "secrets", "bridge-token.json");
  if (!fs.existsSync(tokenPath)) return null;
  try {
    const doc = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
    const bridgeToken = doc.bridgeToken;
    const bridgePort = Number(doc.bridgePort || process.env.HERTZ_UNITY_BRIDGE_PORT || 8791);
    if (!bridgeToken || !Number.isFinite(bridgePort)) return null;
    return { bridgeToken, bridgePort, tokenPath };
  } catch {
    return null;
  }
}

async function bridgeFetch(method, pathname, { body = null, timeoutMs = 5000 } = {}) {
  const cred = readBridgeCredential();
  if (!cred) {
    return { ok: false, status: 0, error: "Unity bridge credential missing (data/secrets/bridge-token.json)." };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`http://127.0.0.1:${cred.bridgePort}${pathname}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-hertz-bridge-token": cred.bridgeToken,
      },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    let data = null;
    try {
      data = await resp.json();
    } catch {
      data = null;
    }
    return {
      ok: resp.ok,
      status: resp.status,
      data,
      bridgePort: cred.bridgePort,
      error: resp.ok ? null : data?.error || data?.message || `Unity bridge HTTP ${resp.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      bridgePort: cred.bridgePort,
      error: err?.name === "AbortError" ? "Unity bridge timed out." : err?.message || "Unity bridge unreachable.",
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function postUnityBridge(pathname, body, { timeoutMs = 5000 } = {}) {
  return bridgeFetch("POST", pathname, { body: body || {}, timeoutMs });
}

export async function getUnityBridge(pathname, { timeoutMs = 5000 } = {}) {
  return bridgeFetch("GET", pathname, { timeoutMs });
}
