import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { PROJECT_ROOT } from "./proof-fingerprint.mjs";

const FORBIDDEN = [
  "TryFrequencyGatedAcceptedShotForProof",
  "RecordFrameSampleForProof",
  "RaiseShotAcceptedForProof",
];

const SCAN = [
  "Assets/Scripts/Weapons/HertzDualPistolRuntime.cs",
  "Assets/Scripts/Analytics/HertzAnalyticsCapture.cs",
  "Assets/Editor/HertzStudio/HertzStudioAnalyticsProof.cs",
  "Assets/Editor/HertzStudio/HertzStudioSoundCommands.cs",
];

describe("forbid obsolete W06/W07 proof bypasses", () => {
  for (const rel of SCAN) {
    it(`forbids bypass names in ${rel}`, () => {
      const full = path.join(PROJECT_ROOT, rel);
      assert.ok(fs.existsSync(full), `missing ${rel}`);
      const text = fs.readFileSync(full, "utf8");
      for (const name of FORBIDDEN) {
        assert.equal(text.includes(name), false, `${rel} still contains ${name}`);
      }
    });
  }
});
