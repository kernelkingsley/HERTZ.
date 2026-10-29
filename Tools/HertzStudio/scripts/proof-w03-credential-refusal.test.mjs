import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(__dirname, "proof-w03-completion-batch.mjs");

describe("proof-w03-completion-batch credentials", () => {
  it("refuses to start without HERTZ_OWNER_PASSWORD", () => {
    const env = { ...process.env };
    delete env.HERTZ_OWNER_PASSWORD;
    const result = spawnSync(process.execPath, [script], {
      env,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr || result.stdout || ""), /HERTZ_OWNER_PASSWORD/);
    assert.doesNotMatch(String(result.stderr || ""), /qwerty|hertz-local-owner/i);
  });
});
