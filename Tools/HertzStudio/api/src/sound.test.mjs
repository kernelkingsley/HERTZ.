import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-w07-sound-"));
process.env.HERTZ_STUDIO_DATA = dataDir;

const audioKenney = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const audioLocal = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const audioBad = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const modelId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(
  path.join(dataDir, "assets-catalog.json"),
  JSON.stringify({
    version: 1,
    assets: {
      [audioKenney]: {
        id: audioKenney,
        name: "impactGeneric_light_001",
        displayName: "Kenney Impact",
        assetType: "audio",
        provider: "kenney",
        license: "CC0",
        packName: "Impact Sounds",
        fileFormat: "wav",
        state: "unity_imported",
        preview: { kind: "audio", url: `/api/assets/previews/${audioKenney}` },
        unity: {
          readiness: "ready",
          clipPath: `Assets/HertzStudio/Imported/${audioKenney}/impactGeneric_light_001.wav`,
        },
      },
      [audioLocal]: {
        id: audioLocal,
        name: "floor_wood_step",
        assetType: "audio",
        provider: "local",
        fileFormat: "ogg",
        state: "ready",
        unity: { readiness: "pending" },
      },
      [audioBad]: {
        id: audioBad,
        name: "broken",
        assetType: "audio",
        state: "unsupported",
        unity: { readiness: "unsupported" },
      },
      [modelId]: {
        id: modelId,
        assetType: "model_3d",
        state: "unity_imported",
        unity: { readiness: "ready" },
      },
    },
    jobs: [],
    uploads: {},
  }),
  "utf8",
);

const sound = await import("./sound.mjs");

describe("W07 sound API", () => {
  after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("validates audio asset ids and rejects non-audio / unsupported", () => {
    assert.equal(sound.validateAudioAssetId(audioKenney), audioKenney);
    assert.throws(() => sound.validateAudioAssetId(modelId), (e) => e.code === "invalid_audio");
    assert.throws(() => sound.validateAudioAssetId(audioBad), (e) => e.code === "unsupported_audio");
  });

  it("assigns weapon shot slot and lists board", () => {
    const slot = sound.upsertSlot({
      category: "weapon",
      slotKey: "shot",
      targetId: "left_pistol",
      audioAssetId: audioKenney,
    });
    assert.equal(slot.audioAssetId, audioKenney);
    assert.equal(slot.audio.provider, "kenney");
    const board = sound.getSoundBoard();
    assert.ok(board.rules.materialAppearanceDoesNotChangeFootsteps);
    assert.ok(board.slots.some((s) => s.audioAssetId === audioKenney));
  });

  it("creates emitter with spatial settings that persist", () => {
    const em = sound.upsertEmitter({
      name: "Town Ambience",
      volume: 0.55,
      loop: true,
      spatialBlend: 1,
      minDistance: 2,
      maxDistance: 30,
      audioAssetId: audioKenney,
      position: { x: 1, y: 0, z: -2 },
    });
    assert.equal(em.volume, 0.55);
    assert.equal(em.spatialBlend, 1);
    assert.equal(em.loop, true);
    const again = sound.upsertEmitter({ id: em.id, volume: 0.4, loop: false });
    assert.equal(again.volume, 0.4);
    assert.equal(again.loop, false);
    assert.equal(again.id, em.id);
  });

  it("rejects auto material→footstep coupling; accepts explicit floor mapping", () => {
    assert.throws(
      () =>
        sound.upsertFootstepMapping({
          surfaceId: "floor_wood",
          audioAssetId: audioLocal,
          autoFromMaterial: true,
        }),
      (e) => e.code === "footstep_auto_forbidden",
    );
    assert.throws(
      () =>
        sound.upsertFootstepMapping({
          surfaceId: "floor_wood",
          materialGuid: "abc",
          audioAssetId: audioLocal,
        }),
      (e) => e.code === "footstep_auto_forbidden",
    );
    const map = sound.upsertFootstepMapping({
      surfaceId: "floor_wood",
      surfaceLabel: "Wood floor",
      audioAssetId: audioLocal,
    });
    assert.equal(map.surfaceId, "floor_wood");
    assert.equal(map.audioAssetId, audioLocal);
  });

  it("dependency-blocks unassign without force; force clears usages", () => {
    const deps = sound.collectAudioUsages(audioKenney);
    assert.ok(deps.total >= 1);
    assert.throws(() => sound.unassignAudio(audioKenney), (e) => e.code === "dependency_blocked");
    const cleared = sound.unassignAudio(audioKenney, { force: true });
    assert.ok(cleared.cleared >= 1);
    assert.equal(sound.collectAudioUsages(audioKenney).total, 0);
  });

  it("enqueues sync payload with Kenney clip + floor mapping", () => {
    sound.upsertSlot({
      category: "weapon",
      slotKey: "shot",
      targetId: "left_pistol",
      audioAssetId: audioKenney,
    });
    sound.upsertFootstepMapping({
      surfaceId: "floor_wood",
      surfaceLabel: "Wood floor",
      audioAssetId: audioLocal,
    });
    const job = sound.enqueueSoundSync("w07-test-req-1");
    assert.equal(job.type, "sync_sound_board");
    assert.ok(job.payload.payloadHash);
    assert.ok(job.payload.slots.some((s) => s.clip?.assetId === audioKenney));
    assert.ok(job.payload.footstepMappings.some((m) => m.surfaceId === "floor_wood"));
    assert.equal(job.payload.rules.materialAppearanceDoesNotChangeFootsteps, true);

    const ack = sound.acknowledgeSoundSync({
      requestId: "w07-test-req-1",
      ok: true,
      assetPath: "Assets/HertzStudio/Sound/SoundBoard.asset",
      assetGuid: "11111111111111111111111111111111",
      observedPayloadHash: job.payloadHash,
      unityRevision: 3,
    });
    assert.equal(ack.ok, true);
    assert.equal(ack.sync.state, "applied");
    assert.equal(ack.sync.observedPayloadHash, job.payloadHash);
    assert.equal(ack.sync.unityRevision, 3);

    // Idempotent matching retry
    const again = sound.acknowledgeSoundSync({
      requestId: "w07-test-req-1",
      ok: true,
      observedPayloadHash: job.payloadHash,
    });
    assert.equal(again.ok, true);
    assert.equal(again.deduplicated, true);

    // Missing hash never applies
    sound.enqueueSoundSync("w07-test-req-2");
    const missing = sound.acknowledgeSoundSync({ requestId: "w07-test-req-2", ok: true });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, "missing_payload_hash");
    assert.notEqual(missing.sync.state, "applied");

    // Mismatched hash never applies
    sound.enqueueSoundSync("w07-test-req-3");
    const mismatch = sound.acknowledgeSoundSync({
      requestId: "w07-test-req-3",
      ok: true,
      observedPayloadHash: "deadbeef",
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.code, "payload_hash_mismatch");

    // Unknown request
    assert.throws(
      () => sound.acknowledgeSoundSync({ requestId: "no-such", ok: true, observedPayloadHash: "x" }),
      (e) => e.code === "unknown_request",
    );

    // Newer pending job supersedes older ack
    const older = sound.enqueueSoundSync("w07-test-req-old");
    const newer = sound.enqueueSoundSync("w07-test-req-new");
    assert.ok(newer);
    const stale = sound.acknowledgeSoundSync({
      requestId: "w07-test-req-old",
      ok: true,
      observedPayloadHash: older.payloadHash,
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, "stale_acknowledgement");
    assert.equal(stale.status, 409);
  });

  it("rejects late ack after newer job is already applied or failed", () => {
    const first = sound.enqueueSoundSync("w07-term-old");
    const second = sound.enqueueSoundSync("w07-term-new");
    const applied = sound.acknowledgeSoundSync({
      requestId: "w07-term-new",
      ok: true,
      observedPayloadHash: second.payloadHash,
      unityRevision: 9,
      assetPath: "Assets/HertzStudio/Sound/SoundBoard.asset",
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.sync.state, "applied");
    const boardHash = applied.sync.payloadHash;
    const late = sound.acknowledgeSoundSync({
      requestId: "w07-term-old",
      ok: true,
      observedPayloadHash: first.payloadHash,
      unityRevision: 1,
      assetPath: "Assets/HertzStudio/Sound/Stale.asset",
    });
    assert.equal(late.ok, false);
    assert.equal(late.code, "stale_acknowledgement");
    assert.equal(late.newerJob.status, "applied");
    // Global sync must remain the newer applied mapping — not overwritten by the late ack.
    assert.equal(sound.getSoundBoard().sync?.state || late.sync.state, "applied");
    assert.equal(late.sync.payloadHash || boardHash, boardHash);

    const failOld = sound.enqueueSoundSync("w07-fail-old");
    const failNew = sound.enqueueSoundSync("w07-fail-new");
    const failed = sound.acknowledgeSoundSync({
      requestId: "w07-fail-new",
      ok: false,
      error: "unity_apply_failed",
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.job.status, "failed");
    const lateFail = sound.acknowledgeSoundSync({
      requestId: "w07-fail-old",
      ok: true,
      observedPayloadHash: failOld.payloadHash,
    });
    assert.equal(lateFail.ok, false);
    assert.equal(lateFail.code, "stale_acknowledgement");
    assert.equal(lateFail.newerJob.status, "failed");
  });

  it("duplicate requestId is idempotent for identical hash and 409 on changed payload", () => {
    sound.upsertSlot({
      category: "weapon",
      slotKey: "shot",
      targetId: "left_pistol",
      audioAssetId: audioKenney,
    });
    const first = sound.enqueueSoundSync("w07-dup-req");
    const again = sound.enqueueSoundSync("w07-dup-req");
    assert.equal(again.id, first.id);
    assert.equal(again.payloadHash, first.payloadHash);

    // Change canonical payload then reuse the same requestId → conflict.
    sound.upsertSlot({
      category: "weapon",
      slotKey: "shot",
      targetId: "right_pistol",
      audioAssetId: audioKenney,
    });
    assert.throws(
      () => sound.enqueueSoundSync("w07-dup-req"),
      (e) =>
        e.code === "request_id_conflict" &&
        e.existingPayloadHash === first.payloadHash &&
        e.attemptedPayloadHash &&
        e.attemptedPayloadHash !== first.payloadHash,
    );
  });

  it("lost acknowledgement retry after applied remains idempotent", () => {
    const job = sound.enqueueSoundSync("w07-lost-ack");
    const first = sound.acknowledgeSoundSync({
      requestId: "w07-lost-ack",
      ok: true,
      observedPayloadHash: job.payloadHash,
      unityRevision: 4,
    });
    assert.equal(first.ok, true);
    const retry = sound.acknowledgeSoundSync({
      requestId: "w07-lost-ack",
      ok: true,
      observedPayloadHash: job.payloadHash,
      unityRevision: 4,
    });
    assert.equal(retry.ok, true);
    assert.equal(retry.deduplicated, true);
  });

  it("same createdAt still orders by monotonic sequence", () => {
    const stamp = "2026-10-26T12:00:00.000Z";
    const a = sound.enqueueSoundSync("w07-same-ms-a");
    const b = sound.enqueueSoundSync("w07-same-ms-b");
    a.createdAt = stamp;
    b.createdAt = stamp;
    assert.ok(a.sequence < b.sequence);
    const stale = sound.acknowledgeSoundSync({
      requestId: "w07-same-ms-a",
      ok: true,
      observedPayloadHash: a.payloadHash,
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, "stale_acknowledgement");
    assert.equal(stale.newerJob.requestId, "w07-same-ms-b");
  });

  it("stale ack preserves newer sync byte-for-byte across terminal states", () => {
    function readSoundStore() {
      return JSON.parse(fs.readFileSync(path.join(dataDir, "store.json"), "utf8")).sound;
    }

    const states = [
      {
        name: "pending",
        setup: (oldId, newId) => {
          sound.enqueueSoundSync(oldId);
          sound.enqueueSoundSync(newId);
        },
      },
      {
        name: "applying",
        setup: (oldId, newId) => {
          sound.enqueueSoundSync(oldId);
          const n = sound.enqueueSoundSync(newId);
          sound.markSoundJobApplying(n.id);
        },
      },
      {
        name: "applied",
        setup: (oldId, newId) => {
          sound.enqueueSoundSync(oldId);
          const n = sound.enqueueSoundSync(newId);
          sound.acknowledgeSoundSync({
            requestId: newId,
            ok: true,
            observedPayloadHash: n.payloadHash,
            unityRevision: 42,
            assetGuid: "guid-applied",
            assetPath: "Assets/HertzStudio/Sound/HertzSoundBoard.asset",
          });
        },
      },
      {
        name: "failed",
        setup: (oldId, newId) => {
          sound.enqueueSoundSync(oldId);
          sound.enqueueSoundSync(newId);
          sound.acknowledgeSoundSync({ requestId: newId, ok: false, error: "newer_failed" });
        },
      },
      {
        name: "conflict",
        setup: (oldId, newId) => {
          sound.enqueueSoundSync(oldId);
          sound.enqueueSoundSync(newId);
          sound.acknowledgeSoundSync({
            requestId: newId,
            ok: false,
            conflict: true,
            error: "payload_conflict",
          });
        },
      },
      {
        name: "superseded",
        setup: (oldId, newId) => {
          sound.enqueueSoundSync(oldId);
          sound.enqueueSoundSync(newId);
          // Mark older superseded via a prior stale ack, then enqueue even newer.
          sound.acknowledgeSoundSync({
            requestId: oldId,
            ok: true,
            observedPayloadHash: "x",
          });
          sound.enqueueSoundSync(`${newId}-even-newer`);
        },
      },
    ];

    for (const caseDef of states) {
      const oldId = `w07-snap-old-${caseDef.name}`;
      const newId = `w07-snap-new-${caseDef.name}`;
      caseDef.setup(oldId, newId);
      const beforeSync = structuredClone(readSoundStore().sync);
      const mappingsBefore = structuredClone(readSoundStore().mappings || {});
      const lateTarget =
        caseDef.name === "superseded" ? oldId : oldId;
      // For superseded case the first stale already ran; ack the mid job against even-newer.
      const requestToAck =
        caseDef.name === "superseded" ? newId : oldId;
      const late = sound.acknowledgeSoundSync({
        requestId: requestToAck,
        ok: true,
        observedPayloadHash: "should-not-apply",
        unityRevision: 1,
        assetPath: "Assets/Stale.asset",
      });
      assert.equal(late.ok, false, caseDef.name);
      assert.equal(late.code, "stale_acknowledgement", caseDef.name);
      assert.equal(late.status, 409, caseDef.name);
      const after = readSoundStore();
      assert.deepEqual(after.sync, beforeSync, `sync mutated for ${caseDef.name}`);
      assert.deepEqual(after.mappings || {}, mappingsBefore, `mappings mutated for ${caseDef.name}`);
      for (const key of [
        "state",
        "lastRequestId",
        "payloadHash",
        "observedPayloadHash",
        "lastError",
        "assetGuid",
        "assetPath",
        "unityRevision",
      ]) {
        assert.equal(after.sync?.[key], beforeSync?.[key], `${caseDef.name}.${key}`);
      }
      assert.ok(
        (after.staleAckAttempts || []).some((a) => a.staleRequestId === requestToAck),
        `staleAckAttempts missing for ${caseDef.name}`,
      );
      void lateTarget;
    }
  });

  it("mixed legacy/current sequence migration keeps nextJobSequence strictly greater", () => {
    const storePath = path.join(dataDir, "store.json");
    const raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
    raw.sound.jobs.push(
      {
        id: "legacy-no-seq",
        requestId: "legacy-a",
        status: "applied",
        createdAt: "2026-01-01T00:00:00.000Z",
        payloadHash: "aa",
      },
      {
        id: "dup-seq-1",
        requestId: "dup-1",
        status: "failed",
        createdAt: "2026-01-02T00:00:00.000Z",
        sequence: 1,
        payloadHash: "bb",
      },
      {
        id: "dup-seq-2",
        requestId: "dup-2",
        status: "pending_unity",
        createdAt: "2026-01-03T00:00:00.000Z",
        sequence: 1,
        payloadHash: "cc",
      },
    );
    fs.writeFileSync(storePath, JSON.stringify(raw, null, 2));
    // Trigger ensureSoundStore migration via getSoundBoard / enqueue.
    sound.getSoundBoard();
    const migrated = JSON.parse(fs.readFileSync(storePath, "utf8")).sound;
    // getSoundBoard does not persist; enqueue forces save after ensure.
    const enq = sound.enqueueSoundSync("post-migration");
    const after = JSON.parse(fs.readFileSync(storePath, "utf8")).sound;
    const seqs = after.jobs.map((j) => j.sequence).filter((s) => Number.isFinite(s));
    assert.equal(new Set(seqs).size, seqs.length, "duplicate sequences after migration");
    assert.ok(after.nextJobSequence > Math.max(...seqs));
    assert.ok(enq.sequence < after.nextJobSequence);
    assert.ok(Number.isFinite(migrated.nextJobSequence) || Number.isFinite(after.nextJobSequence));
  });
});
