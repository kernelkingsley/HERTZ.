# W06-W07 Grok correction re-review - 26 October 2026

## Verdict

- **W05:** unchanged and remains approved for Kingsley testing.
- **W06:** major queue-isolation and recovery defects are fixed, but the correction introduces an Editor data-loss regression. Keep every completion gate false.
- **W07:** stale acknowledgement preservation is fixed and the real runtime proof remains valid, but proof freshness/rerun behavior is incomplete. Keep every completion gate false; live connector delivery and Kingsley's audible/headset check also remain pending.
- Do not start W08 from this handoff.

## Findings

### P1 - ordinary interrupted Editor sessions are discarded instead of queued

`HertzAnalyticsCapture.OnDisable()` now calls `AbandonOpenSessionWithoutStaging()` whenever `Application.isEditor` is true. This applies to every normal Unity Play Mode session, not only W06/W07 proof objects. Exiting Play Mode early therefore drops the open analytics session instead of writing and staging the required `completed:false` capture.

The W06 proof does not catch this regression: its "interrupted" case calls `CompleteAndStage(completed:false)` explicitly while a temporary queue-root scope is active. It never proves that disabling an ordinary capture invokes the automatic interrupted-session path.

Restore automatic `OnDisable` staging in Editor and player builds. Isolate proofs per capture/operation instead of using `Application.isEditor` as a suppression condition. A practical shape is an instance-only queue-root override and an instance-only proof-cleanup flag. Existing scene captures may be explicitly suppressed/abandoned by the proof harness, while the proof capture uses its isolated root. Add a real Play Mode lifecycle check that disables an isolated capture without calling `CompleteAndStage` and verifies one `completed:false` pending record is written.

### P1 - Unity-version freshness is not independently validated

The correction claims artifacts are rejected when the Unity version no longer matches. W06 passes `runtime.unityVersion` back as its own expected value during the first validation and omits the version check during final validation. W07 never supplies an expected Unity version. `ProjectSettings/ProjectVersion.txt` is also absent from both fingerprint inputs.

An artifact generated under another Unity version can therefore remain fresh when its source fingerprint, schema, scene identity, and check set still match. Read the current project version from `ProjectSettings/ProjectVersion.txt` and compare the artifact against that value in both aggregates. Cover matching, mismatching, and missing versions in the fingerprint/freshness tests.

### P2 - stale proof rerun decisions occur before complete freshness validation

W07 decides whether to run Unity before it computes `w07Freshness`. A stale authoritative passing artifact therefore skips the forced Unity run. The later checks reject its Unity application layer, but `evaluateW07AggregateStatus` still summarizes the same stale runtime as `passed`, producing contradictory evidence. W06 has a related edge case: any authoritative failed artifact blocks a forced rerun even when that artifact is stale.

Compute freshness first. With the force flag set, rerun missing, pending, non-authoritative, stale, and fresh failed artifacts. Without the flag, represent stale evidence consistently as pending/unavailable or failed according to the documented contract; never report the runtime layer as passed. Preserve a fresh authoritative failure unless the caller explicitly requests a rerun. Add direct tests for stale passing and stale failed artifacts, force on/off, exit codes, and serialized layer status.

## Accepted corrections

- W06 proof data now uses an isolated proof root and acknowledges only capture IDs created by that run. The production manifest hash remained unchanged across the recorded runtime proof.
- Queue loading fails closed when primary/temp/backup are all corrupt, preserves a usable backup, validates identical retries, and exercises the real C# implementation for principal recovery cases.
- W07 late acknowledgements return conflict without mutating the newer global sync snapshot; applied, failed, and conflict terminal states are covered.
- Mixed legacy/current sound-job sequence migration produces unique monotonic sequences.
- Obsolete synthetic proof bypasses are removed and source-scanned.
- W06 runtime evidence is 58/58 and W07 runtime evidence is 19/19. W07 correctly remains pending for connector delivery and manual audible/headset verification.

## Independent verification

- `regress:w06`: exit 0; API 5/5, queue/fingerprint/bypass tests 20/20, web 182/182, aggregate 16/16.
- `regress:w07`: exit 0 through the documented pending wrapper; sound 12/12, integration 3/3, web 182/182, semantics 10/10, assignment 6/6, aggregate pending 12/14.
- Production build passed.
- Dashboard measurement passed at 242143/256000 first-party gzip bytes.
- API `:8787/api/health` returned HTTP 200.
- Unity bridge `:8793/health` returned HTTP 200 for `Assets/Scenes/HertzWeaponTest.unity`.
- The current tail of `Editor.log` contains successful assembly reload markers and no current compile error; older removed-bypass errors remain in historical log lines.
- W06/W07 milestone gates were already all false and remain unchanged.

## Next correction prompt

Use the prompt in the review response or this section verbatim. Keep the work bounded to the three findings above plus Kingsley's headset connection addendum below. Do not begin W08 and do not self-approve Codex review.

## User addendum - headset connection status

Kingsley additionally requires a dedicated **Headset** connection on the existing Connections page. Unity bridge availability and connector heartbeat are not proof that a headset is attached.

The local connector should probe Android/Quest device state without shell interpolation, with a short timeout and a bounded polling interval. It should distinguish ADB unavailable, no device, unauthorized, offline, and authorized/connected devices. Unity bridge health should separately expose whether an OpenXR loader, running XR display, or head-mounted input device is observable. The API should preserve both sources and derive a conservative display state without inventing connectivity.

The Connections card should show status, model/transport when known, last probe time, and concise setup/recovery text. Mask device serials. A disconnected headset is informational and must not block Asset Library, level editing, or other non-headset Studio work; it keeps only headset-dependent verification pending.
