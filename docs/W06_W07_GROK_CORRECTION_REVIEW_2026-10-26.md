# W06-W07 Grok correction review - 26 October 2026

## Verdict

- **W05:** unchanged and approved. It remains Ready for Kingsley testing.
- **W06:** corrections required. The Play Mode capture now uses the production fire path and real frame updates, but the proof mutates and acknowledges the live analytics queue. The queue recovery path can also discard its manifest after unrecoverable corruption.
- **W07:** corrections required. The Play Mode proof, monotonic sequence, and failed-versus-pending classifier are substantial improvements. A late acknowledgement for an older job can still overwrite the global result of a newer failed job, and the regression can reuse stale Unity proof artifacts after source changes.
- **W08-W14:** not reviewed in this bounded pass and must not be started from this handoff.

## Findings

### P0 - W06 proof can acknowledge an unrelated live capture and pollutes the production queue

`HertzStudioAnalyticsProof` calls `ListPendingCaptures()`, selects `pending[0]`, and acknowledges it twice. It does not restrict the acknowledgement to either capture created by the current proof. If a user's pending capture is older, running the proof marks that capture delivered without uploading it.

The same proof also:

- calls `CompleteAndStage`, then calls `StagePendingAnalyticsCaptureFile(_stagedA)`, staging the same capture again under another ID;
- runs duplicate/conflict checks through production `Stage(...)`, adding two `w06proof_*` records to the live queue;
- inserts a deliberately missing `ghost_*` record into the live manifest and leaves it marked corrupt.

The current manifest demonstrates the accumulation: 31 total records, including six pending `w06proof_*` entries and three corrupt `ghost_*` entries. Five sequence-zero records are already marked delivered after repeated proof runs. A proof must never consume or contaminate user data.

Fix this by making all queue operations accept an injected queue root or storage abstraction, running every proof-only stage/list/ack/corruption check in a temporary directory, and acknowledging only IDs created in that isolated run. Remove the redundant restage of `_stagedA`. Add a regression that seeds an unrelated pending record and proves its status and payload are unchanged after the proof.

### P1 - unrecoverable manifest corruption fails open and can lose queue metadata

`HertzAnalyticsPendingQueue.LoadManifest` returns a new empty manifest when the primary is corrupt and no valid backup can be parsed. `Stage` then proceeds and saves that empty document plus the new entry, orphaning prior payload files and losing their delivery state.

There is another crash window: `SaveManifestAtomic` copies the current primary to `.bak` without first proving the primary is valid. After recovery from a good backup, a later save can overwrite that backup with a corrupt primary before replacement completes. `LoadManifest` also ignores a valid `.tmp` whenever a primary file exists, even when that primary is corrupt.

Recovery must choose the newest valid primary/temp/backup candidate, preserve the last-known-good file, fail closed or rebuild deterministically from immutable payload metadata when none is valid, and never silently replace an unreadable queue with an empty one. Test the actual C# implementation or a shared implementation contract; the Node twin alone does not prove the Unity queue.

### P1 - W07 stale acknowledgement mutates the newer failed terminal result

The monotonic `sequence` fix correctly detects a newer job even when timestamps match. However, the stale-ack branch rewrites `sound.sync` for every late older acknowledgement. It preserves `state:"applied"`, but when the newer job is `failed` or `conflict`, the old acknowledgement changes the global state to `conflict` and replaces the newer error/request metadata with `stale_acknowledgement` data.

The existing failed-newer test checks only the returned stale code and the newer job status. It does not assert that the global sync state, last request ID, payload hash, error, and mappings remain identical to the newer terminal result.

Reject the old acknowledgement with HTTP 409 while leaving the authoritative global sync result and mappings unchanged. Store stale-attempt diagnostics separately if needed. Add applied, failed, and conflict newer-job regressions that compare the full global sync snapshot before and after the late acknowledgement.

### P1 - W06/W07 regressions can reuse stale Unity proof artifacts

W06 accepts an artifact for 72 hours based only on `generatedAt`; it has no source fingerprint. W07 has no age or source-fingerprint validation at all and reuses any authoritative passing artifact indefinitely. A later edit to the capture, queue, weapon, presenter, footstep, or proof code can therefore leave `regress:w06` or `regress:w07` green without rerunning Unity.

Add deterministic source fingerprints covering the runtime, proof, and persistence files used by each milestone. The aggregate must reject or rerun artifacts when the fingerprint, Unity version, scene identity, schema, or required check set no longer matches.

### P2 - obsolete synthetic proof bypasses remain despite the handoff claim

The handoff says `TryFrequencyGatedAcceptedShotForProof` and `RecordFrameSampleForProof` were removed. Both methods remain in production runtime scripts. The current W06/W07 artifacts do not use them, which is good, but leaving these bypasses available allows future proofs to emit accepted shots or fabricated frame samples without the production behavior.

Remove the unused bypass methods and add a source regression that forbids them. Keep the narrow `TryFireLeftForProof`/`TryFireRightForProof` wrappers only if existing W04 proof coverage still needs them; those wrappers call the real `TryFireSide` implementation.

## Accepted improvements

- All temporary `*KickOnce*` scripts and metas are gone.
- W06 enters Play Mode, uses `TryFireLeftForProof`/`TryFireRightForProof` into the real `TryFireSide` path, causes raycast damage and one real defeat, and samples frames from `Update` using `Time.unscaledDeltaTime`.
- W06 now has structured manifest records, immutable payload hashes, atomic temp/replace writes, idempotent acknowledgement, and healthy-entry isolation from missing payloads.
- W07 uses monotonic job sequences and has a same-timestamp regression.
- W07 classifies authoritative runtime failures as failed with exit code 1, while unavailable evidence remains pending with exit code 2.
- W07 enters Play Mode and exercises accepted shots through `TryFireSide` into `HertzWeaponShotClipPresenter`; the current artifact passes 19/19.
- W07 accurately remains pending for live connector delivery and Kingsley's audible/headset verification.
- Unity is out of Safe Mode; current Editor log scan found no C# compile errors.
- API health is HTTP 200 on port 8787 and Unity bridge health is HTTP 200 on port 8793.
- SampleScene SHA-256 remains `9FB1EFEAC51BD4AEE87A5DD23CD3613DB054EA41BC82977F0ADAF27CA5E5F4D9`.

## Independent verification

- `regress:w05`: exit 0 - characters 10/10, integration 3/3, web 182/182, aggregate 5/5.
- `regress:w06`: exit 0 - analytics 5/5, Node queue tests 5/5, web 182/182, aggregate 12/12. This does not approve W06 because the Unity proof has the destructive live-queue behavior above.
- `regress:w07`: wrapper exit 0 - sound 10/10, integration 3/3, web 182/182, semantics 10/10, assignment 6/6; aggregate remains pending 11/13 for connector delivery and manual verification.
- Production build: passed.
- Dashboard measurement: 242143/256000 gzip bytes, under target.
- W06 runtime artifact: passed 52/52, but rejected as safe completion evidence until queue isolation is fixed.
- W07 runtime artifact: passed 19/19; aggregate remains pending.
- Isolated stale-ack probe: before late ack the newer sync state was `failed` with `lastError:"newer_failed"`; after the old ack it became `conflict` with `code:"stale_acknowledgement"`, confirming the state-overwrite defect.

## Gate decision

- W05 keeps `automatedVerification:true` and `codexReview:true`.
- W06 keeps `tasksComplete:false`, `manualVerification:false`, `codexReview:false`, and `kingsleyTesting:false`; `automatedVerification` is reset to false until the proof is non-destructive and recovery is fail-closed.
- W07 keeps `tasksComplete:false`, `manualVerification:false`, `codexReview:false`, and `kingsleyTesting:false`; `automatedVerification` is reset to false until stale-ack state preservation and proof freshness are corrected.