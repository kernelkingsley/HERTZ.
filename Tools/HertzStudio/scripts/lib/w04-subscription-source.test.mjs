/**
 * Source-integrity: subscription proof must not contain a manual activation fallback path.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const proofPath = path.resolve(
  __dirname,
  "../../../../Assets/Editor/HertzStudio/HertzStudioWeaponProof.cs",
);

describe("W04 subscription proof source integrity", () => {
  it("rejects subscription block containing RaiseActivate/HandleActivate fallback", () => {
    const src = fs.readFileSync(proofPath, "utf8");
    const startMarker = "--- Input System subscription proof";
    const endMarker = "--- Sound integration boundary";
    const start = src.indexOf(startMarker);
    const end = src.indexOf(endMarker);
    assert.ok(start >= 0, "subscription proof section marker missing");
    assert.ok(end > start, "sound boundary marker missing after subscription");
    const block = src.slice(start, end);
    assert.equal(
      /RaiseActivateFromInputBoundary/.test(block),
      false,
      "subscription proof must not call RaiseActivateFromInputBoundary",
    );
    assert.equal(
      /HandleActivate\s*\(/.test(block),
      false,
      "subscription proof must not call HandleActivate",
    );
    // After the direct_tryfire negative, the Input press path must not use TryFire as rescue.
    const pressIdx = block.indexOf("TryPressKey");
    assert.ok(pressIdx >= 0, "subscription proof must use TryPressKey");
    const afterPress = block.slice(pressIdx);
    assert.equal(
      /TryFireLeftForProof|TryFireRightForProof|RaiseActivateFromInputBoundary/.test(afterPress),
      false,
      "after TryPressKey, no manual fire/activate fallback allowed",
    );
    assert.ok(
      /input_subscription_one_shot/.test(block),
      "subscription check name required",
    );
  });
});
