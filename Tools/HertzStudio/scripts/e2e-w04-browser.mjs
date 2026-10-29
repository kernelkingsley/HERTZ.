/**
 * Authenticated W04 Weapons UI E2E — fail-closed.
 * Creates a uniquely named weapon, syncs live, verifies Unity resolve, then always cleans up by ID.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createProofBuilder, assertProofSchema } from "./lib/proof-schema.mjs";
import { acceptWeaponSyncEvidence } from "./lib/weapon-sync-acceptance.mjs";
import {
  cleanupE2eWeaponById,
  combineE2eAndCleanupErrors,
  makeE2eWeaponName,
} from "./lib/weapon-e2e-cleanup.mjs";
import { getMilestoneStatus } from "../shared/milestoneStatus.mjs";

const PASSWORD = process.env.HERTZ_OWNER_PASSWORD;
const BASE = process.env.HERTZ_STUDIO_URL || "http://127.0.0.1:8787";
const BRIDGE = process.env.HERTZ_UNITY_BRIDGE_URL || "http://127.0.0.1:8791";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const outPath = path.join(root, "data", "w04-browser-e2e-proof.json");

if (!PASSWORD) {
  console.error("HERTZ_OWNER_PASSWORD is required for W04 browser E2E.");
  process.exit(2);
}

const builder = createProofBuilder({
  proof: "w04-browser-e2e",
  runner: "e2e-w04-browser",
  runnerVersion: "4",
  command: "node scripts/e2e-w04-browser.mjs",
});

const requiredChecks = [
  "playwright_available",
  "browser_login",
  "dashboard_w03_completed",
  "dashboard_w04_status_shared",
  "weapons_page_loaded",
  "frequency_flip_displayed",
  "model_picker_present",
  "placeholder_note_visible",
  "save_weapon",
  "sync_applied_live",
  "sync_guid_path_present",
  "sync_hash_version_match",
  "sync_unity_resolve_ok",
  "disconnected_not_accepted_as_success",
  "milestone_badge_shared",
  "e2e_weapon_cleanup_complete",
];

function must(cond, msg) {
  if (!cond) throw new Error(msg);
}

function loadBridgeToken() {
  const cfgPath = path.join(root, "data", "connector-config.json");
  if (!fs.existsSync(cfgPath)) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    return cfg.bridgeToken || null;
  } catch {
    return null;
  }
}

async function resolveUnityWeapon({ assetGuid, assetPath, weaponId }) {
  const token = loadBridgeToken();
  if (!token) return { ok: false, disconnected: true, error: "no bridge token" };
  try {
    const res = await fetch(`${BRIDGE}/weapons/resolve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hertz-bridge-token": token,
      },
      body: JSON.stringify({ assetGuid, assetPath, weaponId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        exists: data.exists === true,
        assetType: data.assetType,
        weaponId: data.weaponId,
        error: data.error || `HTTP ${res.status}`,
      };
    }
    return {
      ok: true,
      exists: true,
      assetType: data.assetType,
      weaponId: data.weaponId,
      studioVersion: data.studioVersion,
      studioPayloadHash: data.studioPayloadHash,
    };
  } catch (err) {
    return { ok: false, disconnected: true, error: String(err?.message || err) };
  }
}

function makeApiFetch(cookieHeader) {
  return async (apiPath, opts = {}) => {
    const headers = {
      ...(opts.headers || {}),
      cookie: cookieHeader,
    };
    if (opts.body && !headers["content-type"]) {
      headers["content-type"] = "application/json";
    }
    return fetch(`${BASE}${apiPath}`, { ...opts, headers });
  };
}

async function main() {
  let playwright;
  try {
    playwright = await import("playwright");
  } catch {
    builder.record("playwright_available", false, { actual: "missing", expected: "playwright" });
    fs.writeFileSync(outPath, `${JSON.stringify(builder.build({ requiredChecks }), null, 2)}\n`);
    process.exit(1);
  }
  builder.record("playwright_available", true, { actual: "loaded", expected: "playwright" });

  const disconnectedReject = acceptWeaponSyncEvidence({
    queued: { version: 1, payloadHash: "x", weaponId: "neg" },
    sync: { state: "disconnected" },
    unity: {
      ok: true,
      exists: true,
      assetType: "HertzWeaponDefinition",
      weaponId: "neg",
      studioVersion: 1,
      studioPayloadHash: "x",
    },
  });
  builder.record(
    "disconnected_not_accepted_as_success",
    !disconnectedReject.ok && disconnectedReject.reasons.includes("disconnected"),
    {
      actual: disconnectedReject,
      expected: "helper rejects disconnected independently",
    },
  );

  const runId = randomUUID().slice(0, 8);
  const e2eName = makeE2eWeaponName(runId);
  let createdWeaponId = null;
  let cookieHeader = "";
  let primaryError = null;
  let cleanupResult = { ok: true, error: null, proof: null };

  const { chromium } = playwright;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    try {
      await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
      await page.locator("#user, input[autocomplete='username']").first().fill("kingsley");
      await page.locator("#pass, input[type='password']").first().fill(PASSWORD);
      await page.getByRole("button", { name: /enter studio|create owner/i }).click();
      await page.getByRole("button", { name: /sign out/i }).waitFor({ state: "visible" });
      builder.record("browser_login", true, { actual: "sign out visible", expected: "authenticated" });
      const cookies = await page.context().cookies();
      cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

      await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
      const milestonesJson = await page.evaluate(async () => {
        const res = await fetch("/api/milestones", { credentials: "same-origin" });
        if (!res.ok) throw new Error(`milestones HTTP ${res.status}`);
        return res.json();
      });
      const w03Gates = milestonesJson?.gates?.W03 || {};
      must(
        w03Gates.tasksComplete && w03Gates.codexReview && w03Gates.kingsleyTesting,
        `API W03 gates not Completed: ${JSON.stringify(w03Gates)}`,
      );
      await page.getByTestId("editor-status-W03").waitFor({ state: "visible", timeout: 20000 });
      await page.waitForFunction(() => {
        const el = document.querySelector('[data-testid="editor-status-W03"]');
        return el && /completed/i.test(el.textContent || "");
      }, null, { timeout: 20000 });
      const w03 = (await page.getByTestId("editor-status-W03").innerText()).trim();
      must(/completed/i.test(w03), `W03 not Completed: ${w03}`);
      builder.record("dashboard_w03_completed", true, { actual: w03, expected: "Completed" });

      await page.waitForFunction(() => {
        const el = document.querySelector('[data-testid="editor-status-W04"]');
        return el && /in progress|ready for codex|ready for kingsley/i.test(el.textContent || "");
      }, null, { timeout: 20000 });
      const w04 = (await page.getByTestId("editor-status-W04").innerText()).trim();
      const shared = getMilestoneStatus("W04");
      must(
        w04 === shared ||
          w04.toLowerCase().includes(shared.toLowerCase().slice(0, 8)) ||
          (/ready for kingsley/i.test(w04) && /ready for kingsley/i.test(shared)),
        `W04 UI ${w04} != ${shared}`,
      );
      builder.record("dashboard_w04_status_shared", true, { actual: { ui: w04, shared }, expected: shared });

      await page.goto(`${BASE}/weapons`, { waitUntil: "domcontentloaded" });
      await page.getByTestId("weapons-page").waitFor({ state: "visible", timeout: 20000 });
      builder.record("weapons_page_loaded", true, { actual: "visible", expected: "weapons-page" });

      const freq = await page.getByTestId("frequency-flip-required").innerText();
      must(/yes/i.test(freq), `frequency flip not Yes: ${freq}`);
      builder.record("frequency_flip_displayed", true, { actual: freq, expected: "Yes" });

      await page.getByTestId("model-picker").waitFor({ state: "visible" });
      builder.record("model_picker_present", true, { actual: "visible", expected: "model-picker" });

      const note = await page.getByTestId("placeholder-content-note").innerText();
      must(/PLACEHOLDER|placeholder|Sound section/i.test(note), `placeholder note weak: ${note}`);
      builder.record("placeholder_note_visible", true, {
        actual: note.slice(0, 120),
        expected: "placeholder+sound note",
      });

      const createPromise = page.waitForResponse(
        (r) =>
          r.url().includes("/api/weapons") &&
          !r.url().includes("/sync") &&
          !r.url().includes("/models") &&
          r.request().method() === "POST",
        { timeout: 20000 },
      );
      await page.getByTestId("weapon-name").fill(e2eName);
      await page.getByTestId("weapon-role").selectOption("left_pistol");
      await page.getByTestId("weapon-damage").fill("11");
      await page.getByTestId("weapon-save").click();
      const createResp = await createPromise;
      must(createResp.ok(), `create HTTP ${createResp.status()}`);
      const created = await createResp.json();
      createdWeaponId = created.id;
      must(createdWeaponId, "create response missing weapon id");
      await page.getByTestId("weapons-message").waitFor({ state: "visible", timeout: 15000 });
      const msg = await page.getByTestId("weapons-message").innerText();
      must(/saved/i.test(msg) && /auto-equip|frequency/i.test(msg), `save message weak: ${msg}`);
      builder.record("save_weapon", true, {
        actual: { message: msg.slice(0, 120), weaponId: createdWeaponId, name: e2eName },
        expected: "Saved unique E2E weapon by id",
      });

      await page.locator(`[data-weapon-id="${createdWeaponId}"]`).click();
      await page.getByTestId("weapon-sync").waitFor({ state: "visible" });
      must(!(await page.getByTestId("weapon-sync").isDisabled()), "Sync disabled — no selection");

      const syncPromise = page.waitForResponse(
        (r) =>
          r.url().includes(`/api/weapons/${createdWeaponId}/sync`) &&
          r.request().method() === "POST",
        { timeout: 20000 },
      );
      await page.getByTestId("weapon-sync").click();
      const syncResp = await syncPromise;
      must(
        syncResp.ok() || syncResp.status() === 202 || syncResp.status() === 200,
        `sync HTTP ${syncResp.status()}`,
      );
      const syncBody = await syncResp.json();
      const queued = {
        version: syncBody.job?.weaponVersion ?? syncBody.weapon?.version,
        payloadHash: syncBody.job?.payloadHash ?? syncBody.weapon?.payloadHash,
        weaponId: syncBody.job?.weaponId ?? syncBody.weapon?.id ?? createdWeaponId,
      };
      must(queued.version != null && queued.payloadHash, "sync response missing queued version/hash");
      must(queued.weaponId === createdWeaponId, "sync weaponId mismatch vs created id");

      let weapon = syncBody.weapon;
      let accepted = { ok: false, reasons: ["not_polled"] };
      let unity = null;
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        await refreshWeaponById(page, createdWeaponId);
        const apiWeapon = await fetch(`${BASE}/api/weapons/${createdWeaponId}`, {
          headers: { cookie: cookieHeader },
        }).then((r) => (r.ok ? r.json() : null));
        if (apiWeapon?.id) weapon = apiWeapon;
        const sync = weapon?.unitySync || {};
        if (sync.state === "applied" && sync.assetGuid && sync.assetPath) {
          unity = await resolveUnityWeapon({
            assetGuid: sync.assetGuid,
            assetPath: sync.assetPath,
            weaponId: createdWeaponId,
          });
          accepted = acceptWeaponSyncEvidence({ queued, sync, unity });
          if (accepted.ok) break;
        }
        await page.waitForTimeout(2000);
      }

      const syncText = (await page.getByTestId("unity-sync-status").innerText()).trim();
      const guidText = (await page.getByTestId("unity-asset-guid").count())
        ? (await page.getByTestId("unity-asset-guid").innerText()).trim()
        : "";
      const pathText = (await page.getByTestId("unity-asset-path").count())
        ? (await page.getByTestId("unity-asset-path").innerText()).trim()
        : "";

      must(accepted.ok, `sync evidence rejected: ${accepted.reasons.join(",")} last=${syncText}`);
      builder.record("sync_applied_live", true, {
        actual: { state: weapon?.unitySync?.state, ui: syncText.slice(0, 160), weaponId: createdWeaponId },
        expected: "applied + helper ok",
      });
      builder.record("sync_guid_path_present", true, {
        actual: {
          guid: guidText || weapon?.unitySync?.assetGuid,
          path: pathText || weapon?.unitySync?.assetPath,
        },
        expected: "non-empty Unity-authored GUID + Assets/ path",
      });
      builder.record("sync_hash_version_match", true, {
        actual: {
          queued,
          observedVersion: weapon?.unitySync?.observedVersion,
          observedPayloadHash:
            weapon?.unitySync?.observedPayloadHash || weapon?.unitySync?.payloadHash,
        },
        expected: "observedVersion/hash exactly equal queued",
      });
      builder.record("sync_unity_resolve_ok", true, {
        actual: { type: unity?.assetType, weaponId: unity?.weaponId },
        expected: "HertzWeaponDefinition exists with matching WeaponId/version/hash",
      });

      const badge = (await page.getByTestId("weapons-milestone-badge").innerText()).trim();
      must(
        badge === shared ||
          badge.includes(shared.slice(0, 8)) ||
          (/ready for kingsley/i.test(badge) && /ready for kingsley/i.test(shared)),
        `badge ${badge} != ${shared}`,
      );
      builder.record("milestone_badge_shared", true, { actual: badge, expected: shared });
    } catch (err) {
      primaryError = String(err?.message || err);
      throw err;
    } finally {
      if (createdWeaponId && cookieHeader) {
        cleanupResult = await cleanupE2eWeaponById({
          weaponId: createdWeaponId,
          apiFetch: makeApiFetch(cookieHeader),
          resolveUnityAsset: resolveUnityWeapon,
          timeoutMs: 90000,
          pollMs: 1500,
        });
        builder.record("e2e_weapon_cleanup_complete", cleanupResult.ok === true, {
          actual: {
            weaponId: createdWeaponId,
            proof: cleanupResult.proof,
            error: cleanupResult.error || null,
          },
          expected: "catalog+mapping+Unity definition gone; no active jobs; no retain_unity",
        });
      } else {
        builder.record("e2e_weapon_cleanup_complete", true, {
          actual: "no weapon created",
          expected: "noop cleanup",
        });
      }
      await browser.close();
    }
  } catch (err) {
    primaryError = primaryError || String(err?.message || err);
  }

  if (primaryError || !cleanupResult.ok) {
    const combined = combineE2eAndCleanupErrors(
      primaryError,
      cleanupResult.ok ? null : cleanupResult.error,
    );
    if (combined) console.error(combined);
  }

  const artifact = builder.build({ requiredChecks, baseUrl: BASE });
  if (primaryError || !cleanupResult.ok) artifact.ok = false;
  const errors = assertProofSchema(artifact, requiredChecks);
  if (errors.length) {
    artifact.ok = false;
    artifact.schemaErrors = errors;
  }
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`Wrote ${outPath} ok=${artifact.ok} (${artifact.passed}/${artifact.total})`);
  process.exit(artifact.ok ? 0 : 1);
}

async function refreshWeaponById(page, weaponId) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("weapons-page").waitFor({ state: "visible", timeout: 15000 });
  const row = page.locator(`[data-weapon-id="${weaponId}"]`);
  await row.waitFor({ state: "visible", timeout: 20000 });
  await row.click();
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="unity-sync-status"]');
    return el && !/\bnone\b/i.test(el.textContent || "");
  }, null, { timeout: 10000 });
}

main().catch((err) => {
  console.error(err?.message || err);
  const failed = builder.build({ requiredChecks, error: String(err?.message || err) });
  fs.writeFileSync(outPath, `${JSON.stringify(failed, null, 2)}\n`);
  process.exit(1);
});
