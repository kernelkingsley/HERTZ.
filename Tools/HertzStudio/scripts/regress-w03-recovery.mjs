/**
 * Priority 1 #7: store + command recovery across a real process restart.
 * Parent orchestrates; child phases import store.mjs fresh with HERTZ_STUDIO_DATA.
 * Never touches the live store.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const phase = process.env.HERTZ_W03_RECOVERY_PHASE || "parent";

function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

async function runSetup() {
  const dataDir = process.env.HERTZ_STUDIO_DATA;
  assert.ok(dataDir, "HERTZ_STUDIO_DATA required");
  const requestId = process.env.HERTZ_W03_RECOVERY_REQUEST_ID || "recover-cmd-1";
  const store = await import("../api/src/store.mjs");
  assert.equal(store.DATA_DIR, path.resolve(dataDir));

  store.ensureOwnerBootstrap();
  const draft = store.createDraft({
    title: "recovery-fixture",
    scenePath: "Assets/Scenes/HertzStudioTest.unity",
    unityRevision: 10,
    objects: [
      {
        objectId: "obj-1",
        source: "primitive",
        assetType: "primitive",
        name: "Cube",
        position: { x: 1, y: 2, z: 3 },
      },
    ],
  });
  assert.ok(draft?.id);
  const queued = store.enqueueApply(draft.id, requestId, draft.version);
  assert.equal(queued.status, 202);
  store.markApplying(queued.command.id);
  const loaded = store.loadStore();
  assert.equal(loaded.queue[0]?.status, "applying");
  assert.ok(fs.existsSync(path.join(dataDir, "store.json.good")));

  emit({
    ok: true,
    phase: "setup",
    dataDir,
    draftId: draft.id,
    requestId,
    commandId: queued.command.id,
    status: "applying",
  });
}

async function runResume() {
  const dataDir = process.env.HERTZ_STUDIO_DATA;
  const requestId = process.env.HERTZ_W03_RECOVERY_REQUEST_ID || "recover-cmd-1";
  const mode = process.env.HERTZ_W03_RECOVERY_MODE || "missing";
  assert.ok(dataDir, "HERTZ_STUDIO_DATA required");

  const store = await import("../api/src/store.mjs");
  assert.equal(store.DATA_DIR, path.resolve(dataDir));

  store.clearStoreRecoveryFlag();
  const restored = store.loadStore();
  const recovery = store.getStoreRecovery();
  const expectedReason =
    mode === "corrupt" ? "primary_store_corrupt" : "primary_missing_restored_good";
  assert.equal(recovery?.reason, expectedReason, `recovery.reason=${recovery?.reason}`);
  if (mode === "corrupt") {
    assert.equal(recovery?.restoredFrom, "store.json.good");
  }

  const pending = store.nextPendingCommand();
  assert.equal(pending?.requestId, requestId);
  assert.equal(pending?.status, "applying");

  const ack = store.acknowledgeCommand({
    requestId,
    ok: true,
    unityRevision: 11,
  });
  assert.equal(ack?.deduplicated, false);
  assert.equal(ack?.command?.status, "applied");

  const dupAck = store.acknowledgeCommand({
    requestId,
    ok: true,
    unityRevision: 999,
  });
  assert.equal(dupAck?.deduplicated, true);
  assert.equal(store.getQueue().find((q) => q.requestId === requestId)?.status, "applied");

  emit({
    ok: true,
    phase: "resume",
    mode,
    dataDir,
    requestId,
    recoveryReason: recovery.reason,
    draftSurvived: Boolean(restored.drafts && Object.keys(restored.drafts).length),
    ackDeduplicated: ack.deduplicated,
    dupAckDeduplicated: dupAck.deduplicated,
  });
}

function runChild(env) {
  const result = spawnSync(process.execPath, [__filename], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `child phase=${env.HERTZ_W03_RECOVERY_PHASE} failed status=${result.status}\n` +
        `stdout=${result.stdout}\nstderr=${result.stderr}`,
    );
  }
  const lines = result.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"));
  assert.ok(lines.length >= 1, "child emitted no JSON");
  return JSON.parse(lines[lines.length - 1]);
}

async function runParent() {
  const checks = [];
  function check(name, pass, detail = undefined) {
    checks.push({ name, pass: Boolean(pass), detail });
    assert.ok(pass, detail ? `${name}: ${detail}` : name);
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-w03-recovery-"));
  const storePath = path.join(dataDir, "store.json");

  // --- Cycle A: missing primary after real process restart ---
  const setupMissing = runChild({
    HERTZ_STUDIO_DATA: dataDir,
    HERTZ_W03_RECOVERY_PHASE: "setup",
    HERTZ_W03_RECOVERY_REQUEST_ID: "recover-missing-1",
  });
  check("setup_missing_applying", setupMissing.status === "applying");
  fs.unlinkSync(storePath);
  check("primary_removed_for_restart", !fs.existsSync(storePath));

  const resumeMissing = runChild({
    HERTZ_STUDIO_DATA: dataDir,
    HERTZ_W03_RECOVERY_PHASE: "resume",
    HERTZ_W03_RECOVERY_MODE: "missing",
    HERTZ_W03_RECOVERY_REQUEST_ID: "recover-missing-1",
  });
  check(
    "fresh_process_restored_missing_primary",
    resumeMissing.recoveryReason === "primary_missing_restored_good",
  );
  check("fresh_process_ack_after_missing", resumeMissing.ackDeduplicated === false);
  check("fresh_process_dup_ack_after_missing", resumeMissing.dupAckDeduplicated === true);
  check("draft_survived_missing_restart", resumeMissing.draftSurvived === true);

  // --- Cycle B: corrupt primary after real process restart ---
  const dataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-w03-recovery-corrupt-"));
  const storePath2 = path.join(dataDir2, "store.json");
  const setupCorrupt = runChild({
    HERTZ_STUDIO_DATA: dataDir2,
    HERTZ_W03_RECOVERY_PHASE: "setup",
    HERTZ_W03_RECOVERY_REQUEST_ID: "recover-corrupt-1",
  });
  check("setup_corrupt_applying", setupCorrupt.status === "applying");
  fs.writeFileSync(storePath2, "{not-valid-json", "utf8");

  const resumeCorrupt = runChild({
    HERTZ_STUDIO_DATA: dataDir2,
    HERTZ_W03_RECOVERY_PHASE: "resume",
    HERTZ_W03_RECOVERY_MODE: "corrupt",
    HERTZ_W03_RECOVERY_REQUEST_ID: "recover-corrupt-1",
  });
  check(
    "fresh_process_restored_corrupt_primary",
    resumeCorrupt.recoveryReason === "primary_store_corrupt",
  );
  check("fresh_process_ack_after_corrupt", resumeCorrupt.ackDeduplicated === false);
  check("fresh_process_dup_ack_after_corrupt", resumeCorrupt.dupAckDeduplicated === true);
  check("draft_survived_corrupt_restart", resumeCorrupt.draftSurvived === true);

  check(
    "isolated_data_dir",
    !path.resolve(dataDir).replace(/\\/g, "/").endsWith("/Tools/HertzStudio/data") &&
      !path.resolve(dataDir2).replace(/\\/g, "/").endsWith("/Tools/HertzStudio/data"),
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        checks: checks.length,
        processRestart: true,
        dataDirs: [dataDir, dataDir2],
        results: checks,
      },
      null,
      2,
    ),
  );
}

if (phase === "setup") {
  await runSetup();
} else if (phase === "resume") {
  await runResume();
} else {
  await runParent();
}
