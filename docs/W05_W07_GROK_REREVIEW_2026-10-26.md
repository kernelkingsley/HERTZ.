# W05-W07 Grok correction re-review — 26 October 2026

## Verdict

- **CP1 compiler repair:** approved for the files Unity has actually imported. Unity is out of Safe Mode and bridge health is HTTP 200 on port 8793.
- **W05:** approved again and Ready for Kingsley testing. Fresh schema-3 Behavior and Sync artifacts pass 5/5, and independent `regress:w05` exits 0.
- **W06:** corrections still required. The durable queue is useful progress, but the proof does not establish the production firing/capture path and the queue implementation is not crash-safe.
- **W07:** API acknowledgement corrections are substantially improved, but runtime verification fails/is unstable. W07 remains In progress.
- **W08-W14:** unchanged from the preceding Codex review; their recorded corrections remain required.

## Blocking findings

### P0 — temporary InitializeOnLoad kick scripts remain in production source

The following saved files run automatically after domain reload and again in every new Unity Editor session because their guard is only `SessionState`:

- `HertzStudioBridgeKickOnce.cs`
- `HertzStudioW05ProofKickOnce.cs`
- `HertzStudioW06ProofKickOnce.cs`
- `HertzStudioW07ProofKickOnce.cs`

The proof kickers open dedicated scenes and run mutating proof commands without an explicit user/menu/test-run request. W06 also stages more analytics captures on startup. W07 has repeatedly been edited by changing its timestamp key, which deliberately reruns it. These are temporary execution helpers and must be removed, with their matching meta files, after the intended proof run. Keep the normal menu and explicit batch entry points.

### P1 — W06 aggregate overstates production runtime coverage

`HertzStudioAnalyticsProof` first calls `TryFireLeftForProof`/`TryFireRightForProof`, but when production binding or muzzle setup rejects the shot it falls back to `TryFrequencyGatedAcceptedShotForProof`. That fallback directly constructs and emits a shot event without the real interval, muzzle, raycast, damage, presenter, recoil, haptics, or target-hit path. A proof that completes through this fallback cannot claim real firing behavior.

Other proof weaknesses:

- Targets are defeated with direct `ApplyDamage(999f)`, independently of the shot.
- Frame timing is manually injected with fixed values through `RecordFrameSampleForProof`; it is not sampled over real elapsed frames.
- `leftUsage + rightUsage >= 0` always passes.
- The defeat assertion accepts either one or two rather than proving the expected exact deduplicated count.
- The second acknowledgement check is unconditional: `Check(..., true, ...)`.
- The proof restages the already staged capture without its capture ID, creating an extra queue item.
- Its “clear prior queue noise” comment does not clear or isolate the queue; the passing artifact reports depth four.

Therefore the fresh 27/27 artifact and W06 aggregate 12/12 are not sufficient for `automatedVerification:true`. The authoritative gate currently remains false, which is correct; the work-plan claim that it was set true is inconsistent with `milestone-gates.json`.

### P1 — W06 queue is not yet durable under interruption/corruption

The unique capture files and manifest are a good replacement for the single overwrite slot, but the manifest uses hand-built JSON string insertion and direct overwrite writes. A crash during the write can corrupt the whole queue. Listing silently skips missing payload files, and acknowledgement edits the first nearby status string without parsing and validating a structured record. There is no atomic temp-write/replace, lock/serialization, per-entry corruption result, payload hash, or tested manifest recovery.

The built-player comment also promises bridge pull or ADB, but the Editor bridge cannot directly enumerate a Quest device's `Application.persistentDataPath`. Keep Quest transfer pending until a real transfer/import path is implemented and proven.

### P1 — W07 runtime proof is not a production Play Mode proof

The latest Unity run failed while handling the footstep map. A later source edit attempted to fix the stale asset reference, but it has not produced a new authoritative artifact; `w07-sound-runtime-proof.json` is currently missing. The latest aggregate is only pending 11/13.

Even if the current edit passes, it drives `TryFrequencyGatedAcceptedShotForProof`, which directly emits an accepted event, and verifies `PresentCount` in Edit Mode. It does not fire through `TryFireSide`, does not prove input/muzzle/raycast behavior, and does not establish that assigned audio is actually audible in Play Mode. The proof artifact itself labels this proof-only path.

Use the real configured HertzWeaponTest runtime in Play Mode, exercise frequency off/on and real accepted shots, observe exactly one presenter delivery per accepted shot, and separately verify the explicit footstep mapping after reload.

### P1 — W07 failed runtime evidence is classified as pending

`evaluateW07AggregateStatus` treats any runtime artifact with `ok:false` as pending, including an authoritative `source:"unity_editor_menu", status:"failed"` artifact. Only API failures are passed into `failedChecks`. As a result a real failed Unity proof can be reported as pending and the `regress:w07` wrapper exits 0 through `accept-w07-pending.mjs`.

An authoritative runtime artifact with `status:"failed"`, failed named checks, or `ok:false` after an attempted run must make the aggregate failed and exit nonzero. Pending is only for unavailable/not-run evidence.

### P2 — W07 job ordering should not depend only on timestamps

The stale acknowledgement correction now considers terminal newer jobs, and duplicate request IDs correctly compare canonical payload hashes. Those fixes and their tests are good.

However, newer-job selection uses `Date.parse(createdAt) > jobCreated`. Two jobs created in the same millisecond are not ordered. Store a monotonic sequence/revision or use the authoritative append index and add a same-timestamp regression. Also select the latest superseding job deterministically.

## Accepted work

- The former Unity compile errors in material/animation commands were repaired.
- Unity bridge health is HTTP 200 on port 8793.
- API health is HTTP 200.
- W05 schema-3 identity/freshness validation and current proof artifacts pass.
- W07 request-ID payload conflict, unknown request, missing/mismatched hash, terminal-newer stale acknowledgement, and HTTP status mappings have meaningful tests.
- SampleScene SHA-256 remains `9FB1EFEAC51BD4AEE87A5DD23CD3613DB054EA41BC82977F0ADAF27CA5E5F4D9`.

## Independent verification

- `regress:w05`: exit 0 — API 10/10, integration 3/3, web 182/182, W05 aggregate 5/5.
- `regress:w06`: exit 0 — API 5/5, web 182/182, aggregate 12/12; rejected as completion evidence for the reasons above.
- `regress:w07`: exit 0 only through the explicit pending wrapper; sound API 9/9 and web 182/182 pass, aggregate pending 11/13.
- Production build: passed.
- Dashboard measurement: 242143/256000 gzip bytes, under target.
- API `:8787/api/health`: HTTP 200.
- Bridge `:8793/health`: HTTP 200.
- Current W07 authoritative runtime artifact: missing; the Editor log records the preceding failed run.
