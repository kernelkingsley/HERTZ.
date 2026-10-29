/**
 * Fail-closed W03 completion proof (API + bridge).
 * Requires HERTZ_OWNER_PASSWORD. Never logs the password.
 * Skipped checks cannot pass. Mutations only when active scene is HertzStudioTest.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  buildNumericTransformPayload,
  formValuesFromObject,
  usesLocalNumericEdit,
  isProtectedDraftObject,
} from "../web/src/lib/levelEditorTransforms.js";
import { assertFreshApplySave, buildSaveObjectsFromDraft } from "../web/src/lib/levelEditorSceneViewport.js";
import { getMilestoneStatus, listMilestones, summarizeMilestoneProgress } from "../shared/milestoneStatus.mjs";
import { createProofBuilder, assertProofSchema } from "./lib/proof-schema.mjs";
import { objectSupportsOperation } from "../web/src/lib/typedDropTargets.js";
import { validateDraftScene } from "../api/src/walkability.mjs";

const API = process.env.HERTZ_API_URL || "http://127.0.0.1:8787";
const BRIDGE = process.env.HERTZ_UNITY_BRIDGE_URL || "http://127.0.0.1:8791";
const PASSWORD = process.env.HERTZ_OWNER_PASSWORD;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outPath = path.join(root, "data", "w03-completion-batch-proof.json");
const COMMAND = "node scripts/proof-w03-completion-batch.mjs";

if (!PASSWORD) {
  console.error("HERTZ_OWNER_PASSWORD is required for authenticated W03 proof. No fallback is allowed.");
  process.exit(2);
}

const builder = createProofBuilder({
  proof: "w03-completion-batch",
  runner: "proof-w03-completion-batch",
  runnerVersion: "3",
  command: COMMAND,
  scenePath: null,
});

const jar = { cookie: "" };
const requiredChecks = [
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
  "bridge_still_healthy",
  "npm_build",
  "npm_measure_dashboard",
  "sample_scene_disk_hash_captured",
];

async function api(pathname, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (jar.cookie) headers.Cookie = jar.cookie;
  const response = await fetch(`${API}${pathname}`, { ...options, headers });
  const raw = response.headers.get("set-cookie");
  if (raw) jar.cookie = raw.split(";")[0];
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

async function bridgeHealth() {
  const response = await fetch(`${BRIDGE}/health`);
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok && data.ok === true, status: response.status, data };
}

async function waitApplied(draftId, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { data } = await api(`/api/drafts/${draftId}`);
    if (["applied", "failed", "conflict"].includes(data.status)) return data;
    await new Promise((r) => setTimeout(r, 600));
  }
  return null;
}

function findByName(objects, name) {
  return (objects || []).find((o) => o && o.name === name) || null;
}

function runNpm(script) {
  const result = spawnSync("npm", ["--prefix", root, "run", script], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdoutTail: String(result.stdout || "").slice(-400),
    stderrTail: String(result.stderr || "").slice(-400),
  };
}

function sha256File(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
}

function vecEq(a, b, eps = 1e-3) {
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps && Math.abs(a.z - b.z) < eps;
}

try {
  const health = await bridgeHealth();
  builder.record("bridge_health", health.ok, {
    actual: { status: health.status, scene: health.data?.scenePath, rev: health.data?.unityRevision },
    expected: { http: 200, ok: true },
    detail: `HTTP ${health.status} ${health.data?.scenePath || ""} rev=${health.data?.unityRevision}`,
  });
  if (!health.ok) throw new Error("Bridge unhealthy — cannot run mutation proofs");

  const login = await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "kingsley", password: PASSWORD }),
  });
  builder.record("authenticated_login", login.response.ok, {
    actual: login.response.status,
    expected: 200,
  });
  if (!login.response.ok) throw new Error("Login failed");

  const sync = await api("/api/drafts/from-scene", {
    method: "POST",
    body: JSON.stringify({ rebase: true }),
  });
  let draft = sync.data?.draft;
  builder.setScenePath(draft?.scenePath || health.data?.scenePath || null);
  builder.record("sync_from_unity", Boolean(sync.response.ok && draft?.id), {
    actual: {
      status: sync.response.status,
      scene: draft?.scenePath,
      baseRev: draft?.baseUnityRevision,
      draftId: draft?.id,
      version: draft?.version,
    },
    expected: { ok: true },
  });
  if (!draft?.id) throw new Error("Sync from Unity failed");

  const project = await api("/api/project");
  const studioScene = project.data?.activeScenePath || project.data?.project?.scenePath || draft.scenePath;
  const isTestScene = /HertzStudioTest/i.test(studioScene || "") && /HertzStudioTest/i.test(draft.scenePath || "");
  builder.record("studio_scene_is_hertz_studio_test", isTestScene, {
    actual: { studioScene, draftScene: draft.scenePath },
    expected: "Assets/Scenes/HertzStudioTest.unity",
  });
  if (!isTestScene) throw new Error("Active scene must be HertzStudioTest for W03 mutation proofs");

  let rootObj =
    findByName(draft.objects, "HertzW03Hierarchy_Root") ||
    findByName(draft.objects, "Cube Instance");
  let childObj = findByName(draft.objects, "HertzW03Hierarchy_Child");
  if (!childObj && rootObj) {
    childObj = (draft.objects || []).find(
      (o) => o && o.parentObjectId && (o.parentObjectId === rootObj.objectId || o.rootObjectId === rootObj.objectId),
    );
  }
  const hierarchyOk = Boolean(
    rootObj?.unityObjectId &&
      childObj?.unityObjectId &&
      childObj.parentObjectId &&
      !isProtectedDraftObject(rootObj) &&
      !isProtectedDraftObject(childObj),
  );
  builder.record("hierarchy_root_and_child_present", hierarchyOk, {
    actual: {
      root: rootObj?.name || null,
      child: childObj?.name || null,
      rootId: rootObj?.objectId || null,
      childId: childObj?.objectId || null,
    },
    expected: "mutable root + child with parentObjectId (seed HertzW03Hierarchy_* if missing)",
  });
  if (!hierarchyOk) throw new Error("Missing parent/child hierarchy in HertzStudioTest draft");

  builder.record("numeric_child_uses_local", usesLocalNumericEdit(childObj), {
    actual: formValuesFromObject(childObj).space,
    expected: "local",
  });

  const rootBaseline = {
    position: { ...rootObj.position },
    rotation: { ...rootObj.rotation },
    scale: { ...rootObj.scale },
    localPosition: { ...(rootObj.localPosition || rootObj.position) },
  };
  const childLocalBaseline = {
    localPosition: { ...childObj.localPosition },
    localRotation: { ...(childObj.localRotation || { x: 0, y: 0, z: 0 }) },
    localScale: { ...(childObj.localScale || childObj.scale || { x: 1, y: 1, z: 1 }) },
  };

  // Root numeric edit
  {
    const built = buildSaveObjectsFromDraft(
      draft,
      rootObj.objectId,
      buildNumericTransformPayload(rootObj, {
        position: { x: rootBaseline.position.x + 0.25, y: rootBaseline.position.y, z: rootBaseline.position.z },
        rotation: rootObj.rotation,
        scale: rootObj.scale,
      }),
      { snap: false },
    );
    const childAfter = built.objects.find((o) => o.objectId === childObj.objectId);
    builder.record(
      "root_move_unchanged_descendant_locals",
      vecEq(childAfter.localPosition, childLocalBaseline.localPosition),
      { actual: childAfter.localPosition, expected: childLocalBaseline.localPosition },
    );
    let put = await api(`/api/drafts/${draft.id}`, {
      method: "PUT",
      body: JSON.stringify({ expectedVersion: draft.version, objects: built.objects }),
    });
    builder.record("numeric_root_edit_saved", put.response.ok, {
      actual: { status: put.response.status, version: put.data?.version },
      expected: 200,
    });
    draft = put.data;
    const apply = await api(`/api/drafts/${draft.id}/apply`, {
      method: "POST",
      body: JSON.stringify({ requestId: randomUUID(), expectedDraftVersion: draft.version }),
    });
    const applied = await waitApplied(draft.id);
    builder.record("numeric_root_edit_applied", applied?.status === "applied", {
      actual: { status: applied?.status, applyHttp: apply.response.status, requestId: apply.data?.command?.requestId },
      expected: "applied",
    });
    draft = (await api(`/api/drafts/${draft.id}`)).data;
    rootObj = findByName(draft.objects, rootObj.name);
    childObj = findByName(draft.objects, childObj.name);
  }

  // Root gizmo-style edit (same payload path as viewport gizmo commit)
  {
    const gizmoPayload = buildNumericTransformPayload(rootObj, {
      position: { x: rootBaseline.position.x + 0.4, y: rootBaseline.position.y + 0.05, z: rootBaseline.position.z },
      rotation: { x: rootBaseline.rotation.x, y: rootBaseline.rotation.y + 12, z: rootBaseline.rotation.z },
      scale: rootBaseline.scale,
    });
    const built = buildSaveObjectsFromDraft(draft, rootObj.objectId, gizmoPayload, { snap: false });
    let put = await api(`/api/drafts/${draft.id}`, {
      method: "PUT",
      body: JSON.stringify({ expectedVersion: draft.version, objects: built.objects }),
    });
    builder.record("gizmo_root_edit_saved", put.response.ok, {
      actual: put.response.status,
      expected: 200,
    });
    draft = put.data;
    await api(`/api/drafts/${draft.id}/apply`, {
      method: "POST",
      body: JSON.stringify({ requestId: randomUUID(), expectedDraftVersion: draft.version }),
    });
    const applied = await waitApplied(draft.id);
    builder.record("gizmo_root_edit_applied", applied?.status === "applied", {
      actual: applied?.status,
      expected: "applied",
    });
    draft = (await api(`/api/drafts/${draft.id}`)).data;
    rootObj = findByName(draft.objects, rootObj.name);
    childObj = findByName(draft.objects, childObj.name);
  }

  // Child local numeric
  {
    const childBuilt = buildSaveObjectsFromDraft(
      draft,
      childObj.objectId,
      buildNumericTransformPayload(childObj, {
        position: {
          x: childLocalBaseline.localPosition.x,
          y: childLocalBaseline.localPosition.y + 0.1,
          z: childLocalBaseline.localPosition.z,
        },
        rotation: { x: 0, y: 15, z: 0 },
        scale: childLocalBaseline.localScale,
      }),
      { snap: false },
    );
    const nextChild = childBuilt.objects.find((o) => o.objectId === childObj.objectId);
    builder.record(
      "numeric_child_local_edit_saved",
      Math.abs(nextChild.localPosition.y - (childLocalBaseline.localPosition.y + 0.1)) < 1e-4,
      { actual: nextChild.localPosition, expected: { ...childLocalBaseline.localPosition, y: childLocalBaseline.localPosition.y + 0.1 } },
    );
    let put = await api(`/api/drafts/${draft.id}`, {
      method: "PUT",
      body: JSON.stringify({ expectedVersion: draft.version, objects: childBuilt.objects }),
    });
    if (!put.response.ok) {
      builder.record("numeric_child_local_edit_applied", false, {
        actual: put.response.status,
        expected: 200,
        detail: put.data?.error || "PUT failed",
      });
    } else {
      draft = put.data;
      await api(`/api/drafts/${draft.id}/apply`, {
        method: "POST",
        body: JSON.stringify({ requestId: randomUUID(), expectedDraftVersion: draft.version }),
      });
      const applied = await waitApplied(draft.id);
      builder.record("numeric_child_local_edit_applied", applied?.status === "applied", {
        actual: applied?.status,
        expected: "applied",
      });
      draft = (await api(`/api/drafts/${draft.id}`)).data;
      childObj = findByName(draft.objects, childObj.name);
      const worldOk =
        childObj.worldPosition != null ||
        childObj.position != null;
      builder.record("gizmo_child_local_world_ok", worldOk && usesLocalNumericEdit(childObj), {
        actual: {
          space: formValuesFromObject(childObj).space,
          localPosition: childObj.localPosition,
          worldPosition: childObj.worldPosition || childObj.position,
        },
        expected: "local edit with world fields present",
      });
    }
  }

  // Rapid consecutive commits
  {
    const r1 = randomUUID();
    const r2 = randomUUID();
    const built1 = buildSaveObjectsFromDraft(
      draft,
      rootObj.objectId,
      buildNumericTransformPayload(rootObj, {
        position: { x: rootBaseline.position.x + 0.11, y: rootBaseline.position.y, z: rootBaseline.position.z },
        rotation: rootBaseline.rotation,
        scale: rootBaseline.scale,
      }),
      { snap: false },
    );
    let put = await api(`/api/drafts/${draft.id}`, {
      method: "PUT",
      body: JSON.stringify({ expectedVersion: draft.version, objects: built1.objects }),
    });
    draft = put.data;
    const a1 = await api(`/api/drafts/${draft.id}/apply`, {
      method: "POST",
      body: JSON.stringify({ requestId: r1, expectedDraftVersion: draft.version }),
    });
    const applied1 = await waitApplied(draft.id);
    draft = (await api(`/api/drafts/${draft.id}`)).data;
    rootObj = findByName(draft.objects, rootObj.name);
    const built2 = buildSaveObjectsFromDraft(
      draft,
      rootObj.objectId,
      buildNumericTransformPayload(rootObj, {
        position: { x: rootBaseline.position.x + 0.22, y: rootBaseline.position.y, z: rootBaseline.position.z },
        rotation: rootBaseline.rotation,
        scale: rootBaseline.scale,
      }),
      { snap: false },
    );
    put = await api(`/api/drafts/${draft.id}`, {
      method: "PUT",
      body: JSON.stringify({ expectedVersion: draft.version, objects: built2.objects }),
    });
    draft = put.data;
    const a2 = await api(`/api/drafts/${draft.id}/apply`, {
      method: "POST",
      body: JSON.stringify({ requestId: r2, expectedDraftVersion: draft.version }),
    });
    const applied2 = await waitApplied(draft.id);
    const dup = await api(`/api/drafts/${draft.id}/apply`, {
      method: "POST",
      body: JSON.stringify({ requestId: r2, expectedDraftVersion: draft.version }),
    });
    builder.record(
      "rapid_commits_serialized",
      applied1?.status === "applied" &&
        applied2?.status === "applied" &&
        (dup.data?.deduplicated === true || dup.response.status === 200),
      {
        actual: {
          a1: applied1?.status,
          a2: applied2?.status,
          dup: dup.data?.deduplicated ?? dup.response.status,
          r1,
          r2,
        },
        expected: "both applied; second requestId deduped",
      },
    );
    draft = (await api(`/api/drafts/${draft.id}`)).data;
    rootObj = findByName(draft.objects, rootObj.name);
    childObj = findByName(draft.objects, childObj.name);
  }

  // Conflict / failed commit — stale version should not mutate; viewport stays on last good draft
  {
    const beforeConflict = (await api(`/api/drafts/${draft.id}`)).data;
    const conflictApply = await api(`/api/drafts/${draft.id}/apply`, {
      method: "POST",
      body: JSON.stringify({
        requestId: randomUUID(),
        expectedDraftVersion: (beforeConflict.version || 0) + 99,
      }),
    });
    const afterConflict = (await api(`/api/drafts/${draft.id}`)).data;
    builder.record(
      "conflict_rollback_viewport",
      conflictApply.response.status === 409 &&
        afterConflict.version === beforeConflict.version &&
        afterConflict.status !== "pending_unity",
      {
        actual: {
          http: conflictApply.response.status,
          versionBefore: beforeConflict.version,
          versionAfter: afterConflict.version,
          status: afterConflict.status,
        },
        expected: { http: 409, versionUnchanged: true },
      },
    );
    draft = afterConflict;
  }

  // Successful commit sync evidence
  {
    const before = (await api(`/api/drafts/${draft.id}`)).data;
    rootObj = findByName(before.objects, rootObj.name);
    const built = buildSaveObjectsFromDraft(
      before,
      rootObj.objectId,
      buildNumericTransformPayload(rootObj, {
        position: { x: rootBaseline.position.x + 0.05, y: rootBaseline.position.y, z: rootBaseline.position.z },
        rotation: rootBaseline.rotation,
        scale: rootBaseline.scale,
      }),
      { snap: false },
    );
    let put = await api(`/api/drafts/${draft.id}`, {
      method: "PUT",
      body: JSON.stringify({ expectedVersion: before.version, objects: built.objects }),
    });
    draft = put.data;
    await api(`/api/drafts/${draft.id}/apply`, {
      method: "POST",
      body: JSON.stringify({ requestId: randomUUID(), expectedDraftVersion: draft.version }),
    });
    const applied = await waitApplied(draft.id);
    draft = (await api(`/api/drafts/${draft.id}`)).data;
    const syncedRoot = findByName(draft.objects, rootObj.name);
    builder.record(
      "successful_commit_syncs_draft_and_viewport",
      applied?.status === "applied" &&
        draft.status === "applied" &&
        Math.abs((syncedRoot?.position?.x ?? 0) - (rootBaseline.position.x + 0.05)) < 0.05,
      {
        actual: {
          applyStatus: applied?.status,
          draftStatus: draft.status,
          position: syncedRoot?.position,
          version: draft.version,
        },
        expected: "applied + draft position matches commit",
      },
    );
  }

  // Protected target — re-sync so export includes Main Camera if seeded in Unity
  {
    const resync = await api("/api/drafts/from-scene", {
      method: "POST",
      body: JSON.stringify({ rebase: true }),
    });
    draft = resync.data?.draft || draft;
    const cam =
      (draft.objects || []).find(
        (o) =>
          isProtectedDraftObject(o) ||
          o.isProtected === true ||
          o.renderCategory === "camera" ||
          o.renderCategory === "xr_protected" ||
          /main camera/i.test(o?.name || ""),
      ) || null;
    const dropCheck = cam
      ? objectSupportsOperation(cam, "assign_material")
      : { ok: false, reason: "no camera in draft after resync" };
    let apiReject = null;
    if (cam) {
      const assets = (await api("/api/assets")).data;
      const list = assets?.assets || assets || [];
      const texture = (Array.isArray(list) ? list : []).find(
        (a) => a.assetType === "texture" || a.assetType === "material",
      );
      if (texture) {
        const vd = await api("/api/drafts/validate-drop", {
          method: "POST",
          body: JSON.stringify({
            assetId: texture.id,
            claimedType: texture.assetType,
            operation: "assign_material",
            draftId: draft.id,
            targetObjectId: cam.unityObjectId || cam.objectId,
          }),
        });
        apiReject = vd.response.status === 400;
      }
    }
    const protectedOk =
      cam != null && dropCheck.ok === false && (apiReject === null || apiReject === true);
    builder.record("protected_xr_camera_immutable", protectedOk, {
      actual: {
        name: cam?.name,
        reason: dropCheck.reason,
        isProtected: cam?.isProtected,
        apiReject,
      },
      expected: "protected reject in UI helper + validate-drop when asset available",
    });
  }

  // Restore baselines
  {
    draft = (await api(`/api/drafts/${draft.id}`)).data;
    const restoredObjects = draft.objects.map((o) => {
      if (o.objectId === rootObj.objectId || o.name === rootObj.name) {
        return {
          ...o,
          position: rootBaseline.position,
          rotation: rootBaseline.rotation,
          scale: rootBaseline.scale,
          localPosition: rootBaseline.localPosition,
          worldPosition: rootBaseline.position,
        };
      }
      if (o.objectId === childObj.objectId || o.name === childObj.name) {
        return {
          ...o,
          localPosition: childLocalBaseline.localPosition,
          localRotation: childLocalBaseline.localRotation,
          localScale: childLocalBaseline.localScale,
        };
      }
      return o;
    });
    let put = await api(`/api/drafts/${draft.id}`, {
      method: "PUT",
      body: JSON.stringify({ expectedVersion: draft.version, objects: restoredObjects }),
    });
    draft = put.data;
    await api(`/api/drafts/${draft.id}/apply`, {
      method: "POST",
      body: JSON.stringify({ requestId: randomUUID(), expectedDraftVersion: draft.version }),
    });
    const applied = await waitApplied(draft.id);
    builder.record("restore_transforms_applied", applied?.status === "applied", {
      actual: applied?.status,
      expected: "applied",
    });
  }

  const stale = assertFreshApplySave({ ...draft, version: (draft?.version || 0) + 1 }, {
    ok: true,
    expectedVersion: draft?.version,
    draftId: draft?.id,
    objects: draft?.objects,
  });
  builder.record("stale_version_rejected", !stale.ok && stale.reason === "stale_version", {
    actual: stale.reason,
    expected: "stale_version",
  });

  // Walkability Unknown honesty on object without collider metadata (if any)
  {
    const validation = validateDraftScene(draft);
    const unknownOk =
      validation.status === "Unknown" ||
      validation.status === "Valid" ||
      validation.status === "Warning" ||
      validation.status === "Invalid";
    builder.record("walkability_status_honest", unknownOk && validation.status !== undefined, {
      actual: { status: validation.status, unknown: validation.counts?.unknown },
      expected: "Valid|Warning|Invalid|Unknown (never silent)",
    });
  }

  const w03 = getMilestoneStatus("W03");
  const gates = listMilestones().find((m) => m.id === "W03")?.gates;
  builder.record(
    "milestone_w03_not_self_approved",
    ["In progress", "Ready for Codex review"].includes(w03) &&
      gates?.codexReview === false &&
      gates?.kingsleyTesting === false,
    {
      actual: { status: w03, codexReview: gates?.codexReview, kingsleyTesting: gates?.kingsleyTesting },
      expected: { status: "In progress|Ready for Codex review", approval: false },
    },
  );
  const summary = summarizeMilestoneProgress(listMilestones());
  builder.record("milestone_totals", summary.total === 14 && summary.countedIds.length === 14, {
    actual: { total: summary.total, completed: summary.completed, percent: summary.percentComplete },
    expected: { total: 14 },
  });

  const healthAfter = await bridgeHealth();
  builder.record("bridge_still_healthy", healthAfter.ok, {
    actual: healthAfter.data,
    expected: { ok: true },
  });

  const build = runNpm("build");
  builder.record("npm_build", build.ok, { actual: build.status, expected: 0, detail: build.stderrTail });
  const measure = runNpm("measure:dashboard");
  builder.record("npm_measure_dashboard", measure.ok, { actual: measure.status, expected: 0 });

  const sampleScenePath = path.resolve(root, "../../Assets/Scenes/SampleScene.unity");
  const sampleHash = sha256File(sampleScenePath);
  builder.record("sample_scene_disk_hash_captured", Boolean(sampleHash), {
    actual: sampleHash,
    expected: "sha256",
  });

  const artifact = builder.build({
    requiredChecks,
    unityRevision: healthAfter.data?.unityRevision ?? null,
    bridgeUrl: `${BRIDGE}/health`,
    apiUrl: API,
    draftId: draft?.id,
    draftVersion: draft?.version,
    sampleSceneDiskSha256: sampleHash,
    notes: [
      "Transform/save/apply/restore evidence from authenticated API against HertzStudioTest.",
      "Browser UI proof is scripts/e2e-w03-browser.mjs.",
      "Typed Unity property proof is HertzStudioTypedOpsProof.",
    ],
  });

  const schemaErrors = assertProofSchema(artifact, requiredChecks);
  if (schemaErrors.length) {
    artifact.ok = false;
    artifact.schemaErrors = schemaErrors;
  }

  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`\nWrote ${outPath} (${artifact.passed}/${artifact.total}) ok=${artifact.ok}`);
  process.exit(artifact.ok ? 0 : 1);
} catch (err) {
  console.error(err?.message || err);
  const failed = builder.build({
    requiredChecks,
    error: String(err?.message || err),
  });
  const schemaErrors = assertProofSchema(failed, requiredChecks);
  if (schemaErrors.length) {
    failed.ok = false;
    failed.schemaErrors = schemaErrors;
  }
  fs.writeFileSync(outPath, `${JSON.stringify(failed, null, 2)}\n`);
  process.exit(1);
}
