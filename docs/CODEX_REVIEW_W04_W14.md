# Codex review package — W04 preserved + W08–W14 vertical correction

Generated: 2026-10-26T07:15:00Z  
Branch/HEAD: `main` / `7374e57c3f8cfef316a18d6606d5e1385b39170e`  
Implementation owner: Grok in Cursor  
Review owner: Codex  

## Verdict intent for this handoff

- **W04:** preserved / previously Codex-approved (`codexReview:true`). Weapons **43/43**.
- **W08–W14:** vertical API + Unity Editor command paths implemented to replace store-only scaffolding. Milestone gates remain **In progress** (`tasksComplete:false`, `automatedVerification:false`, `codexReview:false`). **Not Ready for Codex as completed milestones** until live Unity proofs after domain reload.
- No self-approval, public deploy, DNS mutation, or paid provisioning.

## Executive map

| ID | Vertical change | Local contracts | Live Unity |
|----|-----------------|-----------------|------------|
| W08 | Poly Haven download→library→import queue; materials/Terrain/HDRI Unity inspect/apply | pass | pending reload |
| W09 | FBX via Asset Library; Unity probe/assign; ignore posted humanoid/XR flags | pass | pending reload |
| W10 | Quest provenance required; static/editor via Unity endpoints | pass | pending reload |
| W11 | Unity-enumerated snapshots; reject caller content; hash revalidate | pass | pending reload |
| W12 | Unity revision + validate/apply/runtime ack | pass | pending reload |
| W13 | Aggregate requires suites + non-presence proofs | pass | n/a |
| W14 | Real secret→OS store; provider required; plan body rehash | pass | n/a |

## Hotspots

| File | Risk | Invariants | Tests |
|------|------|------------|-------|
| `polyhaven.mjs` `startPolyHavenImport` | high | no caller URL; never intent_recorded as imported | polyhaven.test |
| `materials.mjs` + `HertzStudioMaterialCommands.cs` | high | Unity Terrain/revision; SampleScene canonical ban | materials + sceneIdentity |
| `animation.mjs` + `/animation/*` | high | Unity Humanoid/clips; prior retained on fail | animation.test |
| `performance.mjs` | medium | no fake quest_device | performance.test |
| `snapshots.mjs` | high | no caller bytes; hash verify | snapshots.test |
| `encounters.mjs` | medium | Unity revision; versioned runtime | encounters.test |
| `deployPlan.mjs` | high | secret required for deposit; preview_only | deployPlan.test |

## Tests run

- `npm run regress:w08-w14` → passed (contract suites)
- W08–W14 focused API → **28/28**
- `node --test api/src/weapons.test.mjs` → **43/43**
- `npm run build` → pass
- `measure:dashboard` → **242143**/256000 underTarget
- `check:untracked` → ok
- SampleScene hash unchanged

## Claims not proven

Live Unity apply/capture/restore/encounter Play Mode after domain reload; real Poly Haven network download in CI; real Mixamo Adobe download; real Quest capture; public HTTPS/DNS/hosted auth.

## Rollback

Revert W08–W14 API modules + new Editor CS + server routes; restore prior gates (already In progress). Never git reset/clean.
