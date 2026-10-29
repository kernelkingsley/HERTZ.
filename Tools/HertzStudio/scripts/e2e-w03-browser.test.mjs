import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertLocalSpaceLabel,
  assertWorldSpaceLabel,
  assertNoTautologyPass,
  assertPersistedPositionChanged,
  assertErrorVisible,
  assertConnectionKind,
  assertProtectedObjectSelected,
  assertFreshProtectedError,
  assertDraftAndQueueUnchanged,
  assertCompatibleDropResult,
  assertE2eRunnerEnablesMode,
  assertNoProtectedSelectionSwallow,
  assertLevelEditorHooksGated,
  objectIdFingerprint,
} from "./lib/e2e-w03-assertions.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const e2eSource = fs.readFileSync(path.join(__dirname, "e2e-w03-browser.mjs"), "utf8");
const levelEditorSource = fs.readFileSync(
  path.join(__dirname, "../web/src/pages/LevelEditor.jsx"),
  "utf8",
);

describe("e2e-w03 fail-closed assertions", () => {
  it("rejects missing local space label", () => {
    assert.throws(() => assertLocalSpaceLabel("world root"), /local/i);
  });

  it("accepts local space label", () => {
    assert.equal(assertLocalSpaceLabel("Numeric fields are local (parented object)."), true);
  });

  it("rejects world label when expecting local", () => {
    assert.throws(() => assertLocalSpaceLabel(""), /local/i);
  });

  it("rejects tautology patterns", () => {
    assert.throws(() => assertNoTautologyPass("Boolean(space) || true"), /Tautology/);
    assert.throws(() => assertNoTautologyPass("space.length >= 0"), /Meaningless/);
  });

  it("e2e runner source contains no tautologies", () => {
    assert.equal(assertNoTautologyPass(e2eSource), true);
  });

  it("e2e runner does not use API PUT as numeric UI fallback", () => {
    assert.equal(/api-fallback-after-ui-select/.test(e2eSource), false);
    assert.equal(/Transform inputs not found/.test(e2eSource), false);
  });

  it("persisted position change requires real delta", () => {
    assert.throws(
      () => assertPersistedPositionChanged({ x: 1 }, { x: 1.01 }, "x", 0.05),
      /did not change/,
    );
    assert.equal(assertPersistedPositionChanged({ x: 1 }, { x: 1.2 }, "x", 0.05), true);
  });

  it("error visibility requires matching text", () => {
    assert.throws(() => assertErrorVisible("", /protected/i), /empty/);
    assert.equal(assertErrorVisible("Protected XR/camera", /protected/i), true);
  });

  it("connection kind must appear in panel text", () => {
    assert.throws(() => assertConnectionKind("online ready", "offline"), /offline/);
    assert.equal(assertConnectionKind("Unity offline — drafts OK", "offline"), true);
  });

  it("world space helper works", () => {
    assert.equal(assertWorldSpaceLabel("Numeric fields are world (root object)."), true);
  });
});

describe("e2e-w03 drop proof negatives", () => {
  it("fails when Main Camera cannot be selected", () => {
    assert.throws(
      () =>
        assertProtectedObjectSelected({
          selectedLabel: "Selected: HertzW03Hierarchy_Root",
          selectedObjectId: "root-1",
          cameraObjectId: "cam-1",
        }),
      /Main Camera/i,
    );
  });

  it("fails when protected error is stale (reuses incompatible error)", () => {
    const stale = 'Claimed type "audio" does not match catalog type "model_3d".';
    assert.throws(() => assertFreshProtectedError(stale, stale), /reused/i);
    assert.throws(() => assertFreshProtectedError("", "prior"), /empty/i);
  });

  it("fails when incompatible drop changes draft or queue", () => {
    const before = {
      version: 3,
      objects: [{ objectId: "a" }, { objectId: "b" }],
      queueCount: 2,
    };
    assert.throws(
      () =>
        assertDraftAndQueueUnchanged(before, {
          version: 4,
          objects: before.objects,
          queueCount: 2,
        }),
      /version changed/i,
    );
    assert.throws(
      () =>
        assertDraftAndQueueUnchanged(before, {
          version: 3,
          objects: [{ objectId: "a" }, { objectId: "c" }],
          queueCount: 2,
        }),
      /identities changed/i,
    );
    assert.throws(
      () =>
        assertDraftAndQueueUnchanged(before, {
          version: 3,
          objects: before.objects,
          queueCount: 3,
        }),
      /queue/i,
    );
  });

  it("fails when compatible drop leaves No draft loaded", () => {
    assert.throws(
      () =>
        assertCompatibleDropResult({
          before: { version: 1, objects: [{ objectId: "a" }] },
          after: {
            version: 2,
            objects: [{ objectId: "a" }, { objectId: "lib-x", operation: "instantiate_model" }],
          },
          modelId: "m1",
          dropErrorText: "",
          applyBlockText: "Apply disabled: No draft loaded for Unity's active scene.",
        }),
      /No draft loaded/i,
    );
  });

  it("fails when E2E mode enablement is absent from runner", () => {
    assert.throws(() => assertE2eRunnerEnablesMode("no hooks here"), /addInitScript|E2E/i);
  });

  it("e2e runner intentionally enables E2E mode", () => {
    assert.equal(assertE2eRunnerEnablesMode(e2eSource), true);
  });

  it("e2e runner does not swallow Main Camera selection or reuse incompatErr", () => {
    assert.equal(assertNoProtectedSelectionSwallow(e2eSource), true);
  });

  it("LevelEditor gates test hooks behind isHertzE2eMode", () => {
    assert.equal(assertLevelEditorHooksGated(levelEditorSource), true);
  });

  it("queueDelta assertion requires exact zero", () => {
    const before = { version: 1, objects: [{ objectId: "a" }], queueCount: 5 };
    assert.equal(
      assertDraftAndQueueUnchanged(before, { version: 1, objects: before.objects, queueCount: 5 }),
      true,
    );
    assert.equal(objectIdFingerprint([{ objectId: "b" }, { objectId: "a" }]), "a|b");
  });
});
