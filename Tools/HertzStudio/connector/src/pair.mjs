import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const configPath = path.join(root, "data/connector-config.json");
const bridgeTokenPath = path.join(root, "data/secrets/bridge-token.json");
const apiBase = process.env.HERTZ_API_URL || "http://127.0.0.1:8787";
const code = process.argv[2];

if (!code) {
  console.error("Usage: npm run pair -w connector -- <pairing-code>");
  process.exit(1);
}

const response = await fetch(`${apiBase}/api/connections/pair/complete`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ code }),
});
const data = await response.json();
if (!response.ok) {
  console.error(data.error || "Pairing failed");
  process.exit(1);
}

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.mkdirSync(path.dirname(bridgeTokenPath), { recursive: true });

const bridgeToken = data.bridgeToken;
if (!bridgeToken) {
  console.error("Pairing response missing bridgeToken");
  process.exit(1);
}

fs.writeFileSync(
  bridgeTokenPath,
  JSON.stringify(
    {
      bridgeToken,
      writtenAt: new Date().toISOString(),
      note: "Local Editor bridge credential. Keep on Unity machine only.",
    },
    null,
    2,
  ),
  "utf8",
);

fs.writeFileSync(
  configPath,
  JSON.stringify(
    {
      apiBaseUrl: data.apiBaseUrl || apiBase,
      connectorToken: data.connectorToken,
      bridgeToken,
      unityBridgeUrl: process.env.HERTZ_UNITY_BRIDGE_URL || "http://127.0.0.1:8791",
      pairedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
  "utf8",
);

console.log(`Paired. Connector config: ${configPath}`);
console.log(`Bridge token: ${bridgeTokenPath}`);
console.log("Keep these files on the Unity machine only. Do not commit them.");
