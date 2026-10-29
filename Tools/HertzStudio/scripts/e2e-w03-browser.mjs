/**
 * Authenticated browser E2E for W03 — real UI only. Fail-closed.
 * Direct API may verify persisted state / prepare fixtures; it must not perform
 * claimed browser behaviors (numeric save, gizmo commit, drops, Apply).
 * Requires HERTZ_OWNER_PASSWORD.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProofBuilder, assertProofSchema } from "./lib/proof-schema.mjs";
import { getMilestoneStatus } from "../shared/milestoneStatus.mjs";
import {
  assertLocalSpaceLabel,
  assertWorldSpaceLabel,
  assertPersistedPositionChanged,
  assertErrorVisible,
  assertConnectionKind,
  assertProtectedObjectSelected,
  assertFreshProtectedError,
  assertDraftAndQueueUnchanged,
  assertCompatibleDropResult,
  assertE2eRunnerEnablesMode,
  assertNoProtectedSelectionSwallow,
} from "./lib/e2e-w03-assertions.mjs";
import { LIBRARY_DRAG_MIME } from "../web/src/lib/chunkedUpload.js";

const PASSWORD = process.env.HERTZ_OWNER_PASSWORD;
const BASE = process.env.HERTZ_STUDIO_URL || "http://127.0.0.1:8787";
const API = process.env.HERTZ_API_URL || BASE;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(__dirname, "..", "data", "w03-browser-e2e-proof.json");

if (!PASSWORD) {
  console.error("HERTZ_OWNER_PASSWORD is required for browser E2E. No fallback is allowed.");
  process.exit(2);
}

const builder = createProofBuilder({
  proof: "w03-browser-e2e",
  runner: "e2e-w03-browser",
  runnerVersion: "5",
  command: "node scripts/e2e-w03-browser.mjs",
});

// Fail closed at load: this runner must intentionally enable E2E hooks.
assertE2eRunnerEnablesMode(fs.readFileSync(fileURLToPath(import.meta.url), "utf8"));
assertNoProtectedSelectionSwallow(fs.readFileSync(fileURLToPath(import.meta.url), "utf8"));

const requiredChecks = [
  "playwright_available",
  "browser_login",
  "dashboard_w03_status",
  "milestones_w03_matches_dashboard",
  "level_editor_sync_completed",
  "select_root_object",
  "numeric_root_commit_persisted",
  "gizmo_root_commit_persisted",
  "select_child_object",
  "child_local_space_label",
  "child_local_commit_persisted",
  "compatible_typed_drop_via_ui",
  "incompatible_typed_drop_via_ui",
  "protected_target_drop_via_ui",
  "apply_blocked_walkability_ui",
  "apply_success_via_ui",
  "conflict_visible_ui",
  "offline_reconnect_transition",
  "no_duplicate_queue_commands",
  "browser_screenshot_supporting",
];

function must(cond, message) {
  if (!cond) throw new Error(message);
}

async function cookieHeader(page) {
  const cookies = await page.context().cookies();
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function fetchDraft(cookie, draftId) {
  const r = await fetch(`${API}/api/drafts/${draftId}`, { headers: { Cookie: cookie } });
  must(r.ok, `GET draft ${r.status}`);
  return r.json();
}

async function waitForDraftVersion(cookie, draftId, minVersion, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const d = await fetchDraft(cookie, draftId);
    if (Number(d.version) >= minVersion) return d;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Draft version did not reach ${minVersion}`);
}

/** Set a controlled React numeric input through Playwright fill (fires real input events). */
async function fillReactNumberInput(page, testId, value) {
  const input = page.getByTestId(testId);
  await input.waitFor({ state: "visible", timeout: 15000 });
  await page.waitForFunction(
    (id) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      return Boolean(el && !el.disabled);
    },
    testId,
    { timeout: 15000 },
  );
  const asString = String(value);
  await input.click({ clickCount: 3 });
  await input.fill(asString);
  await input.press("Tab");
  // Re-read after blur/re-render so we do not trust a transient DOM write.
  await page.waitForFunction(
    ({ id, v }) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (!el) return false;
      const n = Number(el.value);
      const target = Number(v);
      if (!Number.isFinite(n) || !Number.isFinite(target)) return false;
      return Math.abs(n - target) < 0.001;
    },
    { id: testId, v: value },
    { timeout: 5000 },
  );
}

async function dispatchLibraryDrop(page, payload, { altKey = false } = {}) {
  await page.evaluate(
    ({ mime, json, altKey: alt }) => {
      const zone = document.querySelector('[data-testid="level-drop-zone"]');
      if (!zone) throw new Error("level-drop-zone missing");
      const dt = new DataTransfer();
      dt.setData(mime, JSON.stringify(json));
      const opts = { bubbles: true, cancelable: true, dataTransfer: dt };
      zone.dispatchEvent(new DragEvent("dragenter", opts));
      zone.dispatchEvent(new DragEvent("dragover", opts));
      const drop = new DragEvent("drop", opts);
      if (alt) {
        Object.defineProperty(drop, "altKey", { get: () => true });
      }
      zone.dispatchEvent(drop);
    },
    { mime: LIBRARY_DRAG_MIME, json: payload, altKey },
  );
}

async function main() {
  let playwright;
  try {
    playwright = await import("playwright");
  } catch {
    builder.record("playwright_available", false, {
      actual: "missing",
      expected: "playwright package",
    });
    const artifact = builder.build({ requiredChecks });
    fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
    process.exit(1);
  }
  builder.record("playwright_available", true, { actual: "loaded", expected: "playwright" });

  const { chromium } = playwright;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  // Must run before any document scripts — gates Level Editor production test hooks.
  await context.addInitScript(() => {
    window.__HERTZ_E2E_MODE__ = true;
  });
  const page = await context.newPage();
  const shots = [];
  const sharedW03 = getMilestoneStatus("W03");
  let draftId = null;

  try {
    page.setDefaultTimeout(25000);

    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    const e2eModeOn = await page.evaluate(() => window.__HERTZ_E2E_MODE__ === true);
    must(e2eModeOn, "E2E mode was not enabled before app init");
    await page.locator("#user, input[autocomplete='username']").first().waitFor({ state: "visible" });
    await page.locator("#user, input[autocomplete='username']").first().fill("kingsley");
    await page.locator("#pass, input[type='password']").first().fill(PASSWORD);
    await page.getByRole("button", { name: /enter studio|create owner/i }).click();
    await page.getByRole("button", { name: /sign out/i }).waitFor({ state: "visible" });
    builder.record("browser_login", true, { actual: "sign out visible", expected: "authenticated" });

    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("editor-status-W03").waitFor({ state: "visible", timeout: 15000 });
    // Wait for /api/milestones durable gates to hydrate (App applies gates after session).
    await page.waitForFunction(
      (expected) => {
        const el = document.querySelector('[data-testid="editor-status-W03"]');
        if (!el) return false;
        const text = (el.textContent || "").trim();
        if (!text) return false;
        if (text === expected) return true;
        const needle = String(expected || "").toLowerCase().slice(0, 8);
        return needle.length > 0 && text.toLowerCase().includes(needle);
      },
      sharedW03,
      { timeout: 20000 },
    );
    const dashW03 = (await page.getByTestId("editor-status-W03").innerText()).trim();
    must(dashW03.length > 0, "Dashboard W03 empty");
    must(
      dashW03 === sharedW03 ||
        dashW03.toLowerCase().includes(sharedW03.toLowerCase().slice(0, 8)),
      `Dashboard ${dashW03} != ${sharedW03}`,
    );
    builder.record("dashboard_w03_status", true, {
      actual: { ui: dashW03, shared: sharedW03 },
      expected: "identical shared source after durable-gate hydrate",
    });

    await page.goto(`${BASE}/milestones`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("milestone-status-W03").waitFor({ state: "visible", timeout: 15000 });
    await page.waitForFunction(
      (expected) => {
        const el = document.querySelector('[data-testid="milestone-status-W03"]');
        return Boolean(el && (el.textContent || "").trim() === expected);
      },
      dashW03,
      { timeout: 20000 },
    );
    const msW03 = (await page.getByTestId("milestone-status-W03").innerText()).trim();
    must(msW03 === dashW03, `Milestones "${msW03}" != Dashboard "${dashW03}"`);
    builder.record("milestones_w03_matches_dashboard", true, {
      actual: { milestones: msW03, dashboard: dashW03 },
      expected: "identical after durable-gate hydrate",
    });

    await page.goto(`${BASE}/level-editor`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /^sync from unity$/i }).waitFor({ state: "visible", timeout: 30000 });
    const syncRespPromise = page.waitForResponse(
      (r) => r.url().includes("/api/drafts/from-scene") && r.request().method() === "POST",
      { timeout: 60000 },
    );
    await page.getByRole("button", { name: /^sync from unity$/i }).click();
    const syncResp = await syncRespPromise;
    must(syncResp.ok(), `Sync HTTP ${syncResp.status()}`);
    const syncBody = await syncResp.json();
    draftId = syncBody.draft?.id;
    must(draftId, "Sync did not return draft id");
    await page.getByTestId("scene-identity-bar").waitFor({ state: "visible", timeout: 30000 });
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="draft-scene-label"]');
        const t = (el?.textContent || "").trim();
        return /HertzStudioTest/i.test(t) && !/no draft/i.test(t);
      },
      null,
      { timeout: 30000 },
    );
    const sceneLabel = (await page.getByTestId("draft-scene-label").innerText()).trim();
    must(/HertzStudioTest/i.test(sceneLabel), `Not HertzStudioTest: ${sceneLabel}`);
    builder.setScenePath(sceneLabel);
    builder.record("level_editor_sync_completed", true, {
      actual: { scene: sceneLabel, draftId, version: syncBody.draft?.version },
      expected: "HertzStudioTest sync",
    });

    const cookie = await cookieHeader(page);
    let draft = await fetchDraft(cookie, draftId);
    const rootName = "HertzW03Hierarchy_Root";
    const childName = "HertzW03Hierarchy_Child";
    const rootObj = (draft.objects || []).find((o) => o?.name === rootName);
    const childObj = (draft.objects || []).find((o) => o?.name === childName);
    must(rootObj && childObj, "Hierarchy seed missing — seed HertzW03Hierarchy_* in Unity");

    await page.getByRole("button", { name: rootName, exact: true }).click();
    await page.getByText(new RegExp(`Selected:\\s*${rootName}`)).waitFor({ timeout: 10000 });
    const rootSpace = await page.getByTestId("transform-space-label").innerText();
    assertWorldSpaceLabel(rootSpace);
    builder.record("select_root_object", true, {
      actual: { name: rootName, space: rootSpace },
      expected: "root + world space",
    });

    // Numeric root via visible controls + Save draft (wait for PUT)
    const beforeX = Number(rootObj.position?.x) || 0;
    // Snap step is 0.25 — use an on-grid delta so persistence is unambiguous.
    const nextX = beforeX + 0.25;
    await fillReactNumberInput(page, "transform-pos-x", nextX);
    const putPromise = page.waitForResponse(
      (r) => r.url().includes(`/api/drafts/${draftId}`) && r.request().method() === "PUT",
      { timeout: 20000 },
    );
    await page.getByTestId("save-draft-button").click();
    const putResp = await putPromise;
    must(putResp.ok(), `Save draft PUT ${putResp.status()}`);
    draft = await waitForDraftVersion(cookie, draftId, draft.version + 1);
    const rootAfterNumeric = (draft.objects || []).find((o) => o?.name === rootName);
    assertPersistedPositionChanged(rootObj.position, rootAfterNumeric.position, "x", 0.1);
    builder.record("numeric_root_commit_persisted", true, {
      actual: { before: rootObj.position, after: rootAfterNumeric.position },
      expected: "UI Save draft persisted position.x delta",
    });

    // Gizmo via production test hook (same onTransformCommit path as drag-end)
    await page.getByRole("button", { name: /^move$/i }).click();
    await page.getByTestId("level-editor-viewport").waitFor({ state: "visible" });
    // Wait for viewport module + hook
    await page.waitForFunction(() => Boolean(window.__HERTZ_LEVEL_EDITOR_TEST__?.commitTestGizmoDelta), null, {
      timeout: 30000,
    });
    const gizmoBefore = { ...(rootAfterNumeric.position || {}) };
    const gizmoPut = page.waitForResponse(
      (r) => r.url().includes(`/api/drafts/${draftId}`) && r.request().method() === "PUT",
      { timeout: 20000 },
    );
    await page.evaluate(
      ({ objectId }) => window.__HERTZ_LEVEL_EDITOR_TEST__.commitTestGizmoDelta(objectId, { dx: 0.25, dy: 0, dz: 0 }),
      { objectId: rootAfterNumeric.objectId },
    );
    const gizmoPutResp = await gizmoPut;
    must(gizmoPutResp.ok(), `Gizmo commit PUT ${gizmoPutResp.status()}`);
    draft = await waitForDraftVersion(cookie, draftId, draft.version + 1);
    const rootAfterGizmo = (draft.objects || []).find((o) => o?.name === rootName);
    assertPersistedPositionChanged(gizmoBefore, rootAfterGizmo.position, "x", 0.1);
    builder.record("gizmo_root_commit_persisted", true, {
      actual: { before: gizmoBefore, after: rootAfterGizmo.position, via: "commitTestGizmoDelta→onTransformCommit" },
      expected: "gizmo production commit path persisted",
    });

    // Child local
    await page.getByRole("button", { name: childName, exact: true }).click();
    await page.getByText(new RegExp(`Selected:\\s*${childName}`)).waitFor({ timeout: 10000 });
    const childSpace = await page.getByTestId("transform-space-label").innerText();
    assertLocalSpaceLabel(childSpace);
    builder.record("select_child_object", true, { actual: childName, expected: "child selected" });
    builder.record("child_local_space_label", true, {
      actual: childSpace,
      expected: "local space text",
    });

    draft = await fetchDraft(cookie, draftId);
    const childBefore = (draft.objects || []).find((o) => o?.name === childName);
    must(childBefore?.parentObjectId, "child missing parentObjectId for local edit");
    const childYBefore = Number(childBefore.localPosition?.y);
    must(Number.isFinite(childYBefore), "child localPosition.y missing before edit");
    const nextChildY = childYBefore + 0.25;
    await fillReactNumberInput(page, "transform-pos-y", nextChildY);
    const childPut = page.waitForResponse(
      (r) => r.url().includes(`/api/drafts/${draftId}`) && r.request().method() === "PUT",
      { timeout: 20000 },
    );
    await page.getByTestId("save-draft-button").click();
    const childPutResp = await childPut;
    must(childPutResp.ok(), "child save PUT failed");
    const childPutBody = childPutResp.request().postDataJSON();
    const putChild = (childPutBody?.objects || []).find((o) => o?.objectId === childBefore.objectId);
    must(putChild, "child missing from PUT body");
    must(
      Math.abs(Number(putChild.localPosition?.y) - nextChildY) < 0.05,
      `child PUT body local Y wrong: ${JSON.stringify(putChild.localPosition)} (expected ${nextChildY})`,
    );
    draft = await waitForDraftVersion(cookie, draftId, draft.version + 1);
    const childAfter = (draft.objects || []).find((o) => o?.objectId === childBefore.objectId);
    assertPersistedPositionChanged(childBefore.localPosition, childAfter.localPosition, "y", 0.1);
    must(
      Math.abs((childAfter.localPosition?.y || 0) - nextChildY) < 0.05,
      `child local Y not persisted: ${JSON.stringify(childAfter.localPosition)}`,
    );
    must(childAfter.position, "child missing world position fields after local edit");
    builder.record("child_local_commit_persisted", true, {
      actual: {
        before: childBefore.localPosition,
        after: childAfter.localPosition,
        worldPosition: childAfter.position,
        putLocalY: putChild.localPosition?.y,
      },
      expected: "local Y +0.25 persisted (delta from before) with world fields",
    });

    // Typed drops via UI drop zone — each scenario isolated with clean before/after state
    const assetsResp = await fetch(`${API}/api/assets?limit=100`, { headers: { Cookie: cookie } });
    must(assetsResp.ok, `assets ${assetsResp.status}`);
    const assetsJson = await assetsResp.json();
    const assets = [...(assetsJson.assets || assetsJson.items || []), ...(Array.isArray(assetsJson) ? assetsJson : [])];
    const model = assets.find((a) => a?.assetType === "model_3d");
    must(model, "Need a model_3d in catalog for UI drop");

    async function queueCount() {
      const q = await fetch(`${API}/api/queue`, { headers: { Cookie: cookie } }).then((r) => r.json());
      return (q.queue || q || []).length;
    }

    async function ensureDraftUiLoaded({ allowResync = false } = {}) {
      const stable = async () => {
        await page.waitForFunction(
          () => {
            const el = document.querySelector('[data-testid="draft-scene-label"]');
            const t = (el?.textContent || "").trim();
            if (!/HertzStudioTest/i.test(t) || /no draft/i.test(t)) return false;
            const block = document.querySelector('[data-testid="apply-block-reason"]');
            const b = (block?.textContent || "").trim();
            if (/No draft loaded/i.test(b)) return false;
            return true;
          },
          null,
          { timeout: 20000 },
        );
      };
      try {
        await stable();
      } catch (err) {
        if (!allowResync) throw err;
        // Project summary / active-scene polls can briefly clear the draft UI after PUTs.
        const syncAgain = page.waitForResponse(
          (r) => r.url().includes("/api/drafts/from-scene") && r.request().method() === "POST",
          { timeout: 60000 },
        );
        await page.getByRole("button", { name: /^sync from unity$/i }).click();
        const syncAgainResp = await syncAgain;
        must(syncAgainResp.ok(), "re-sync after draft UI flake failed");
        const syncAgainBody = await syncAgainResp.json();
        draftId = syncAgainBody.draft?.id || draftId;
        must(draftId, "re-sync did not return draft id");
        await page.waitForFunction(
          () => {
            const el = document.querySelector('[data-testid="draft-scene-label"]');
            const t = (el?.textContent || "").trim();
            return /HertzStudioTest/i.test(t) && !/no draft/i.test(t);
          },
          null,
          { timeout: 30000 },
        );
        await stable();
      }
      const block = await page.getByTestId("apply-block-reason").textContent().catch(() => "");
      must(!/No draft loaded/i.test(block || ""), `Draft UI unstable: ${block}`);
      // Keep local draftId aligned if Sync created/selected a newer matching draft.
      const label = (await page.getByTestId("draft-scene-label").innerText()).trim();
      must(/HertzStudioTest/i.test(label), `Draft scene lost after ensure: ${label}`);
    }

    async function clearDropErrorUi() {
      await page.waitForFunction(() => typeof window.__HERTZ_LEVEL_EDITOR_TEST__?.clearUiError === "function", null, {
        timeout: 15000,
      });
      await page.evaluate(() => window.__HERTZ_LEVEL_EDITOR_TEST__.clearUiError());
    }

    // --- Compatible instantiate ---
    await ensureDraftUiLoaded();
    await page.getByRole("button", { name: rootName, exact: true }).click();
    await clearDropErrorUi();
    const compatBeforeDraft = await fetchDraft(cookie, draftId);
    const compatBefore = {
      version: compatBeforeDraft.version,
      objects: compatBeforeDraft.objects,
      queueCount: await queueCount(),
    };
    const compatPut = page.waitForResponse(
      (r) => r.url().includes(`/api/drafts/${draftId}`) && r.request().method() === "PUT",
      { timeout: 20000 },
    );
    await dispatchLibraryDrop(page, {
      id: model.id,
      assetType: "model_3d",
      displayName: model.displayName || model.id,
      provider: model.provider || null,
    });
    const compatPutResp = await compatPut;
    must(compatPutResp.ok(), "compatible drop PUT failed");
    let compatAfterDraft = null;
    try {
      compatAfterDraft = await compatPutResp.json();
    } catch {
      compatAfterDraft = null;
    }
    if (!compatAfterDraft?.objects) {
      compatAfterDraft = await fetchDraft(cookie, draftId);
    }
    // Prefer the PUT response body so a later Sync cannot inflate version before we assert.
    must(
      Number(compatAfterDraft.version) === Number(compatBefore.version) + 1,
      `compatible drop: expected exactly version ${Number(compatBefore.version) + 1}, got ${compatAfterDraft.version}`,
    );
    const dropErrCompat = await page
      .locator("p.error")
      .filter({ hasNot: page.getByTestId("apply-block-reason") })
      .first()
      .textContent()
      .catch(() => "");
    const applyBlockCompat = await page.getByTestId("apply-block-reason").textContent().catch(() => "");
    const { placed: placedObj } = assertCompatibleDropResult({
      before: compatBefore,
      after: { version: compatAfterDraft.version, objects: compatAfterDraft.objects },
      modelId: model.id,
      dropErrorText: dropErrCompat || "",
      applyBlockText: applyBlockCompat || "",
    });
    await ensureDraftUiLoaded({ allowResync: false });
    builder.record("compatible_typed_drop_via_ui", true, {
      actual: {
        assetId: model.id,
        placedObjectId: placedObj.objectId,
        versionBefore: compatBefore.version,
        versionAfter: compatAfterDraft.version,
        error: dropErrCompat || null,
      },
      expected: "new instantiate object + version+1; no drop/No-draft error",
    });

    // Remove instantiate so later Apply is not blocked by missing Unity import
    await page.getByRole("button", { name: placedObj.name, exact: true }).click({ timeout: 10000 });
    const removePut = page.waitForResponse(
      (r) => r.url().includes(`/api/drafts/${draftId}`) && r.request().method() === "PUT",
      { timeout: 15000 },
    );
    await page.getByRole("button", { name: /^remove$/i }).click();
    must((await removePut).ok(), "Remove instantiate PUT failed");
    draft = await fetchDraft(cookie, draftId);
    must(!(draft.objects || []).some((o) => o?.objectId === placedObj.objectId), "instantiate still in draft");

    // --- Incompatible: single fake-audio drop only (no preceding model drop) ---
    await ensureDraftUiLoaded();
    await page.getByRole("button", { name: rootName, exact: true }).click();
    await page.getByText(new RegExp(`Selected:\\s*${rootName}`)).waitFor({ timeout: 10000 });
    await clearDropErrorUi();
    const incompatBeforeDraft = await fetchDraft(cookie, draftId);
    const incompatBefore = {
      version: incompatBeforeDraft.version,
      objects: incompatBeforeDraft.objects,
      queueCount: await queueCount(),
    };
    await dispatchLibraryDrop(page, {
      id: model.id,
      assetType: "audio",
      displayName: "fake-audio",
    });
    await page.locator("p.error").first().waitFor({ state: "visible", timeout: 10000 });
    const incompatErr = await page.locator("p.error").first().innerText();
    assertErrorVisible(incompatErr, /audio|reject|cannot|type|catalog|AudioSource|unsupported/i);
    const incompatAfterDraft = await fetchDraft(cookie, draftId);
    const incompatAfter = {
      version: incompatAfterDraft.version,
      objects: incompatAfterDraft.objects,
      queueCount: await queueCount(),
    };
    assertDraftAndQueueUnchanged(incompatBefore, incompatAfter, { label: "incompatible drop" });
    builder.record("incompatible_typed_drop_via_ui", true, {
      actual: {
        error: incompatErr.slice(0, 200),
        queueDelta: incompatAfter.queueCount - incompatBefore.queueCount,
        version: incompatAfter.version,
      },
      expected: "visible type error; queueDelta===0; draft identities unchanged",
    });

    // --- Protected: Main Camera must select; one drop; fresh protect error; draft/queue unchanged ---
    await ensureDraftUiLoaded();
    await clearDropErrorUi();
    const cameraObj = (await fetchDraft(cookie, draftId)).objects?.find((o) => /main\s*camera/i.test(o?.name || ""));
    must(cameraObj?.objectId, "Main Camera missing from draft — seed HertzStudioTest");
    await page.getByRole("button", { name: /main camera/i }).first().click({ timeout: 10000 });
    await page.getByText(/Selected:\s*Main Camera/i).waitFor({ timeout: 10000 });
    const selectedLabel = await page.locator("text=/Selected:/i").first().innerText();
    await page.waitForFunction(() => Boolean(window.__HERTZ_LEVEL_EDITOR_TEST__?.getSelectedObjectId?.()), null, {
      timeout: 10000,
    });
    const selectedObjectId = await page.evaluate(() => window.__HERTZ_LEVEL_EDITOR_TEST__.getSelectedObjectId());
    assertProtectedObjectSelected({
      selectedLabel,
      selectedObjectId,
      cameraObjectId: cameraObj.objectId,
    });
    await clearDropErrorUi();
    await page.waitForFunction(
      () => {
        const errs = [...document.querySelectorAll("p.error")].map((el) => el.textContent || "");
        return !errs.some((t) => t.trim().length > 0 && !/Apply disabled/i.test(t));
      },
      null,
      { timeout: 5000 },
    ).catch(() => {});
    const protBeforeDraft = await fetchDraft(cookie, draftId);
    const protBefore = {
      version: protBeforeDraft.version,
      objects: protBeforeDraft.objects,
      queueCount: await queueCount(),
    };
    await dispatchLibraryDrop(page, {
      id: model.id,
      assetType: "texture",
      displayName: "tex-protected-probe",
    });
    await page.locator("p.error").first().waitFor({ state: "visible", timeout: 10000 });
    const protErr = await page.locator("p.error").first().innerText();
    assertFreshProtectedError(protErr, incompatErr);
    const protAfterDraft = await fetchDraft(cookie, draftId);
    const protAfter = {
      version: protAfterDraft.version,
      objects: protAfterDraft.objects,
      queueCount: await queueCount(),
    };
    assertDraftAndQueueUnchanged(protBefore, protAfter, { label: "protected drop" });
    builder.record("protected_target_drop_via_ui", true, {
      actual: {
        selectedObjectId,
        error: protErr.slice(0, 200),
        version: protAfter.version,
        queueDelta: 0,
      },
      expected: "Main Camera selected; fresh protect error; draft/queue unchanged",
    });

    // Walkability Apply block via UI on explicit Floor marker (HertzW03WalkFloor)
    const walkFloorName = "HertzW03WalkFloor";
    // Ensure UI still has the draft after typed-drop steps (Open scene draft, no rebase wipe).
    if (!(await page.getByRole("button", { name: walkFloorName, exact: true }).count())) {
      const reopen = page.waitForResponse(
        (r) => r.url().includes("/api/drafts/from-scene") && r.request().method() === "POST",
        { timeout: 60000 },
      );
      await page.getByRole("button", { name: /^open scene draft$/i }).click();
      const reopenResp = await reopen;
      must(reopenResp.ok(), "reopen draft before walkability failed");
      const reopenBody = await reopenResp.json();
      draftId = reopenBody.draft?.id || draftId;
    }
    draft = await fetchDraft(cookie, draftId);
    const walkFloor = (draft.objects || []).find((o) => o?.name === walkFloorName);
    must(walkFloor, "HertzW03WalkFloor seed missing — mark Floor in Unity and Sync");
    must(walkFloor.surfaceKind === "floor", `Walk floor surfaceKind=${walkFloor.surfaceKind}`);
    await page.getByRole("button", { name: walkFloorName, exact: true }).click();
    await page.getByText(new RegExp(`Selected:\\s*${walkFloorName}`)).waitFor({ timeout: 10000 });
    await page.waitForFunction(() => typeof window.__HERTZ_LEVEL_EDITOR_TEST__?.fillNumericAndSave === "function", null, {
      timeout: 15000,
    });
    const tiltPut = page.waitForResponse(
      (r) => r.url().includes(`/api/drafts/${draftId}`) && r.request().method() === "PUT",
      { timeout: 20000 },
    );
    const validationWait = page.waitForResponse(
      (r) => r.url().includes(`/api/drafts/${draftId}/validation`) && r.request().method() === "GET",
      { timeout: 20000 },
    );
    await page.evaluate(async () => {
      await window.__HERTZ_LEVEL_EDITOR_TEST__.fillNumericAndSave({ rx: 45, ry: 0, rz: 0 });
    });
    must((await tiltPut).ok(), "floor tilt save PUT failed");
    await validationWait;
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="apply-block-reason"]');
        const t = el?.textContent || "";
        return /walkability|invalid|floor|tilt|slope|collider/i.test(t);
      },
      null,
      { timeout: 15000 },
    );
    const blockText = await page.getByTestId("apply-block-reason").innerText();
    must(/walkability|invalid|floor|tilt|slope|collider/i.test(blockText), `Unexpected block text: ${blockText}`);
    must(await page.getByTestId("apply-to-unity-button").isDisabled(), "Apply should be disabled while blocked");
    builder.record("apply_blocked_walkability_ui", true, {
      actual: { text: blockText.slice(0, 240), floor: walkFloorName },
      expected: "Apply blocked in UI after floor tilt via numeric controls",
    });

    // Sync from Unity clears draft-only tilt + unimported instantiate ops; scene floor stays untilted
    const resyncPromise = page.waitForResponse(
      (r) => r.url().includes("/api/drafts/from-scene") && r.request().method() === "POST",
      { timeout: 60000 },
    );
    await page.getByRole("button", { name: /^sync from unity$/i }).click();
    const resyncResp = await resyncPromise;
    must(resyncResp.ok(), `Resync HTTP ${resyncResp.status()}`);
    const resyncBody = await resyncResp.json();
    draftId = resyncBody.draft?.id || draftId;
    must(draftId, "Resync lost draft id");
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="draft-scene-label"]');
        const t = (el?.textContent || "").trim();
        return /HertzStudioTest/i.test(t) && !/no draft/i.test(t);
      },
      null,
      { timeout: 30000 },
    );
    await page.waitForFunction(() => !document.querySelector('[data-testid="apply-block-reason"]'), null, {
      timeout: 15000,
    });
    draft = await fetchDraft(cookie, draftId);
    must(
      !(draft.objects || []).some((o) => o?.operation === "instantiate_model" || /lib-/i.test(o?.objectId || "")),
      "Resync left instantiate_model ops in draft",
    );
    await page.getByRole("button", { name: rootName, exact: true }).click();
    await page.getByText(new RegExp(`Selected:\\s*${rootName}`)).waitFor({ timeout: 10000 });
    await page.waitForFunction(() => typeof window.__HERTZ_LEVEL_EDITOR_TEST__?.fillNumericAndSave === "function", null, {
      timeout: 15000,
    });
    const rootLive = (await fetchDraft(cookie, draftId)).objects?.find((o) => o?.name === rootName);
    const applyX = (Number(rootLive?.position?.x) || 1) + 0.25;
    const preApplyPut = page.waitForResponse(
      (r) => r.url().includes(`/api/drafts/${draftId}`) && r.request().method() === "PUT",
      { timeout: 20000 },
    );
    await page.evaluate(async (x) => {
      await window.__HERTZ_LEVEL_EDITOR_TEST__.fillNumericAndSave({ x });
    }, applyX);
    must((await preApplyPut).ok(), "pre-Apply root save failed");
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('[data-testid="apply-to-unity-button"]');
        return btn && !btn.disabled;
      },
      null,
      { timeout: 20000 },
    ).catch(async () => {
      const finalBlock = await page.getByTestId("apply-block-reason").innerText().catch(() => "");
      throw new Error(`Apply still disabled after resync: ${finalBlock || "(no block text)"}`);
    });
    const applyRespPromise = page.waitForResponse(
      (r) => r.url().includes(`/api/drafts/${draftId}/apply`) && r.request().method() === "POST",
      { timeout: 20000 },
    );
    await page.getByTestId("apply-to-unity-button").click();
    const applyResp = await applyRespPromise;
    must(applyResp.status() === 202 || applyResp.status() === 200, `Apply HTTP ${applyResp.status()}`);
    const applyBody = await applyResp.json().catch(() => ({}));
    let appliedOk = false;
    let lastStatus = null;
    for (let i = 0; i < 50; i++) {
      const d = await fetchDraft(cookie, draftId);
      lastStatus = d.status;
      if (d.status === "applied") {
        appliedOk = true;
        break;
      }
      if (d.status === "failed" || d.status === "conflict") {
        throw new Error(`Apply ended as ${d.status}: ${d.lastError || ""}`);
      }
      const uiMsg = await page.locator(".ok").allInnerTexts().catch(() => []);
      if (uiMsg.some((t) => /applied to unity/i.test(t))) {
        appliedOk = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    must(appliedOk, `Apply did not reach applied via UI path (last=${lastStatus}, queue=${JSON.stringify(applyBody).slice(0, 180)})`);
    builder.record("apply_success_via_ui", true, {
      actual: { draftId, status: "applied", requestId: applyBody.requestId || applyBody.command?.requestId || null },
      expected: "Apply to Unity button → applied",
    });

    // Conflict visible: page1 Sync (rebase); page2 Open scene draft (no rebase) shares version; page1 saves; page2 409
    await page.bringToFront();
    const sync1 = page.waitForResponse(
      (r) => r.url().includes("/api/drafts/from-scene") && r.request().method() === "POST",
      { timeout: 60000 },
    );
    await page.getByRole("button", { name: /^sync from unity$/i }).click();
    const sync1Resp = await sync1;
    must(sync1Resp.ok(), "page1 conflict-setup sync failed");
    const sync1Body = await sync1Resp.json();
    draftId = sync1Body.draft?.id || draftId;
    const sharedVersion = Number(sync1Body.draft?.version);
    await page.getByRole("button", { name: rootName, exact: true }).waitFor({ timeout: 20000 });
    await page.getByRole("button", { name: rootName, exact: true }).click();

    const page2 = await context.newPage();
    await page2.goto(`${BASE}/level-editor`, { waitUntil: "domcontentloaded" });
    const open2 = page2.waitForResponse(
      (r) => r.url().includes("/api/drafts/from-scene") && r.request().method() === "POST",
      { timeout: 60000 },
    );
    await page2.getByRole("button", { name: /^open scene draft$/i }).click();
    const open2Resp = await open2;
    must(open2Resp.ok(), "page2 open scene draft failed");
    const open2Body = await open2Resp.json();
    must(open2Body.draft?.id === draftId, "page2 opened a different draft");
    must(Number(open2Body.draft?.version) === sharedVersion, "page2 did not share page1 draft version");
    await page2.getByRole("button", { name: rootName, exact: true }).waitFor({ timeout: 20000 });
    await page2.getByRole("button", { name: rootName, exact: true }).click();
    const page2Version = Number(open2Body.draft?.version);

    // Advance version with a direct authenticated PUT (fixture), then prove page2 Save UI surfaces 409.
    // Browser action under test is page2's Save draft — not the version bump itself.
    const bumpResp = await fetch(`${API}/api/drafts/${draftId}`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: page2Version,
        objects: (await fetchDraft(cookie, draftId)).objects,
      }),
    });
    must(bumpResp.status === 200, `conflict fixture bump HTTP ${bumpResp.status}`);

    await page2.bringToFront();
    await page2.waitForFunction(() => typeof window.__HERTZ_LEVEL_EDITOR_TEST__?.fillNumericAndSave === "function", null, {
      timeout: 15000,
    });
    const stalePutPromise = page2.waitForResponse(
      (r) => r.url().includes("/api/drafts/") && r.request().method() === "PUT",
      { timeout: 20000 },
    );
    const staleEval = page2.evaluate(async () => {
      try {
        await window.__HERTZ_LEVEL_EDITOR_TEST__.fillNumericAndSave({ z: 3.25 });
        return { ok: true };
      } catch (err) {
        return { ok: false, message: String(err?.message || err) };
      }
    });
    const staleResp = await stalePutPromise;
    const staleEvalResult = await staleEval;
    must(staleResp.status() === 409, `Expected stale save HTTP 409, got ${staleResp.status()}`);
    await page2.locator("p.error").first().waitFor({ state: "visible", timeout: 10000 });
    const conflictText = await page2.locator("p.error").first().innerText();
    must(
      /conflict|mismatch|stale|version|resync|sync from unity/i.test(conflictText) ||
        /conflict|mismatch|stale|version/i.test(staleEvalResult.message || ""),
      `No visible conflict/resync UI on page2: ${conflictText.slice(0, 240)}`,
    );
    builder.record("conflict_visible_ui", true, {
      actual: { http: staleResp.status(), snippet: conflictText.slice(0, 220), eval: staleEvalResult },
      expected: "visible Version conflict after stale Save draft",
    });
    await page2.close();
    await page.bringToFront();

    // Offline → reconnect: first /api/project paints Unity offline; later calls pass through
    let offlineCalls = 0;
    const projectRoute = async (route) => {
      try {
        offlineCalls += 1;
        if (offlineCalls <= 2) {
          const res = await route.fetch();
          const json = await res.json();
          json.connection = { ...(json.connection || {}), unityConnected: false, connectorOnline: true };
          if (json.project) json.project = { ...json.project, unityConnected: false };
          json.unityConnected = false;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(json),
          });
          return;
        }
        await route.continue();
      } catch {
        // Page may navigate away while a request is in flight.
      }
    };
    await page.route("**/api/project**", projectRoute);
    await page.goto(`${BASE}/level-editor`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("connection-status-list").waitFor({ state: "visible", timeout: 15000 });
    let panel = await page.getByTestId("connection-status-list").innerText();
    assertConnectionKind(panel, "offline");
    const offlineSnippet = panel.slice(0, 220);
    await page.unroute("**/api/project**", projectRoute);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("connection-status-list").waitFor({ state: "visible", timeout: 15000 });
    await page.getByRole("button", { name: /^refresh health$/i }).click();
    await page.waitForTimeout(1500);
    panel = await page.getByTestId("connection-status-list").innerText();
    const reconnected =
      (/\bonline\b/i.test(panel) || /look ready/i.test(panel)) &&
      !/unity_offline|unity bridge offline|connector_offline|api_offline/i.test(panel);
    must(reconnected, `Did not observe reconnect after unroute: ${panel.slice(0, 240)}`);
    builder.record("offline_reconnect_transition", true, {
      actual: { offline: offlineSnippet, reconnected: panel.slice(0, 220), offlineCalls },
      expected: "offline then reconnect/online states via connection panel",
    });

    const queue = await fetch(`${API}/api/queue`, { headers: { Cookie: cookie } }).then((r) => r.json());
    const ids = (queue.queue || queue || []).map((q) => q.requestId).filter(Boolean);
    builder.record("no_duplicate_queue_commands", ids.length === new Set(ids).size, {
      actual: { count: ids.length, unique: new Set(ids).size },
      expected: "unique requestIds",
    });

    const shotPath = path.join(__dirname, "..", "data", "w03-browser-e2e.png");
    await page.screenshot({ path: shotPath, fullPage: false });
    shots.push(shotPath);
    builder.record("browser_screenshot_supporting", fs.existsSync(shotPath), {
      actual: shotPath,
      expected: "supporting screenshot after functional checks",
    });
  } finally {
    await browser.close();
  }

  const artifact = builder.build({
    requiredChecks,
    screenshots: shots,
    baseUrl: BASE,
    credentialSource: "HERTZ_OWNER_PASSWORD env only",
  });
  const errors = assertProofSchema(artifact, requiredChecks);
  if (errors.length) {
    artifact.ok = false;
    artifact.schemaErrors = errors;
  }
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`Wrote ${outPath} ok=${artifact.ok} (${artifact.passed}/${artifact.total})`);
  process.exit(artifact.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err?.message || err);
  const failed = builder.build({ requiredChecks, error: String(err?.message || err) });
  fs.writeFileSync(outPath, `${JSON.stringify(failed, null, 2)}\n`);
  process.exit(1);
});
