/**
 * Fail-closed W04 aggregate — definition sync, frequency runtime, browser proofs.
 * Rejects direct-call-only subscription proofs and disconnected-as-success browser proofs.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProofBuilder, assertProofSchema } from "./lib/proof-schema.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");
const outPath = path.join(dataDir, "w04-aggregate-proof.json");

const requiredArtifacts = [
  {
    file: "w04-weapon-definition-sync-proof.json",
    requiredChecks: ["sync_left_create", "sync_left_update_preserves_guid", "sync_right_create"],
  },
  {
    file: "w04-frequency-runtime-proof.json",
    requiredChecks: [
      "freq_off_blocks_left",
      "freq_on_allows_left",
      "freq_off_again_blocks",
      "input_subscription_one_shot",
      "no_duplicate_fire_subscription",
      "subscription_path_not_direct_call_only",
      "direct_tryfire_does_not_count_as_subscription",
      "persistent_scene_has_playable_rig",
      "saved_scene_zero_runtime_clones",
      "rebuild_idempotent_zero_runtime",
      "play_mode_exactly_one_left_right_runtime",
      "play_mode_rebind_no_accumulate",
      "blocked_shot_no_fx_or_audio",
      "sound_boundary_listener_and_presenter_once",
      "sound_boundary_blocked_delivers_zero",
      "sound_boundary_unassigned_presenter_silent",
      "effects_pooled_no_hot_path_spawn",
      "damage_affects_target",
      "range_blocks_far_target",
      "fire_interval_blocks_rapid",
      "recoil_changes_visual",
    ],
  },
  {
    file: "w04-browser-e2e-proof.json",
    requiredChecks: [
      "browser_login",
      "weapons_page_loaded",
      "save_weapon",
      "sync_applied_live",
      "sync_guid_path_present",
      "sync_hash_version_match",
      "sync_unity_resolve_ok",
      "disconnected_not_accepted_as_success",
      "e2e_weapon_cleanup_complete",
    ],
  },
];

const builder = createProofBuilder({
  proof: "w04-aggregate",
  runner: "proof-w04-aggregate",
  runnerVersion: "2",
  command: "node scripts/proof-w04-aggregate.mjs",
});

const maxAgeMs = 6 * 60 * 60 * 1000;
const now = Date.now();

for (const art of requiredArtifacts) {
  const p = path.join(dataDir, art.file);
  if (!fs.existsSync(p)) {
    builder.record(`artifact_${art.file}`, false, {
      actual: "missing",
      expected: "present",
    });
    continue;
  }
  let json;
  try {
    let text = fs.readFileSync(p, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    json = JSON.parse(text);
  } catch (err) {
    builder.record(`artifact_${art.file}`, false, { actual: String(err.message), expected: "valid json" });
    continue;
  }
  const stamped = Date.parse(json.stampedAt || json.startedAt || 0);
  const fresh = Number.isFinite(stamped) && now - stamped < maxAgeMs;
  builder.record(`artifact_${art.file}_fresh`, fresh, {
    actual: json.stampedAt || null,
    expected: `age < ${maxAgeMs}ms`,
  });
  builder.record(`artifact_${art.file}_ok`, json.ok === true, {
    actual: { ok: json.ok, passed: json.passed, total: json.total },
    expected: "ok true",
  });
  const names = new Set((json.checks || []).filter((c) => c.pass).map((c) => c.name));
  for (const need of art.requiredChecks) {
    builder.record(`${art.file}:${need}`, names.has(need), {
      actual: names.has(need) ? "present+pass" : "missing",
      expected: need,
    });
  }

  // Negative: browser proof that only shows disconnected must not satisfy sync_applied_live.
  if (art.file === "w04-browser-e2e-proof.json") {
    const syncCheck = (json.checks || []).find((c) => c.name === "sync_status_visible");
    const applied = (json.checks || []).find((c) => c.name === "sync_applied_live");
    const disconnectedOnly =
      syncCheck?.pass &&
      /disconnected/i.test(String(syncCheck.actual || "")) &&
      !applied?.pass;
    builder.record("negative_disconnected_sync_not_sufficient", !disconnectedOnly || Boolean(applied?.pass), {
      actual: { syncCheck, applied: applied?.pass },
      expected: "sync_applied_live required; disconnected-only fails",
    });
  }

  if (art.file === "w04-frequency-runtime-proof.json") {
    const hasInput = names.has("input_subscription_one_shot");
    const hasRejectDirect = names.has("subscription_path_not_direct_call_only");
    builder.record("negative_direct_call_only_subscription_rejected", hasInput && hasRejectDirect, {
      actual: { hasInput, hasRejectDirect },
      expected: "input_subscription_one_shot + subscription_path_not_direct_call_only",
    });
    const proofSrc = fs.readFileSync(
      path.join(__dirname, "../../../Assets/Editor/HertzStudio/HertzStudioWeaponProof.cs"),
      "utf8",
    );
    const start = proofSrc.indexOf("--- Input System subscription proof");
    const end = proofSrc.indexOf("--- Sound integration boundary");
    const block = start >= 0 && end > start ? proofSrc.slice(start, end) : "";
    const pressIdx = block.indexOf("TryPressKey");
    const afterPress = pressIdx >= 0 ? block.slice(pressIdx) : block;
    const clean =
      block.length > 0 &&
      !/RaiseActivateFromInputBoundary/.test(block) &&
      !/HandleActivate\s*\(/.test(block) &&
      pressIdx >= 0 &&
      !/TryFireLeftForProof|TryFireRightForProof|RaiseActivateFromInputBoundary/.test(afterPress);
    builder.record("negative_subscription_source_no_manual_fallback", clean, {
      actual: { hasSection: block.length > 0, pressIdx },
      expected: "subscription block uses TryPressKey only (no RaiseActivate/TryFire rescue)",
    });
  }
}

const artifact = builder.build({
  requiredChecks: [
    ...requiredArtifacts.flatMap((a) => [
      `artifact_${a.file}_fresh`,
      `artifact_${a.file}_ok`,
      ...a.requiredChecks.map((c) => `${a.file}:${c}`),
    ]),
    "negative_disconnected_sync_not_sufficient",
    "negative_direct_call_only_subscription_rejected",
    "negative_subscription_source_no_manual_fallback",
  ],
});
const errors = assertProofSchema(artifact, artifact.requiredChecks || []);
if (errors.length) {
  artifact.ok = false;
  artifact.schemaErrors = errors;
}
fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`Wrote ${outPath} ok=${artifact.ok} (${artifact.passed}/${artifact.total})`);
process.exit(artifact.ok ? 0 : 1);
