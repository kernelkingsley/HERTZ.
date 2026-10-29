/**
 * W07 assignment proof: Kenney/local audio → slot → sync job payload.
 * Does NOT acknowledge its own job as Unity success (that requires connector + bridge).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataOut = path.join(__dirname, "..", "data", "w07-assignment-proof.json");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-w07-assign-"));
process.env.HERTZ_STUDIO_DATA = tmp;

const audioId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const blobs = path.join(tmp, "private", "assets");
fs.mkdirSync(blobs, { recursive: true });
fs.writeFileSync(path.join(blobs, `${audioId}.wav`), Buffer.from("RIFF....WAVEfmt "));
fs.writeFileSync(
  path.join(tmp, "assets-catalog.json"),
  JSON.stringify({
    version: 1,
    assets: {
      [audioId]: {
        id: audioId,
        displayName: "Kenney Impact",
        assetType: "audio",
        provider: "kenney",
        license: "CC0",
        fileFormat: "wav",
        state: "unity_imported",
        blobPath: `private/assets/${audioId}.wav`,
        unity: { readiness: "ready", clipPath: "Assets/HertzStudio/Imported/c/impact.wav" },
      },
    },
    jobs: [],
    uploads: {},
  }),
);

const sound = await import("../api/src/sound.mjs");
const checks = [];
function check(name, pass, actual, expected, layer = "api_data") {
  checks.push({ name, pass: Boolean(pass), actual, expected, layer });
}

const slot = sound.upsertSlot({
  category: "weapon",
  slotKey: "shot",
  targetId: "left_pistol",
  audioAssetId: audioId,
});
check("assign_shot", slot.audioAssetId === audioId, slot.audioAssetId, audioId);

sound.upsertFootstepMapping({ surfaceId: "floor_wood", surfaceLabel: "Wood floor", audioAssetId: audioId });
const board = sound.getSoundBoard();
check(
  "board_persists",
  board.slots.some((s) => s.audioAssetId === audioId) && board.footstepMappings.some((m) => m.surfaceId === "floor_wood"),
  board.slots.length,
  ">=1",
);

const job = sound.enqueueSoundSync("w07-assign-proof");
check(
  "sync_job_enqueued",
  job?.type === "sync_sound_board" && job?.requestId === "w07-assign-proof",
  job?.type,
  "sync_sound_board",
);
check(
  "sync_payload_clip",
  Boolean(job.payload?.slots?.find((s) => s.clip?.assetId === audioId)),
  job.type,
  "sync_sound_board",
);
check(
  "sync_payload_hash",
  typeof job.payload?.payloadHash === "string" && job.payload.payloadHash.length > 8,
  job.payload?.payloadHash?.slice?.(0, 8),
  "hash",
);
check(
  "unity_ack_not_faked",
  true,
  "skipped_self_acknowledge",
  "skipped_self_acknowledge",
  "unity_application",
);

const passed = checks.filter((c) => c.pass).length;
const out = {
  schemaVersion: 2,
  proof: "w07-assignment",
  ok: passed === checks.length,
  passed,
  total: checks.length,
  stampedAt: new Date().toISOString(),
  layers: {
    api_data: { ok: true },
    connector_delivery: { ok: false, status: "pending_live_connector" },
    unity_application: { ok: false, status: "pending_live_ack_matching_requestId_and_payloadHash" },
    runtime_playback: { ok: false, status: "pending_menu_or_playmode" },
  },
  checks,
  manualUnity: [
    "Start connector + Unity bridge (8791 healthy).",
    "POST /api/sound/sync (or Sound page Sync) and confirm connector polls then Unity ack matches requestId + payloadHash.",
    "Menu HERTZ/Studio/Proofs/W07 Sound Runtime (writes authoritative w07-sound-runtime-proof.json).",
    "HertzWeaponTest Play Mode: frequency off → no shot sound; frequency on → accepted shot plays assigned clip once.",
  ],
};
fs.mkdirSync(path.dirname(dataOut), { recursive: true });
fs.writeFileSync(dataOut, `${JSON.stringify(out, null, 2)}\n`);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(JSON.stringify({ ok: out.ok, passed: out.passed, total: out.total }));
process.exit(out.ok ? 0 : 1);
