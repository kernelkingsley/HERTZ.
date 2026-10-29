/**
 * Fail-closed aggregator for W03 proof artifacts.
 * Requires every critical W03 acceptance check; rejects stale / skipped-as-pass artifacts.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertProofSchema, PROOF_SCHEMA_VERSION, MAX_PROOF_AGE_MS } from "./lib/proof-schema.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");
const outPath = path.join(dataDir, "w03-aggregate-proof.json");

const REQUIRED_ARTIFACTS = [
  {
    file: "w03-completion-batch-proof.json",
    runnerIncludes: "proof-w03-completion-batch",
    requiredChecks: [
      "bridge_health",
      "authenticated_login",
      "sync_from_unity",
      "studio_scene_is_hertz_studio_test",
      "hierarchy_root_and_child_present",
      "numeric_root_edit_saved",
      "numeric_root_edit_applied",
      "gizmo_root_edit_saved",
      "gizmo_root_edit_applied",
      "numeric_child_uses_local",
      "numeric_child_local_edit_saved",
      "numeric_child_local_edit_applied",
      "gizmo_child_local_world_ok",
      "root_move_unchanged_descendant_locals",
      "rapid_commits_serialized",
      "conflict_rollback_viewport",
      "successful_commit_syncs_draft_and_viewport",
      "protected_xr_camera_immutable",
      "restore_transforms_applied",
      "stale_version_rejected",
      "milestone_w03_not_self_approved",
      "npm_build",
      "sample_scene_disk_hash_captured",
    ],
    requireScene: "HertzStudioTest",
  },
  {
    file: "w03-browser-e2e-proof.json",
    runnerIncludes: "e2e-w03-browser",
    requiredChecks: [
      "browser_login",
      "dashboard_w03_status",
      "milestones_w03_matches_dashboard",
      "level_editor_sync_completed",
      "select_root_object",
      "numeric_root_commit_persisted",
      "gizmo_root_commit_persisted",
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
    ],
  },
  {
    file: "w03-typed-ops-proof.json",
    runnerIncludes: "HertzStudioTypedOpsProof",
    requiredChecks: [
      "assign_material_via_scene_commands",
      "wall_materials_independent",
      "floor_material_assigned",
      "assign_sprite",
      "assign_ui",
      "assign_audio",
      "assign_animation",
      "instantiate_model",
      "replace_floor_wall",
      "replace_preserves_unrelated_component",
      "atomic_rollback_cleans_generated_materials",
      "protected_camera_rejected",
      "scene_clean_after_proof",
      "sample_scene_disk_hash_unchanged",
    ],
    requireScene: "HertzStudioTest",
  },
];

function loadJson(file) {
  const p = path.join(dataDir, file);
  if (!fs.existsSync(p)) return { error: `missing ${file}`, path: p };
  try {
    return { artifact: JSON.parse(fs.readFileSync(p, "utf8")), path: p };
  } catch (err) {
    return { error: `parse failed: ${err.message}`, path: p };
  }
}

const aggregateChecks = [];
let ok = true;

for (const req of REQUIRED_ARTIFACTS) {
  const loaded = loadJson(req.file);
  if (loaded.error) {
    aggregateChecks.push({
      name: `artifact_${req.file}`,
      pass: false,
      actual: loaded.error,
      expected: "present valid JSON",
    });
    ok = false;
    continue;
  }
  const a = loaded.artifact;
  const schemaErrors = assertProofSchema(a, req.requiredChecks, { maxAgeMs: MAX_PROOF_AGE_MS });
  const runnerOk = String(a.runner || "").includes(req.runnerIncludes);
  const sceneOk = !req.requireScene || String(a.scenePath || "").includes(req.requireScene);
  const checksOwned = Array.isArray(a.checks) && a.checks.every((c) => typeof c.name === "string");
  const forbiddenTopLevelClaims = ["browserOk", "unityDirtyClean", "manuallyVerified"];
  const hasForbidden = forbiddenTopLevelClaims.some((k) => k in a && !a.checks?.some((c) => c.name === k));
  const skippedPass = (a.checks || []).some(
    (c) => c.pass && (c.actual === "skipped" || c.expected === "skipped"),
  );

  const pass =
    schemaErrors.length === 0 &&
    runnerOk &&
    sceneOk &&
    checksOwned &&
    a.ok === true &&
    !hasForbidden &&
    !skippedPass;

  aggregateChecks.push({
    name: `artifact_${req.file}`,
    pass,
    actual: {
      ok: a.ok,
      runner: a.runner,
      scenePath: a.scenePath,
      stampedAt: a.stampedAt,
      schemaErrors,
      runnerOk,
      sceneOk,
      skippedPass,
      passed: a.passed,
      total: a.total,
    },
    expected: {
      schemaVersion: PROOF_SCHEMA_VERSION,
      runnerIncludes: req.runnerIncludes,
      requiredChecks: req.requiredChecks,
      maxAgeMs: MAX_PROOF_AGE_MS,
    },
  });
  if (!pass) ok = false;
}

const artifact = {
  schemaVersion: PROOF_SCHEMA_VERSION,
  proof: "w03-aggregate",
  runner: "proof-w03-aggregate",
  runnerVersion: "3",
  command: "node scripts/proof-w03-aggregate.mjs",
  stampedAt: new Date().toISOString(),
  checks: aggregateChecks,
  passed: aggregateChecks.filter((c) => c.pass).length,
  total: aggregateChecks.length,
  ok: ok && aggregateChecks.length > 0 && aggregateChecks.every((c) => c.pass),
  requiredArtifacts: REQUIRED_ARTIFACTS.map((r) => r.file),
};

fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`Wrote ${outPath} ok=${artifact.ok} (${artifact.passed}/${artifact.total})`);
process.exit(artifact.ok ? 0 : 1);
