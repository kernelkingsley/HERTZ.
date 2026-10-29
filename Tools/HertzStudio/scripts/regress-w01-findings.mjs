/**
 * Focused API-store regressions for W01 review findings 1, 4, 9, 10 (no Unity required).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const scratch = path.join(root, "data", "secrets", `regress-${randomBytes(4).toString("hex")}`);
fs.mkdirSync(scratch, { recursive: true });

// Point the store module at an isolated data dir via symlink/copy of module with env override.
// store.mjs uses a fixed DATA_DIR; copy module and patch path for isolation.
const storeSrc = fs.readFileSync(path.join(root, "api/src/store.mjs"), "utf8");
const isolatedStorePath = path.join(scratch, "store.mjs");
const isolatedDataDir = path.join(scratch, "data").replaceAll("\\", "/");
const draftCommandsAbs = path.join(root, "api/src/draft-commands.mjs").replaceAll("\\", "/");
const patched = storeSrc
  .replace(
    /export const DATA_DIR = path\.resolve\(__dirname, "\.\.\/\.\.\/data"\);/,
    `export const DATA_DIR = ${JSON.stringify(isolatedDataDir)};`,
  )
  .replace(
    /from "\.\/draft-commands\.mjs"/,
    `from ${JSON.stringify(pathToFileURL(draftCommandsAbs).href)}`,
  );
fs.writeFileSync(isolatedStorePath, patched);
fs.mkdirSync(isolatedDataDir, { recursive: true });

const store = await import(pathToFileURL(isolatedStorePath).href);
store.ensureOwnerBootstrap();

const report = { startedAt: new Date().toISOString(), checks: [], ok: true };

function check(name, condition, detail = {}) {
  report.checks.push({ name, pass: Boolean(condition), ...detail });
  if (!condition) {
    report.ok = false;
    console.error(`✗ ${name}`);
  } else {
    console.log(`✓ ${name}`);
  }
}

// Finding 1: old ack must not clobber newer draft
{
  const draft = store.createDraft({
    title: "f1",
    scenePath: "Assets/Scenes/HertzStudioTest.unity",
    objects: [{ objectId: "a", position: { x: 0, y: 1, z: 0 } }],
    unityRevision: 0,
  });
  const q1 = store.enqueueApply(draft.id, "req-old");
  store.markApplying(q1.command.id);
  store.updateDraft(draft.id, {
    expectedVersion: 1,
    objects: [{ objectId: "a", position: { x: 10, y: 1, z: 0 } }],
  });
  store.acknowledgeCommand({
    requestId: "req-old",
    ok: true,
    unityRevision: 1,
    sceneExport: {
      objects: [{ objectId: "a", position: { x: 0, y: 1, z: 0 } }],
    },
  });
  const after = store.getDraft(draft.id);
  check("finding1_preserves_newer_draft_objects", after.objects[0].position.x === 10, {
    status: after.status,
    version: after.version,
    baseUnityRevision: after.baseUnityRevision,
  });
  check("finding1_reconciles_base_revision", after.baseUnityRevision === 1);
  check("finding1_not_marked_applied_over_newer", after.status !== "applied");
}

// Finding 4: import creates draft with objects
{
  const result = store.importSceneSnapshot({
    scenePath: "Assets/Scenes/HertzStudioTest.unity",
    sceneName: "HertzStudioTest",
    unityRevision: 3,
    objects: [{ objectId: "probe", name: "HertzProbe", position: { x: 1, y: 2, z: 3 } }],
  });
  // May skip create if editable drafts exist from finding 1 — use fresh store subsection by forcing empty drafts.
  const s = store.loadStore();
  s.drafts = {};
  store.saveStore(s);
  const result2 = store.importSceneSnapshot({
    scenePath: "Assets/Scenes/HertzStudioTest.unity",
    sceneName: "HertzStudioTest",
    unityRevision: 3,
    objects: [{ objectId: "probe", name: "HertzProbe", position: { x: 1, y: 2, z: 3 } }],
  });
  check("finding4_import_persists_export", Array.isArray(store.loadStore().project.lastSceneExport?.objects));
  check("finding4_import_creates_draft", Boolean(result2.draft?.id));
  check("finding4_draft_has_objects", result2.draft?.objects?.[0]?.objectId === "probe");
  const opened = store.openDraftFromSceneExport();
  check("finding4_open_from_scene", Boolean(opened.draft?.id));
}

// Finding 9: conflict updates draft out of applying
{
  const draft = store.createDraft({
    title: "f9",
    scenePath: "Assets/Scenes/HertzStudioTest.unity",
    objects: [{ objectId: "b", position: { x: 0, y: 0, z: 0 } }],
    unityRevision: 0,
  });
  const q = store.enqueueApply(draft.id, "req-conflict");
  store.markApplying(q.command.id);
  store.acknowledgeCommand({ requestId: "req-conflict", ok: false, conflict: true, error: "stale" });
  const after = store.getDraft(draft.id);
  check("finding9_conflict_leaves_draft_conflict", after.status === "conflict", { status: after.status });
}

// Finding 10: stale connector heartbeat
{
  store.mutateStore((s) => {
    s.project.connectorLastSeenAt = "2000-01-01T00:00:00.000Z";
    s.project.unityConnected = true;
    s.pairing.connectorTokenHash = "x";
  });
  const status = store.projectConnectionStatus();
  check("finding10_stale_is_disconnected", status.unityConnected === false, status);
  check("finding10_status_label", status.connectorStatus === "disconnected");
}

// R5: fresh connector + Unity unreachable must report disconnected
{
  store.mutateStore((s) => {
    s.project.connectorLastSeenAt = new Date().toISOString();
    s.project.unityConnected = false;
    s.pairing.connectorTokenHash = "x";
  });
  const status = store.projectConnectionStatus();
  check("r5_fresh_but_unreachable_is_offline", status.unityConnected === false, status);
  check("r5_status_paired_offline", status.connectorStatus === "paired_offline", status);
  check("r5_reports_reachability_flags", status.connectorFresh === true && status.unityReachable === false);
}

// R5: fresh + reachable = connected
{
  store.mutateStore((s) => {
    s.project.connectorLastSeenAt = new Date().toISOString();
    s.project.unityConnected = true;
    s.pairing.connectorTokenHash = "x";
  });
  const status = store.projectConnectionStatus();
  check("r5_fresh_and_reachable_connected", status.unityConnected === true, status);
}

// R8: expectedDraftVersion mismatch returns 409; match enqueues
{
  const draft = store.createDraft({
    title: "r8",
    scenePath: "Assets/Scenes/HertzStudioTest.unity",
    objects: [{ objectId: "c", position: { x: 1, y: 2, z: 3 } }],
    unityRevision: 0,
  });
  const mismatch = store.enqueueApply(draft.id, "req-r8-mismatch", draft.version + 99);
  check("r8_version_mismatch_409", mismatch.status === 409 && Boolean(mismatch.error), mismatch);
  const ok = store.enqueueApply(draft.id, "req-r8-ok", draft.version);
  check("r8_version_match_enqueues", ok.status === 202 && ok.command?.draftVersion === draft.version, {
    status: ok.status,
    draftVersion: ok.command?.draftVersion,
  });
  const missing = store.enqueueApply(draft.id, "req-r8-legacy");
  check("r8_omitted_expected_still_enqueues_for_compat", missing.status === 202);
}

// Finding 3 / round-2: API rejects non-finite / non-numeric axes
{
  const bad = store.validateDraftObjects([
    { objectId: "z", position: { x: "oops", y: 1, z: 2 } },
  ]);
  check("r2_api_rejects_string_axis", typeof bad === "string" && bad.includes("finite"));
  const missing = store.validateDraftObjects([{ objectId: "z", position: { y: 1, z: 2 } }]);
  check("r2_api_rejects_missing_axis", typeof missing === "string");
  const ok = store.validateDraftObjects([{ objectId: "z", position: { x: 1, y: 2, z: 3 } }]);
  check("r2_api_accepts_finite_axes", ok === null);
  const createdBad = store.createDraft({
    title: "bad",
    objects: [{ objectId: "z", position: { x: null, y: 1, z: 2 } }],
  });
  check("r2_create_draft_rejects_null_axis", createdBad.status === 400 && Boolean(createdBad.error));
}

// Round-2 finding 1: corrupt newest generation restores from store.json.good
{
  const draft = store.createDraft({
    title: "durable",
    scenePath: "Assets/Scenes/HertzStudioTest.unity",
    objects: [{ objectId: "d", position: { x: 4, y: 5, z: 6 } }],
    unityRevision: 2,
  });
  const q = store.enqueueApply(draft.id, "req-durable-pending", draft.version);
  check("durable_enqueued_pending", q.status === 202);
  const goodPath = path.join(isolatedDataDir, "store.json.good");
  const primaryPath = path.join(isolatedDataDir, "store.json");
  check("durable_good_generation_exists", fs.existsSync(goodPath));
  // Simulate truncated/interrupted newest write.
  fs.writeFileSync(primaryPath, "\u0000\u0000{\"truncated\":true");
  store.clearStoreRecoveryFlag();
  const recovered = store.loadStore();
  check("durable_restored_draft", Boolean(recovered.drafts?.[draft.id]), {
    draftIds: Object.keys(recovered.drafts || {}),
  });
  check("durable_restored_pending_command", recovered.queue?.some((c) => c.requestId === "req-durable-pending"));
  check("durable_surfaces_recovery", Boolean(recovered.storeRecovery?.restoredFrom), recovered.storeRecovery);
  check("durable_not_empty_reset", recovered.storeRecovery?.emptyReset !== true);
}

report.finishedAt = new Date().toISOString();
report.scratch = scratch;
const out = path.join(root, "data", "w01-regression-report.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`Report: ${out}`);
process.exit(report.ok ? 0 : 1);
