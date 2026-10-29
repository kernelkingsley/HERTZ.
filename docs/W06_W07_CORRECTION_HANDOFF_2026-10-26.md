# W06/W07 Codex-correction handoff — 26 Oct 2026

Owner: Grok in Cursor → Independent review: **Codex**  
Scope: bounded W06/W07 only. W05 unchanged. Do **not** begin W08. Do **not** self-set `codexReview` / Completed.

## Verdict for Codex

Corrections for the defects in `docs/W06_W07_GROK_CORRECTION_REVIEW_2026-10-26.md` are implemented and re-evidenced. Gates remain:

| Gate | W06 | W07 |
|------|-----|-----|
| tasksComplete | false | false |
| automatedVerification | false | false |
| manualVerification | false | false |
| codexReview | false | false |
| kingsleyTesting | false | false |

## Behavior before → after

| Defect | Before | After |
|--------|--------|-------|
| W06 proof queue | Used live `pending[0]`, restaged, wrote `ghost_*` into production | Isolated root `Tools/HertzStudio/data/proofs/w06-runtime-queue/<run-id>/` via `QueueRootScope`; acks only run IDs; no production `pending[0]` |
| Manifest recovery | Empty overwrite on corrupt | Fail-closed `manifest_unrecoverable`; prefer newest valid primary/tmp/bak; never clobber good bak with invalid primary |
| W07 stale ack | Rewrote `sound.sync` | Returns `stale_acknowledgement` + HTTP 409; preserves newer sync byte-for-byte; diagnostics in `staleAckAttempts` |
| Sequence migration | Duplicate seq risk on mixed stores | Unique reassignment; `nextJobSequence` strictly greater than every assigned |
| Artifact freshness | 72h timestamp only (W06) | Deterministic `sourceFingerprint` + `checkSetVersion` + schema; aggregate rejects stale/mismatch |
| Proof bypasses | Names still present | Removed; `forbid-proof-bypasses` regression |
| Editor Play exit | Scene `HertzAnalyticsCapture` (buildId `editor-dev`) auto-staged into production | Editor `OnDisable` no longer stages; Quest/player still auto-stages; proofs use explicit `CompleteAndStage` |

## Evidence

- **W06 runtime:** `ok=true` **58/58**, schema **4**, `checkSetVersion=w06-checks-v4-isolated`, Quest transfer **pending**
- **W06 aggregate:** **16/16** passed
- **W07 runtime:** `ok=true` **19/19**, schema **3**, `checkSetVersion=w07-checks-v3-playmode`, `connectorDelivery.ok=false` (pending)
- **W07 aggregate:** **pending** 12/14 (connector_delivery + manual_verification) — exit 2 accepted by wrapper
- **Unity:** 0 C# errors, not Safe Mode
- **API** `:8787/api/health` **200**; **bridge** `:8793/health` **200**
- **SampleScene SHA-256:** `9FB1EFEAC51BD4AEE87A5DD23CD3613DB054EA41BC82977F0ADAF27CA5E5F4D9`
- **KickOnce files:** **0**
- **HEAD:** `7374e57c3f8cfef316a18d6606d5e1385b39170e` (branch `main`)

### Production W06 manifest hashes

| Moment | SHA-256 |
|--------|---------|
| CP0 baseline | `E1E96449E61448676A7BEEEA9D0AC43A6DB845F9450C2AE0AF2AA9DD6B262902` |
| After pre-recompile accidental proof + scene OnDisable pollution | changed (see forensics) |
| After final isolated W06+W07 with Editor staging guard | `DFBBB9138E5924E25E1B54946D8F90D52982566DA6B77017F00BF73A2C496BC7` (unchanged across final proof pair) |

Final W06 artifact records `productionManifestHashBefore === productionManifestHashAfter` for that isolated run.

Forensic backup: `Tools/HertzStudio/data/forensics/w06-queue-baseline-2026-10-26T1642Z/`

### Source fingerprints (final artifacts)

- W06: see `data/w06-runtime-capture-proof.json` → `sourceFingerprint`
- W07: see `data/w07-sound-runtime-proof.json` → `sourceFingerprint`

## Checks run

- `regress:w04` — API 43 + web 182 + w04-extra 26; **stopped** at browser E2E (`HERTZ_OWNER_PASSWORD` missing) — historical
- `regress:w05` — exit **0**
- `regress:w06` — exit **0** (analytics 5 + queue 13 + forbid 4 + fingerprint 3 + web 182 + aggregate 16/16)
- `regress:w07` — exit **0** via pending ack (sound 12 + integration 3 + web 182 + semantics 10 + assign 6/6 + aggregate pending)
- `build` — pass; `measure:dashboard` gzip **242143**/256000; `check:untracked` ok; `milestone-gates.test` 5/5

## Changed files (primary)

- `Assets/Scripts/Analytics/HertzAnalyticsPendingQueue.cs` — QueueRootScope, fail-closed recovery, mutex, identical-retry payload verify
- `Assets/Scripts/Analytics/HertzAnalyticsCapture.cs` — abandon/suppress; Editor OnDisable does not stage
- `Assets/Editor/HertzStudio/HertzStudioAnalyticsProof.cs` — isolated proof root, schema 4 fingerprint, crash-safe C# checks, production hash guard
- `Assets/Editor/HertzStudio/HertzStudioSoundCommands.cs` — schema 3 fingerprint; suppress staging on exit
- `Tools/HertzStudio/api/src/sound.mjs` — stale-ack preserve + sequence migration (prior + tests)
- `Tools/HertzStudio/api/src/sound.test.mjs` — full stale-ack snapshots + mixed migration
- `Tools/HertzStudio/scripts/lib/analytics-queue.mjs` (+test) — Node twin fail-closed
- `Tools/HertzStudio/scripts/lib/proof-fingerprint.mjs` (+test)
- `Tools/HertzStudio/scripts/lib/forbid-proof-bypasses.test.mjs`
- `Tools/HertzStudio/scripts/proof-w06-aggregate.mjs`, `accept-w06-pending.mjs`, `proof-w07-aggregate.mjs`
- `Tools/HertzStudio/package.json`
- Proof JSON under `Tools/HertzStudio/data/`
- `WORK_PLAN.md`

## Historical queue pollution (not deleted)

Provable proof names still present from earlier runs: `w06proof_*`, `ghost_*`.  
Ambiguous / scene-driven `editor-dev` captures accumulated when Editor Play Mode exit auto-staged before the Editor OnDisable guard — **not deleted** (may include real captures). Codex may recommend a separate explicit cleanup command later.

## Remaining external / manual

1. Quest device → Studio analytics transfer (W06 still `questTransferPending`)
2. Live Studio connector sound delivery + API ack (`connectorDelivery` pending)
3. Audible / headset Kingsley confirmation (W07 manual)
4. Independent Codex review; then Kingsley testing
5. Do not start W08
