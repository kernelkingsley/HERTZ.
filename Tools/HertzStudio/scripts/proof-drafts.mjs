/**
 * W01 proof: durable drafts + paired-connector Unity apply/undo/save/reopen.
 * Unity integration requires connector-config + bridge token + Editor bridge.
 * Mutating Unity steps refuse any scene other than HertzStudioTest.
 * Unavailable Unity checks are marked pending; report.ok is true only when API
 * checks pass and Unity integration either passed or was not attempted because
 * REQUIRE_UNITY=0 (default requires Unity when bridge health responds).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.HERTZ_API_URL || "http://127.0.0.1:8787";
const BRIDGE = process.env.HERTZ_UNITY_BRIDGE_URL || "http://127.0.0.1:8791";
const REQUIRE_UNITY = process.env.REQUIRE_UNITY !== "0";
const ALLOWED_SCENE = "Assets/Scenes/HertzStudioTest.unity";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const reportPath = path.join(root, "data/w01-proof-report.json");
const configPath = path.join(root, "data/connector-config.json");

async function req(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function nearlyEqual(a, b, eps = 1e-4) {
  return Math.abs(Number(a) - Number(b)) <= eps;
}

function assertPosition(actual, expected, label) {
  assert(actual, `${label}: missing position`);
  assert(
    nearlyEqual(actual.x, expected.x) &&
      nearlyEqual(actual.y, expected.y) &&
      nearlyEqual(actual.z, expected.z),
    `${label}: expected (${expected.x},${expected.y},${expected.z}) got (${actual.x},${actual.y},${actual.z})`,
  );
}

function loadConnectorConfig() {
  if (!fs.existsSync(configPath)) return null;
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function guardTestScene(scenePath, context) {
  const normalized = String(scenePath || "").replaceAll("\\", "/");
  assert(
    normalized === ALLOWED_SCENE,
    `Refusing Unity mutation: active scene must be ${ALLOWED_SCENE} (got ${scenePath || "none"}). ${context}`,
  );
}

const report = {
  startedAt: new Date().toISOString(),
  steps: [],
  apiOk: false,
  unityIntegration: "pending",
  ok: false,
};

function step(name, detail = {}) {
  report.steps.push({ name, ...detail, at: new Date().toISOString() });
  console.log(`✓ ${name}`);
}

try {
  if (!process.env.HERTZ_OWNER_PASSWORD) {
    throw new Error("Set HERTZ_OWNER_PASSWORD — no default owner password is allowed.");
  }
  const login = await req(`${API}/api/auth/login`, {
    method: "POST",
    body: JSON.stringify({
      username: "kingsley",
      password: process.env.HERTZ_OWNER_PASSWORD,
    }),
  });
  assert(login.response.ok, login.data.error || "login failed");
  const cookie = login.response.headers.get("set-cookie")?.split(";")[0];
  assert(cookie, "missing session cookie");

  const health = await req(`${BRIDGE}/health`);
  const bridgeUp = health.response.ok;
  const config = loadConnectorConfig();

  // API durability with fixture if needed
  let objects = [
    { objectId: "HertzProbe", name: "HertzProbe", position: { x: 0, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
  ];
  let scenePath = ALLOWED_SCENE;
  let unityRevision = 0;
  /** @type {Map<string, {x:number,y:number,z:number}>} */
  const originalPositions = new Map();

  if (bridgeUp && config?.bridgeToken) {
    const exported = await req(`${BRIDGE}/scene/export`, {
      headers: { "x-hertz-bridge-token": config.bridgeToken },
    });
    assert(exported.response.ok, exported.data.error || "authenticated export failed");
    // Guard before any mutating API/queue work that could reach Unity.
    guardTestScene(exported.data.scenePath, "Open HertzStudioTest before running proof:drafts.");
    objects = exported.data.objects;
    scenePath = exported.data.scenePath;
    unityRevision = exported.data.unityRevision;
    for (const obj of objects) {
      originalPositions.set(obj.objectId, {
        x: obj.position?.x ?? 0,
        y: obj.position?.y ?? 0,
        z: obj.position?.z ?? 0,
      });
    }
    step("export_scene_authenticated", {
      unityRevision,
      objects: objects.length,
      scenePath,
    });
  } else {
    step("export_scene_fixture", { note: "Using fixture objects for API durability." });
  }

  const created = await req(`${API}/api/drafts`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: JSON.stringify({
      title: "W01 proof draft",
      scenePath,
      objects,
      unityRevision,
    }),
  });
  assert(created.response.ok, created.data.error || "create draft failed");
  const draftId = created.data.id;
  step("draft_created", { draftId, version: created.data.version });

  const moved = structuredClone(created.data.objects);
  const targetObjectId = moved[0].objectId;
  assert(targetObjectId, "draft missing objectId");
  moved[0].position = {
    x: (moved[0].position?.x || 0) + 1.25,
    y: moved[0].position?.y || 1,
    z: moved[0].position?.z || 0,
  };
  const saved = await req(`${API}/api/drafts/${draftId}`, {
    method: "PUT",
    headers: { Cookie: cookie },
    body: JSON.stringify({ expectedVersion: created.data.version, objects: moved }),
  });
  assert(saved.response.ok, saved.data.error || "draft save failed");
  step("draft_saved_offline", { version: saved.data.version, position: moved[0].position });

  // Save a newer draft version (no live-queue synthetic ack — that race lives only in regress:w01).
  const newer = structuredClone(moved);
  newer[0].position.x += 5;
  const saved2 = await req(`${API}/api/drafts/${draftId}`, {
    method: "PUT",
    headers: { Cookie: cookie },
    body: JSON.stringify({ expectedVersion: saved.data.version, objects: newer }),
  });
  assert(saved2.response.ok, saved2.data.error || "newer draft save failed");
  step("draft_saved_newer_version", { version: saved2.data.version, position: newer[0].position });

  // R8: stale expectedDraftVersion must 409 before queueing
  const staleApply = await req(`${API}/api/drafts/${draftId}/apply`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: JSON.stringify({
      requestId: `proof-stale-ver-${Date.now()}`,
      expectedDraftVersion: saved.data.version,
    }),
  });
  assert(staleApply.response.status === 409, "expectedDraftVersion mismatch must return 409");
  step("expected_draft_version_mismatch_409", { error: staleApply.data.error });

  // Reject invalid transforms at the API boundary (finding 3 / R2).
  const badSave = await req(`${API}/api/drafts/${draftId}`, {
    method: "PUT",
    headers: { Cookie: cookie },
    body: JSON.stringify({
      expectedVersion: saved2.data.version,
      objects: [{ objectId: targetObjectId, position: { x: "oops", y: 1, z: 0 } }],
    }),
  });
  assert(badSave.response.status === 400, "non-numeric position must be rejected by API");
  step("api_rejects_non_numeric_position", { error: badSave.data.error });

  if (!config?.connectorToken) {
    report.apiOk = true;
    report.unityIntegration = "pending";
    report.ok = false;
    step("unity_pending_no_connector", {
      note: "Pair connector for full Unity proof. API durability checks passed.",
    });
  } else if (!bridgeUp) {
    report.apiOk = true;
    report.unityIntegration = "pending";
    report.ok = false;
    step("unity_pending_bridge_offline");
  } else {
    guardTestScene(scenePath, "Unity integration branch.");

    const draftNow = await req(`${API}/api/drafts/${draftId}`, { headers: { Cookie: cookie } });
    assert(draftNow.data.objects[0].position.x === newer[0].position.x, "draft objects drifted before apply");

    const applyReq = `proof-apply-${Date.now()}`;
    const apply = await req(`${API}/api/drafts/${draftId}/apply`, {
      method: "POST",
      headers: { Cookie: cookie },
      body: JSON.stringify({
        requestId: applyReq,
        expectedDraftVersion: draftNow.data.version,
      }),
    });
    assert(apply.response.status === 202 || apply.response.ok, apply.data.error || "apply queue failed");
    const dup = await req(`${API}/api/drafts/${draftId}/apply`, {
      method: "POST",
      headers: { Cookie: cookie },
      body: JSON.stringify({
        requestId: applyReq,
        expectedDraftVersion: draftNow.data.version,
      }),
    });
    assert(dup.data.deduplicated === true, "duplicate apply not deduped");
    step("duplicate_delivery_deduped", { requestId: applyReq });

    let terminal = null;
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      const queue = await req(`${API}/api/queue`, { headers: { Cookie: cookie } });
      const item = queue.data.find((q) => q.requestId === applyReq);
      if (item && ["applied", "failed", "conflict"].includes(item.status)) {
        terminal = item;
        break;
      }
    }
    assert(terminal, "connector did not acknowledge apply in time — is npm run start -w connector running?");
    assert(terminal.status === "applied", `apply did not succeed (status=${terminal.status}): ${terminal.error || ""}`);
    step("unity_apply_via_connector", { status: terminal.status, message: terminal.message || null });

    // Verify exact transform via export (R7) — stable object identity, no fallback.
    const afterApply = await req(`${BRIDGE}/scene/export`, {
      headers: { "x-hertz-bridge-token": config.bridgeToken },
    });
    assert(afterApply.response.ok, "export after apply failed");
    guardTestScene(afterApply.data.scenePath, "post-apply export");
    const probe = afterApply.data.objects.find((o) => o.objectId === targetObjectId);
    assert(probe, `probe ${targetObjectId} missing after apply`);
    assertPosition(probe.position, newer[0].position, "post-apply transform");
    step("unity_transform_verified", {
      objectId: targetObjectId,
      position: probe.position,
      expected: newer[0].position,
    });

    const preUndoPos = originalPositions.get(targetObjectId) || {
      x: (moved[0].position.x || 0) - 1.25,
      y: moved[0].position.y,
      z: moved[0].position.z,
    };

    const undo = await req(`${BRIDGE}/scene/undo`, {
      method: "POST",
      headers: { "x-hertz-bridge-token": config.bridgeToken },
      body: JSON.stringify({ requestId: `proof-undo-${Date.now()}` }),
    });
    assert(undo.response.ok && undo.data.status === "applied", undo.data.error || "undo failed");
    const afterUndo = await req(`${BRIDGE}/scene/export`, {
      headers: { "x-hertz-bridge-token": config.bridgeToken },
    });
    assert(afterUndo.response.ok, "export after undo failed");
    const undone = afterUndo.data.objects.find((o) => o.objectId === targetObjectId);
    assert(undone, `probe ${targetObjectId} missing after undo`);
    assertPosition(undone.position, preUndoPos, "post-undo transform");
    step("unity_undo", { unityRevision: undo.data.unityRevision, position: undone.position });

    const save = await req(`${BRIDGE}/scene/save`, {
      method: "POST",
      headers: { "x-hertz-bridge-token": config.bridgeToken },
      body: JSON.stringify({ requestId: `proof-save-${Date.now()}`, scenePath }),
    });
    assert(save.response.ok && save.data.status === "applied", save.data.error || "save failed");
    step("unity_save", { unityRevision: save.data.unityRevision });

    const reopen = await req(`${BRIDGE}/scene/reopen`, {
      method: "POST",
      headers: { "x-hertz-bridge-token": config.bridgeToken },
      body: JSON.stringify({ scenePath }),
    });
    assert(
      reopen.response.ok && reopen.data.status === "applied",
      reopen.data.error ||
        (reopen.response.status === 404
          ? "reopen route missing — Unity must recompile Assets/Editor/HertzStudio/HertzStudioHttpBridge.cs"
          : "reopen failed"),
    );
    const afterReopen = await req(`${BRIDGE}/scene/export`, {
      headers: { "x-hertz-bridge-token": config.bridgeToken },
    });
    assert(afterReopen.response.ok, "export after reopen failed");
    guardTestScene(afterReopen.data.scenePath, "post-reopen export");
    const reopened = afterReopen.data.objects.find((o) => o.objectId === targetObjectId);
    assert(reopened, `probe ${targetObjectId} missing after reopen`);
    assertPosition(reopened.position, preUndoPos, "post-reopen persisted transform");
    step("unity_reopen", {
      unityRevision: reopen.data.unityRevision,
      position: reopened.position,
    });

    const unauthorized = await req(`${BRIDGE}/scene/apply`, {
      method: "POST",
      body: JSON.stringify({
        requestId: `proof-unauth-${Date.now()}`,
        baseUnityRevision: reopen.data.unityRevision,
        scenePath,
        edits: [{ objectId: targetObjectId, position: { x: 99, y: 99, z: 99 } }],
      }),
    });
    assert(unauthorized.response.status === 401, "unauthenticated mutate must be rejected");
    step("bridge_rejects_unauthenticated_mutate");

    const conflict = await req(`${BRIDGE}/scene/apply`, {
      method: "POST",
      headers: { "x-hertz-bridge-token": config.bridgeToken },
      body: JSON.stringify({
        requestId: `proof-conflict-${Date.now()}`,
        baseUnityRevision: -1,
        scenePath,
        edits: [{ objectId: targetObjectId, position: newer[0].position }],
      }),
    });
    assert(conflict.response.status === 409 && conflict.data.status === "conflict", "expected stale revision conflict");
    step("stale_revision_conflict", { message: conflict.data.message });

    // R6: Lost-ack retry uses live Unity revision after undo/save/reopen, not stale draft base.
    const liveAfterOps = await req(`${BRIDGE}/health`);
    assert(liveAfterOps.response.ok, "health after undo/save/reopen failed");
    const retryBase = liveAfterOps.data.unityRevision;
    assert(typeof retryBase === "number", "live unityRevision missing for lost-ack retry");
    const retryPos = { x: 2, y: 1, z: 0 };
    const retryId = `proof-retry-${Date.now()}`;
    const first = await req(`${BRIDGE}/scene/apply`, {
      method: "POST",
      headers: { "x-hertz-bridge-token": config.bridgeToken },
      body: JSON.stringify({
        requestId: retryId,
        baseUnityRevision: retryBase,
        scenePath,
        edits: [{ objectId: targetObjectId, position: retryPos }],
      }),
    });
    assert(first.response.ok && first.data.status === "applied", first.data.error || "retry first apply failed");
    const afterFirstRetry = await req(`${BRIDGE}/scene/export`, {
      headers: { "x-hertz-bridge-token": config.bridgeToken },
    });
    const firstProbe = afterFirstRetry.data.objects.find((o) => o.objectId === targetObjectId);
    assertPosition(firstProbe?.position, retryPos, "lost-ack first apply transform");

    const second = await req(`${BRIDGE}/scene/apply`, {
      method: "POST",
      headers: { "x-hertz-bridge-token": config.bridgeToken },
      body: JSON.stringify({
        requestId: retryId,
        baseUnityRevision: retryBase,
        scenePath,
        edits: [{ objectId: targetObjectId, position: retryPos }],
      }),
    });
    assert(second.response.ok && second.data.status === "applied", "lost-ack retry must return original success");
    assert(
      second.data.deduplicated === true || second.data.unityRevision === first.data.unityRevision,
      "retry mutated twice",
    );
    step("lost_ack_retry_idempotent", {
      unityRevision: second.data.unityRevision,
      baseUsed: retryBase,
    });

    // Restore original probe position for a clean test scene.
    const restoreBaseHealth = await req(`${BRIDGE}/health`);
    const restore = await req(`${BRIDGE}/scene/apply`, {
      method: "POST",
      headers: { "x-hertz-bridge-token": config.bridgeToken },
      body: JSON.stringify({
        requestId: `proof-restore-${Date.now()}`,
        baseUnityRevision: restoreBaseHealth.data.unityRevision,
        scenePath,
        edits: [{ objectId: targetObjectId, position: preUndoPos }],
      }),
    });
    assert(restore.response.ok && restore.data.status === "applied", restore.data.error || "restore failed");
    const saveRestore = await req(`${BRIDGE}/scene/save`, {
      method: "POST",
      headers: { "x-hertz-bridge-token": config.bridgeToken },
      body: JSON.stringify({ requestId: `proof-restore-save-${Date.now()}`, scenePath }),
    });
    assert(saveRestore.response.ok && saveRestore.data.status === "applied", "restore save failed");

    const reopenRestore = await req(`${BRIDGE}/scene/reopen`, {
      method: "POST",
      headers: { "x-hertz-bridge-token": config.bridgeToken },
      body: JSON.stringify({ scenePath }),
    });
    assert(
      reopenRestore.response.ok && reopenRestore.data.status === "applied",
      reopenRestore.data.error || "restore reopen failed",
    );
    const afterRestore = await req(`${BRIDGE}/scene/export`, {
      headers: { "x-hertz-bridge-token": config.bridgeToken },
    });
    assert(afterRestore.response.ok, "export after restore failed");
    guardTestScene(afterRestore.data.scenePath, "post-restore export");
    const restored = afterRestore.data.objects.find((o) => o.objectId === targetObjectId);
    assert(restored, `probe ${targetObjectId} missing after restore`);
    assertPosition(restored.position, preUndoPos, "final restored transform");
    step("unity_test_scene_restored", {
      objectId: targetObjectId,
      position: restored.position,
      expected: preUndoPos,
    });

    report.apiOk = true;
    report.unityIntegration = "passed";
    report.ok = true;
  }

  if (!REQUIRE_UNITY && report.unityIntegration === "pending" && report.apiOk) {
    report.ok = true;
    report.note = "REQUIRE_UNITY=0 allows API-only success with unity pending.";
  }
} catch (err) {
  report.ok = false;
  report.error = err.message;
  if (!report.unityIntegration || report.unityIntegration === "pending") {
    report.unityIntegration = report.unityIntegration === "pending" && !report.apiOk ? "failed" : report.unityIntegration;
  }
  console.error(`✗ ${err.message}`);
}

report.finishedAt = new Date().toISOString();
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`Report: ${reportPath}`);
process.exit(report.ok ? 0 : 1);
