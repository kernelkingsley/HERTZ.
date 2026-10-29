# W06/W07 correction batch and headset connection implementation self-review

Date: 2026-10-27
Scope: bounded W06/W07 corrections plus the Connections page headset status requirement. W08 was not started.
Review type: implementation self-review. This document is evidence for a later independent review; it does not set `codexReview`, `tasksComplete`, or completion gates.

## Outcome

- W06 real analytics lifecycle proof is fresh and passes 16/16. The Unity lifecycle artifact passes 62/62 and uses an isolated proof queue. Its production manifest hash is identical before and after the proof (`6909a594921cf9d3f486b4fb159ad58c4dca3b5b7f03b33817e9f85c04a3195e`).
- W07 automated/runtime evidence is fresh and passes 13/14. The only pending check is `manual_verification` for hearing the assigned shot sound in Play Mode/headset.
- The live connector receipt was produced by `live_studio_connector` after the fresh runtime proof. Request `w07-review-1793134169772` applied in Unity and was acknowledged by the API with payload hash `b650899a808e33ba0bc8a021fde92a6b8b1a3cd9141452fcf543d35b78b653c7`.
- Headset detection is independent of Unity connectivity. The final live state is `Disconnected`, `stale: false`, `blocking: false`, ADB available from `unity_android_sdk`, zero devices. Unity OpenXR runtime is reported separately.
- W06 and W07 milestone gates remain open: `tasksComplete`, `automatedVerification`, `manualVerification`, `codexReview`, and `kingsleyTesting` are still false.

## Corrections implemented

### W06 analytics lifecycle and proof isolation

- Removed global proof queue overrides and proof suppression switches from normal analytics code.
- Added instance-scoped proof queue configuration and explicit proof-root queue APIs.
- `HertzAnalyticsCapture.OnDisable` stages incomplete captures; completion is idempotent.
- The proof covers dynamic targets, normal completion, disable/incomplete staging, crash-safe queue recovery, acknowledgment, and production queue isolation.
- Proof freshness includes Unity version, source fingerprint, scene identity, schema, and check-set version.

### W07 runtime sound and delivery proof

- Runtime proof exercises real Play Mode firing and assigned shot clips.
- Connector delivery evidence requires a live connector source, exact request ID and payload hash, Unity application, API acknowledgment, and a receipt timestamp after the runtime proof.
- W07 proof cleanup explicitly abandons proof-created analytics sessions before Play Mode exit so proof runs do not add production captures.
- Aggregate exit semantics remain truthful: passed = 0, failed = 1, pending = 2. The regression wrapper accepts the known manual-only pending state without marking W07 complete.

### Headset connection status

- Added bounded ADB probing with fixed `adb devices -l` arguments, no shell interpolation, serial masking, and candidate order: configured path, `HERTZ_ADB_PATH`, PATH, `ANDROID_SDK_ROOT`, Unity Android SDK.
- Added normalized states: connected, authorization required, offline, disconnected, unavailable, and unknown/stale.
- API storage sanitizes reports and downgrades reports older than 20 seconds.
- Added separate ADB and Unity OpenXR runtime data. Active/configured loaders alone never claim a physical headset.
- Added the Headset card, recovery instructions, and nonblocking capability scoping on Connections.
- Added separate bounded Unity bridge timeouts. Health probes use 3.5 seconds so an unresponsive socket cannot prevent independent ADB polling; production Unity operations retain a 20 second default so scene export/import and feature synchronization are not cut off prematurely.

## Self-review findings fixed during this batch

1. Direct optional XR package imports could make the Editor fail to compile when those package assemblies were absent. Bridge XR reporting now uses core `UnityEngine.XR` plus reflection for optional loader/runtime types.
2. W07 proof teardown could stage a production analytics capture while leaving Play Mode. Proof-owned sessions are explicitly abandoned before exit.
3. The Connections card could display OpenXR model/transport values in the USB/ADB subsection. The UI now reads the nested ADB fields only.
4. An unresponsive Unity bridge could stall the connector before headset polling. Unity requests now abort within a bounded timeout, covered by a real local HTTP regression test.

## Follow-up self-review findings fixed

This follow-up review re-read the implementation rather than relying on the first passing regression output. Four additional defects were corrected before regenerating evidence:

1. **High - Unity operation timeout regression:** the original 3.5 second timeout applied to every Unity request, including scene export/import and feature synchronization. It now applies only to health probes; ordinary Unity operations use a separately bounded 20 second default.
2. **Medium - short serial disclosure:** the serial masker returned complete serials of four characters or fewer. Connector and API sanitization now always hide at least one original character, with regression coverage for one-, three-, and four-character inputs.
3. **Medium - analytics event subscription loss:** `CompleteAndStage` unsubscribes event handlers, but a later `BeginSession` did not restore them. `BeginSession` now resubscribes and refuses to clear a retryable unstaged capture. The Unity proof opens a second session, fires again, and verifies exactly one second-session shot was captured.
4. **Low - misleading W07 pending text:** aggregate and acceptance output claimed runtime proof was missing even after runtime passed. They now list the actual pending layer and say that only manual audible Play Mode/headset verification remains.
## Validation

| Check | Result |
| --- | --- |
| `npm run test:headset` | Node 23/23; Connections UI 7/7 |
| `npm run regress:w06` | Node 34/34; web 189/189; direct source check 239 files, 0 errors |
| Fresh W06 Unity lifecycle artifact | 62/62, including second-session resubscription |
| Final `npm run proof:w06-aggregate` | passed 16/16 |
| `npm run regress:w07` | sound 12/12; W05-W07 integration 3/3; web 189/189; proof decisions/freshness 26/26; assignment 6/6; source check 239 files, 0 errors |
| Final `npm run proof:w07-aggregate` | pending 13/14; only `manual_verification` |
| `npm run build` | passed; 2,129 modules transformed |
| `npm run measure:dashboard` | 242,918 gzip JS bytes, below 256,000 target; 3D remains outside HTML entry graph |
| API health | HTTP 200 |
| Unity bridge health | HTTP 200 on failover port 8794; `HertzWeaponTest`, revision 153; OpenXR loader/display/HMD all inactive |
| Connector | running; using Unity bridge port 8794 |
| Live headset | Disconnected; fresh; ADB available; zero devices; nonblocking |

The build still emits the existing warning for the lazy Three.js chunk over 500 kB. The dashboard measurement confirms that chunk is not part of the dashboard HTML entry graph.

## Remaining manual evidence

- W07: enter the intended Unity Play Mode test with speakers or a connected headset and confirm the assigned shot clip is audible once for each accepted shot and silent when the frequency gate rejects firing.
- Headset: connect a physical Android/OpenXR headset to exercise the live authorized USB, unauthorized, offline, wireless, and running OpenXR device states. Automated parsing, sanitization, stale handling, and all UI states are covered, but no physical headset was attached during this review.
- An independent reviewer must decide the milestone review gates. This implementation self-review intentionally leaves all W06/W07 review/completion fields unchanged.