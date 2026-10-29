# Codex takeover — 21 October 2026 ~01:20 UTC

Cursor stopped for credit-limit handoff. **Do not start W05. Do not self-pass.**

Canonical state: `WORK_PLAN.md` (Current checkpoint + Active task). This file mirrors the remaining queue Kingsley pasted so Codex can resume without chat history.

## Ownership

- Previous owner: Cursor (stopped editing; no further Unity mutations planned).
- Next owner: Codex on Kingsley’s explicit takeover.
- Workspace: `C:\Users\Kingsley\HERTZ` · branch `main` · HEAD `7374e57` (+ large uncommitted tree including `Tools/`, `Assets/Editor/HertzStudio/`, `WORK_PLAN.md`).

## Runtime (at handoff)

- Studio API: `http://127.0.0.1:8787/` (was 200)
- Unity bridge: `http://127.0.0.1:8791/health` (HertzStudioTest; revision was advancing)
- Connector PID file: `Tools/HertzStudio/data/connector.pid` (was 29196)
- Proofs: `Tools/HertzStudio/data/w03-place-safety-proof.json`, `w02-import-loop-proof.json`

## Already landed (do not redo blindly)

- W02 import staging outside Assets + naming (see WORK_PLAN W02).
- Place-safety core: dirty refuse, place idempotency, source confine, no SampleScene auto-select, confirm dialog (browser), GOID, transform parse in Unity.
- W03 partial: atomic enqueueApply; binding merge; prefab duplicate attempt (PropertyModification — **review finding: remapping unverified**).
- SampleScene Cursor Zombie Dog removed (GOID `…849424241`).

## Known gaps Codex must fix first (Priority 1)

1. `HashOperations` incomplete (material/op fields) — `HertzStudioSceneCommands.cs`
2. `expectedUnityRevision` not end-to-end from browser→job→connector
3. Connector manufactures `confirmSave:true` — must use stored confirmation only
4. Browser lacks place transform UI; job/connector must carry transforms
5. Prefab duplicate override remapping needs focused Unity tests
6. Binding merge version-safety (asset change / remove in flight)
7. Expand `regress:w03` package coverage

Then finish W03 #8–#14 and W04 #15–#20 per Kingsley’s full prompt in chat / WORK_PLAN Active task queue.

## Hygiene

- Never mutate SampleScene for proofs — use HertzStudioTest + dedicated weapon test scene.
- `SampleScene.scenetemplate` dependency rewrite: **ask Kingsley keep/revert** before changing.
- W02 full password e2e import still pending if `HERTZ_OWNER_PASSWORD` unset.

## First Codex actions

1. Read every `.cursor/rules/*.mdc`, `WORK_PLAN.md`, `docs/WEB_STUDIO_TASKS.md`, latest `docs/W02_*` reviews.
2. `git status --short` + inspect diffs vs checkpoint.
3. Implement Priority 1 findings 1–7 before viewport/weapons spectacle.
4. Update WORK_PLAN checkpoint before/after each step.
5. Hand back Ready for Codex review only after recording honest pending items — never self-pass.
