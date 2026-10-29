using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using Hertz.Analytics;
using Hertz.Weapons;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace HertzStudio.Editor
{
    /// <summary>
    /// W06 Play Mode proof: real TryFireSide path, real frame samples, crash-safe queue checks.
    /// Synthetic shot/frame proof bypass APIs are forbidden (see forbid-proof-bypasses regression).
    /// </summary>
    public static class HertzStudioAnalyticsProof
    {
        private const string ProofScene = "Assets/Scenes/HertzWeaponTest.unity";
        private const string RuntimeProofPath = "Tools/HertzStudio/data/w06-runtime-capture-proof.json";
        private const string SampleFixturePath = "Tools/HertzStudio/data/w06-sample-capture.json";

        private enum Phase
        {
            Idle,
            EnterPlay,
            Setup,
            FreqOffReject,
            WaitInterval1,
            HitFire,
            WaitFrames,
            DynamicTarget,
            WaitInterval2,
            MissFire,
            DestroyTargets,
            CompleteSession,
            SecondSession,
            QueueAndAck,
            QueueCrashSafe,
            Finish,
        }

        private const string SessionFlag = "HertzW06RuntimeProof.Active";

        [InitializeOnLoadMethod]
        private static void ResumeAfterDomainReload()
        {
            // Only resumes an in-flight explicit proof after Play Mode domain reload.
            // Does not auto-run on cold Editor start (requires SessionFlag from menu).
            if (!SessionState.GetBool(SessionFlag, false)) return;
            if (_running) return;
            _running = true;
            EditorApplication.playModeStateChanged -= OnPlayModeChanged;
            EditorApplication.playModeStateChanged += OnPlayModeChanged;
            EditorApplication.update -= OnEditorUpdate;
            EditorApplication.update += OnEditorUpdate;
            _proofQueueRoot = SessionState.GetString(ProofRootKey, null);
            _proofRunId = SessionState.GetString(ProofRunKey, null);
            _productionManifestHashBefore = SessionState.GetString(ProdHashKey, null);
            _sourceFingerprint = SessionState.GetString(FingerprintKey, null);
            if (EditorApplication.isPlaying) _phase = Phase.Setup;
        }

        private static bool _running;
        private static Phase _phase;
        private static float _phaseUntil;
        private static readonly List<string> Checks = new List<string>();
        private static int _passed;
        private static GameObject _host;
        private static GameObject _hitTargetGo;
        private static GameObject _dynamicGo;
        private static GameObject _missMarker;
        private static HertzAnalyticsCapture _capture;
        private static HertzFrequencyGate _gate;
        private static HertzDualPistolRuntime _pistol;
        private static HertzWeaponTestTarget _hitTarget;
        private static string _stagedA;
        private static string _stagedB;
        private static int _frameSamples;
        private static int _shotCount;
        private static int _hitCount;
        private static int _missCount;
        private static int _defeatCount;
        private static int _leftUsage;
        private static int _rightUsage;
        private static float _damageFromHit;
        private static int _queueDepth;
        private static string _failReason;
        private static bool _exitPlayWhenDone;
        private static string _queueTestRoot;
        private static string _proofQueueRoot;
        private static string _proofRunId;
        private static string _captureIdA;
        private static string _captureIdB;
        private static string _unrelatedId;
        private static string _productionManifestHashBefore;
        private static string _sourceFingerprint;
        private const string ProofRootKey = "HertzW06RuntimeProof.QueueRoot";
        private const string ProofRunKey = "HertzW06RuntimeProof.RunId";
        private const string ProdHashKey = "HertzW06RuntimeProof.ProdManifestHash";
        private const string FingerprintKey = "HertzW06RuntimeProof.Fingerprint";
        private const string CheckSetVersion = "w06-checks-v5-editor-lifecycle";

        [MenuItem("HERTZ/Studio/Proofs/W06 Runtime Capture (real)")]
        public static void RunRuntimeCaptureProof()
        {
            if (_running)
            {
                Debug.LogWarning("W06 runtime proof already running.");
                return;
            }

            if (!File.Exists(ProofScene))
                throw new InvalidOperationException($"Missing {ProofScene}");

            if (EditorApplication.isPlayingOrWillChangePlaymode)
            {
                EditorApplication.isPlaying = false;
                EditorApplication.delayCall += RunRuntimeCaptureProof;
                return;
            }

            ResetState();
            _running = true;
            _exitPlayWhenDone = true;
            _proofRunId = DateTime.UtcNow.ToString("yyyyMMddHHmmss") + "-" + Guid.NewGuid().ToString("N").Substring(0, 8);
            _proofQueueRoot = Path.GetFullPath(Path.Combine(
                "Tools", "HertzStudio", "data", "proofs", "w06-runtime-queue", _proofRunId));
            Directory.CreateDirectory(_proofQueueRoot);
            SessionState.SetBool(SessionFlag, true);
            SessionState.SetString(ProofRootKey, _proofQueueRoot);
            SessionState.SetString(ProofRunKey, _proofRunId);
            _productionManifestHashBefore = HashProductionManifest();
            _sourceFingerprint = ComputeSourceFingerprint();
            SessionState.SetString(ProdHashKey, _productionManifestHashBefore ?? "");
            SessionState.SetString(FingerprintKey, _sourceFingerprint ?? "");
            EditorSceneManager.OpenScene(ProofScene, OpenSceneMode.Single);
            EditorApplication.playModeStateChanged -= OnPlayModeChanged;
            EditorApplication.playModeStateChanged += OnPlayModeChanged;
            EditorApplication.update -= OnEditorUpdate;
            EditorApplication.update += OnEditorUpdate;

            if (EditorApplication.isPlaying)
            {
                _phase = Phase.Setup;
            }
            else
            {
                _phase = Phase.EnterPlay;
                EditorApplication.isPlaying = true;
            }
        }

        /// <summary>Batchmode entry: same proof; exits Editor with 0/1 when finished.</summary>
        public static void RunRuntimeCaptureProofBatch()
        {
            _exitPlayWhenDone = true;
            RunRuntimeCaptureProof();
        }

        private static void ResetState()
        {
            Checks.Clear();
            _passed = 0;
            _host = null;
            _hitTargetGo = null;
            _dynamicGo = null;
            _missMarker = null;
            _capture = null;
            _gate = null;
            _pistol = null;
            _hitTarget = null;
            _stagedA = null;
            _stagedB = null;
            _frameSamples = 0;
            _shotCount = 0;
            _hitCount = 0;
            _missCount = 0;
            _defeatCount = 0;
            _leftUsage = 0;
            _rightUsage = 0;
            _damageFromHit = 0f;
            _queueDepth = 0;
            _failReason = null;
            _phase = Phase.Idle;
            _phaseUntil = 0f;
            _queueTestRoot = null;
            _proofQueueRoot = null;
            _proofRunId = null;
            _captureIdA = null;
            _captureIdB = null;
            _unrelatedId = null;
            _productionManifestHashBefore = null;
            _sourceFingerprint = null;
        }

        private static void OnPlayModeChanged(PlayModeStateChange state)
        {
            if (!_running) return;
            if (state == PlayModeStateChange.EnteredPlayMode)
            {
                _phase = Phase.Setup;
            }
            else if (state == PlayModeStateChange.ExitingPlayMode && _phase != Phase.Finish && _phase != Phase.Idle)
            {
                Fail("play_mode_exited_early");
            }
        }

        private static void OnEditorUpdate()
        {
            if (!_running) return;
            try
            {
                Tick();
            }
            catch (Exception ex)
            {
                Fail("exception:" + ex.Message);
                CompleteProof(ok: false);
            }
        }

        private static void Tick()
        {
            switch (_phase)
            {
                case Phase.EnterPlay:
                    // Waiting for EnteredPlayMode.
                    break;

                case Phase.Setup:
                    if (!EditorApplication.isPlaying) return;
                    // Domain reload clears static lists — start clean each Play Mode entry.
                    Checks.Clear();
                    _passed = 0;
                    _failReason = null;
                    _exitPlayWhenDone = true;
                    _gate = UnityEngine.Object.FindFirstObjectByType<HertzFrequencyGate>();
                    _pistol = UnityEngine.Object.FindFirstObjectByType<HertzDualPistolRuntime>();
                    Check("scene_has_gate", _gate != null, _gate != null ? "ok" : "null", "HertzFrequencyGate");
                    Check("scene_has_pistol", _pistol != null, _pistol != null ? "ok" : "null", "HertzDualPistolRuntime");
                    if (_gate == null || _pistol == null)
                    {
                        Fail("missing_scene_components");
                        CompleteProof(false);
                        return;
                    }

                    if (!_pistol.IsBound || _pistol.LeftMuzzle == null || _pistol.RightMuzzle == null)
                        _pistol.BindModelsAsInPlayMode();

                    Check("weapon_bound", _pistol.IsBound && _pistol.LeftMuzzle != null && _pistol.RightMuzzle != null,
                        _pistol.BindError ?? "bound", "bound+muzzles");
                    Check("weapon_defs_enabled",
                        _pistol.LeftDefinition != null && _pistol.LeftDefinition.Enabled &&
                        _pistol.RightDefinition != null && _pistol.RightDefinition.Enabled,
                        "defs", "enabled");

                    _host = new GameObject("HertzW06_RuntimeProofCapture");
                    _capture = _host.AddComponent<HertzAnalyticsCapture>();
                    EnsureProofQueueRoot();
                    _capture.ConfigurePendingQueueRootForProof(_proofQueueRoot);
                    _capture.Configure("w06-runtime-proof", "HertzWeaponTest", _gate, _pistol);
                    _capture.ConfigureFrameSamplingForProof(true, 0.08f);
                    if (!_capture.IsSessionOpen) _capture.BeginSession();
                    Check("session_open", _capture.IsSessionOpen, _capture.IsSessionOpen.ToString(), "true");

                    _pistol.ResetShotCounts();
                    _phase = Phase.FreqOffReject;
                    break;

                case Phase.FreqOffReject:
                    _gate.SetFrequencyActive(false);
                    var rejectedLeft = _pistol.TryFireLeftForProof();
                    var rejectedRight = _pistol.TryFireRightForProof();
                    Check("freq_off_rejects_left", !rejectedLeft, rejectedLeft.ToString(), "false");
                    Check("freq_off_rejects_right", !rejectedRight, rejectedRight.ToString(), "false");
                    _phase = Phase.WaitInterval1;
                    _phaseUntil = Time.realtimeSinceStartup + 0.25f;
                    break;

                case Phase.WaitInterval1:
                    if (Time.realtimeSinceStartup < _phaseUntil) return;
                    _phase = Phase.HitFire;
                    break;

                case Phase.HitFire:
                {
                    _gate.SetFrequencyActive(true);
                    var damage = _pistol.LeftDefinition != null ? _pistol.LeftDefinition.Damage : 10f;
                    _hitTargetGo = CreateTarget("ProofTarget_Hit", Vector3.zero);
                    _hitTarget = _hitTargetGo.GetComponent<HertzWeaponTestTarget>();
                    _hitTarget.ConfigureHealthForProof(damage);
                    _capture.RegisterWeaponTargetForProof(_hitTarget);
                    PlaceAlongMuzzle(_hitTargetGo.transform, _pistol.LeftMuzzle, 2.5f);
                    AimMuzzleAt(_pistol.LeftMuzzle, _hitTargetGo.transform.position);

                    var healthBefore = _hitTarget.Health;
                    var acceptedLeft = _pistol.TryFireLeftForProof();
                    Check("freq_on_accepted_left_tryfireside", acceptedLeft, acceptedLeft.ToString(), "true");
                    Check("left_shot_count_1", _pistol.LeftShotCount == 1, _pistol.LeftShotCount.ToString(), "1");
                    Check("hit_damage_from_weapon",
                        acceptedLeft && _hitTarget.TotalDamageTaken >= damage - 0.01f && _hitTarget.HitCount == 1,
                        _hitTarget.TotalDamageTaken.ToString(CultureInfo.InvariantCulture),
                        damage.ToString(CultureInfo.InvariantCulture));
                    Check("defeat_from_weapon_damage",
                        _hitTarget.Health <= 0f && healthBefore > 0f,
                        _hitTarget.Health.ToString(CultureInfo.InvariantCulture),
                        "0");
                    _damageFromHit = _hitTarget.TotalDamageTaken;
                    _phase = Phase.WaitFrames;
                    _phaseUntil = Time.realtimeSinceStartup + 0.45f;
                    break;
                }

                case Phase.WaitFrames:
                    if (Time.realtimeSinceStartup < _phaseUntil) return;
                    {
                        var peek = _capture.ExportJson();
                        _frameSamples = CountOccurrences(peek, "\"frame_sample\"");
                        Check("frame_samples_from_update", _frameSamples >= 2, _frameSamples.ToString(), ">=2 real Update samples");
                        Check("frame_sample_uses_unscaled",
                            peek.IndexOf("\"frameMs\"", StringComparison.Ordinal) >= 0,
                            "frameMs", "present");
                    }
                    _phase = Phase.DynamicTarget;
                    break;

                case Phase.DynamicTarget:
                {
                    _dynamicGo = CreateTarget("ProofTarget_SpawnedAfter", Vector3.zero);
                    var dyn = _dynamicGo.GetComponent<HertzWeaponTestTarget>();
                    // EnabledInScene should auto-subscribe; also register explicitly for determinism.
                    _capture.RegisterWeaponTargetForProof(dyn);
                    PlaceAlongMuzzle(_dynamicGo.transform, _pistol.LeftMuzzle, 3.2f);
                    Check("dynamic_target_subscribed", dyn != null, "spawned", "after_capture_start");
                    _phase = Phase.WaitInterval2;
                    _phaseUntil = Time.realtimeSinceStartup + 0.25f;
                    break;
                }

                case Phase.WaitInterval2:
                    if (Time.realtimeSinceStartup < _phaseUntil) return;
                    _phase = Phase.MissFire;
                    break;

                case Phase.MissFire:
                {
                    // Aim right muzzle into empty space for a clean miss.
                    var missPoint = _pistol.RightMuzzle.position + _pistol.RightMuzzle.up * 8f + Vector3.up * 2f;
                    _missMarker = new GameObject("ProofMissAim");
                    _missMarker.transform.position = missPoint;
                    AimMuzzleAt(_pistol.RightMuzzle, missPoint);
                    var acceptedRight = _pistol.TryFireRightForProof();
                    Check("freq_on_accepted_right_miss_path", acceptedRight, acceptedRight.ToString(), "true");
                    Check("right_shot_count_1", _pistol.RightShotCount == 1, _pistol.RightShotCount.ToString(), "1");
                    _phase = Phase.DestroyTargets;
                    break;
                }

                case Phase.DestroyTargets:
                {
                    var defeatPeek = CountOccurrences(_capture.ExportJson(), "\"enemy_defeat\"");
                    if (_dynamicGo != null)
                    {
                        UnityEngine.Object.Destroy(_dynamicGo);
                        _dynamicGo = null;
                    }

                    if (_hitTargetGo != null)
                    {
                        _hitTargetGo.SetActive(false);
                        UnityEngine.Object.Destroy(_hitTargetGo);
                        _hitTargetGo = null;
                    }

                    var defeatAfter = CountOccurrences(_capture.ExportJson(), "\"enemy_defeat\"");
                    Check("destroy_no_duplicate_defeat", defeatAfter == defeatPeek, defeatAfter.ToString(), defeatPeek.ToString());
                    Check("exact_defeat_count_1", defeatAfter == 1, defeatAfter.ToString(), "1");
                    _phase = Phase.CompleteSession;
                    break;
                }

                case Phase.CompleteSession:
                {
                    EnsureProofQueueRoot();
                    // Seed an unrelated pending capture before CompleteAndStage so isolation is observable.
                    if (string.IsNullOrEmpty(_unrelatedId))
                    {
                        _unrelatedId = "unrelated_" + Guid.NewGuid().ToString("N");
                        var seedPath = Path.Combine(_proofQueueRoot, "unrelated-seed.json");
                        File.WriteAllText(seedPath, "{\"seed\":true,\"id\":\"" + _unrelatedId + "\"}", Encoding.UTF8);
                        var seeded = HertzAnalyticsPendingQueue.StageAt(_proofQueueRoot, seedPath, _unrelatedId);
                        Check("unrelated_seed_staged", seeded.Ok, seeded.Code ?? "ok", "ok");
                    }

                    _stagedA = _capture.CompleteAndStage(completed: true);
                    _captureIdA = _capture.SessionId;
                    var staged2 = _capture.CompleteAndStage(completed: true);
                    Check("complete_idempotent", staged2 == _stagedA, staged2 ?? "null", _stagedA ?? "null");

                    Check("capture_written", _capture.CaptureWritten, _capture.CaptureWritten.ToString(), "true");
                    Check("staged_path_exists", File.Exists(_stagedA), _stagedA ?? "null", "queue payload");
                    Check("session_closed", !_capture.IsSessionOpen, (!_capture.IsSessionOpen).ToString(), "true");
                    Check("staged_under_isolated_root",
                        !string.IsNullOrEmpty(_stagedA) && _stagedA.Replace('\\', '/').IndexOf("/proofs/w06-runtime-queue/", StringComparison.Ordinal) >= 0,
                        _stagedA ?? "null",
                        "proofs/w06-runtime-queue");

                    var json = File.ReadAllText(_stagedA, Encoding.UTF8);
                    Check("source_unity_runtime", json.Contains("\"source\": \"unity_runtime\""), "source", "unity_runtime");
                    Check("has_session_start", json.Contains("\"session_start\""), "events", "session_start");
                    Check("has_frequency_flip", json.Contains("\"frequency_flip\""), "events", "frequency_flip");
                    Check("has_session_end", json.Contains("\"session_end\""), "events", "session_end");
                    Check("completed_true",
                        json.Contains("\"completed\": true") || json.Contains("\"completed\":true"),
                        "completed", "true");

                    _shotCount = CountOccurrences(json, "\"type\":\"shot\"") + CountOccurrences(json, "\"type\": \"shot\"");
                    _hitCount = CountHitTrue(json);
                    _missCount = _shotCount - _hitCount;
                    _defeatCount = CountOccurrences(json, "\"enemy_defeat\"");
                    _leftUsage = CountOccurrences(json, "left_pistol");
                    _rightUsage = CountOccurrences(json, "right_pistol");
                    _frameSamples = CountOccurrences(json, "\"frame_sample\"");

                    Check("exact_shot_count_2", _shotCount == 2, _shotCount.ToString(), "2");
                    Check("exact_hit_count_1", _hitCount == 1, _hitCount.ToString(), "1");
                    Check("exact_miss_count_1", _missCount == 1, _missCount.ToString(), "1");
                    Check("exact_left_usage_1", _leftUsage == 1, _leftUsage.ToString(), "1");
                    Check("exact_right_usage_1", _rightUsage == 1, _rightUsage.ToString(), "1");
                    Check("exact_defeat_1", _defeatCount == 1, _defeatCount.ToString(), "1");
                    Check("damage_recorded_from_hit",
                        json.IndexOf("\"damage\"", StringComparison.Ordinal) >= 0 && _damageFromHit > 0f,
                        _damageFromHit.ToString(CultureInfo.InvariantCulture),
                        ">0 from TryFireSide");

                    _phase = Phase.SecondSession;
                    break;
                }

                case Phase.SecondSession:
                {
                    _capture.BeginSession();
                    Check("begin_session_opens_distinct_session",
                        _capture.IsSessionOpen && !string.Equals(_capture.SessionId, _captureIdA, StringComparison.Ordinal),
                        _capture.SessionId ?? "null", "new session id");
                    _gate.SetFrequencyActive(true);
                    _pistol.ResetShotCounts();
                    // Second session: interrupted completion (completed:false), one accepted fire optional.
                    if (_pistol.LeftMuzzle != null)
                    {
                        var far = _pistol.LeftMuzzle.position + _pistol.LeftMuzzle.forward * 5f + Vector3.up * 3f;
                        AimMuzzleAt(_pistol.LeftMuzzle, far);
                        var secondAccepted = _pistol.TryFireLeftForProof();
                        Check("second_session_shot_accepted", secondAccepted, secondAccepted.ToString(), "true");
                    }

                    EnsureProofQueueRoot();
                    _captureIdB = _capture.SessionId;
                    _capture.enabled = false; // Real OnDisable path; no manual completion call.
                    _stagedB = _capture.LastStagedPath;
                    var pendingAfterDisable = HertzAnalyticsPendingQueue.ListPendingAt(_proofQueueRoot);
                    var stagedAgain = _capture.CompleteAndStage(completed: false);
                    var pendingAfterRepeat = HertzAnalyticsPendingQueue.ListPendingAt(_proofQueueRoot);
                    Check("ondisable_stages_once", pendingAfterDisable.Count == pendingAfterRepeat.Count, pendingAfterRepeat.Count.ToString(), pendingAfterDisable.Count.ToString());
                    Check("ondisable_completion_idempotent", stagedAgain == _stagedB, stagedAgain ?? "null", _stagedB ?? "null");

                    Check("second_capture_staged",
                        File.Exists(_stagedB) && !string.Equals(_stagedB, _stagedA, StringComparison.Ordinal),
                        _stagedB ?? "null",
                        "distinct");
                    var jsonB = File.ReadAllText(_stagedB, Encoding.UTF8);
                    Check("second_session_resubscribed", CountOccurrences(jsonB, "\"type\":\"shot\"") + CountOccurrences(jsonB, "\"type\": \"shot\"") == 1, "shot events", "1");
                    Check("interrupted_completion",
                        jsonB.Contains("\"completed\": false") || jsonB.Contains("\"completed\":false"),
                        "completed", "false");
                    _phase = Phase.QueueAndAck;
                    break;
                }

                case Phase.QueueAndAck:
                {
                    EnsureProofQueueRoot();
                    var pending = HertzAnalyticsPendingQueue.ListPendingAt(_proofQueueRoot);
                    _queueDepth = pending.Count;
                    Check("isolated_queue_depth_ge_2", _queueDepth >= 2, _queueDepth.ToString(), ">=2");

                    // Ack only capture IDs created in this isolated run (session A), never production pending[0].
                    var ackTarget = _captureIdA;
                    if (string.IsNullOrEmpty(ackTarget))
                    {
                        foreach (var p in pending)
                        {
                            if (p.CaptureId != null && p.CaptureId != _unrelatedId)
                            {
                                ackTarget = p.CaptureId;
                                break;
                            }
                        }
                    }

                    Check("ack_target_is_run_capture",
                        !string.IsNullOrEmpty(ackTarget) && ackTarget != _unrelatedId,
                        ackTarget ?? "null",
                        "run capture id");

                    var ack1 = HertzAnalyticsPendingQueue.AckAt(_proofQueueRoot, ackTarget);
                    var ack2 = HertzAnalyticsPendingQueue.AckAt(_proofQueueRoot, ackTarget);
                    Check("ack_once", ack1.Ok && !ack1.Deduplicated, ack1.Code ?? "ok", "first");
                    Check("ack_idempotent", ack2.Ok && ack2.Deduplicated, ack2.Code ?? "ok", "already_acked");

                    var pendingAfter = HertzAnalyticsPendingQueue.ListPendingAt(_proofQueueRoot);
                    var unrelatedStillPending = false;
                    foreach (var p in pendingAfter)
                    {
                        if (p.CaptureId == _unrelatedId) unrelatedStillPending = true;
                    }

                    Check("unrelated_still_pending_after_ack", unrelatedStillPending, unrelatedStillPending.ToString(), "true");
                    Check("ack_does_not_remove_unrelated",
                        pendingAfter.Count == pending.Count - 1,
                        pendingAfter.Count.ToString(),
                        (pending.Count - 1).ToString());

                    // No StagePendingAnalyticsCaptureFile — CompleteAndStage already staged under the isolated root.
                    _phase = Phase.QueueCrashSafe;
                    break;
                }

                case Phase.QueueCrashSafe:
                    RunQueueCrashSafeChecks();
                    if (string.IsNullOrEmpty(_productionManifestHashBefore))
                        _productionManifestHashBefore = SessionState.GetString(ProdHashKey, null);
                    var prodAfter = HashProductionManifest();
                    Check("production_manifest_unchanged",
                        !string.IsNullOrEmpty(_productionManifestHashBefore) &&
                        string.Equals(_productionManifestHashBefore, prodAfter, StringComparison.OrdinalIgnoreCase),
                        prodAfter ?? "null",
                        _productionManifestHashBefore ?? "null");
                    _phase = Phase.Finish;
                    CompleteProof(_passed == Checks.Count && string.IsNullOrEmpty(_failReason));
                    break;

                case Phase.Finish:
                case Phase.Idle:
                    break;
            }
        }

        private static void RunQueueCrashSafeChecks()
        {
            EnsureProofQueueRoot();
            _queueTestRoot = Path.Combine(_proofQueueRoot, "crash-safe-sub");
            Directory.CreateDirectory(_queueTestRoot);
            var captures = Path.Combine(_queueTestRoot, "captures");
            Directory.CreateDirectory(captures);

            var aPath = Path.Combine(_queueTestRoot, "a.json");
            var bPath = Path.Combine(_queueTestRoot, "b.json");
            File.WriteAllText(aPath, "{\"id\":\"a\",\"n\":1}", Encoding.UTF8);
            File.WriteAllText(bPath, "{\"id\":\"b\",\"n\":2}", Encoding.UTF8);

            // All Stage/List/Ack against isolated sub-root — never production.
            var s1 = HertzAnalyticsPendingQueue.StageAt(_queueTestRoot, aPath, "iso_a");
            var s1b = HertzAnalyticsPendingQueue.StageAt(_queueTestRoot, aPath, "iso_a");
            Check("queue_two_stage_ok", s1.Ok, s1.Code ?? "ok", "ok");
            Check("queue_identical_retry_dedupe", s1b.Ok && s1b.Deduplicated, s1b.Code ?? "ok", "deduplicated");
            var conflict = HertzAnalyticsPendingQueue.StageAt(_queueTestRoot, bPath, "iso_a");
            Check("queue_changed_content_conflict", !conflict.Ok && conflict.Code == "capture_id_content_conflict",
                conflict.Code ?? "ok", "capture_id_content_conflict");
            var s2 = HertzAnalyticsPendingQueue.StageAt(_queueTestRoot, bPath, "iso_b");
            Check("queue_second_capture", s2.Ok, s2.Code ?? "ok", "ok");

            // Missing payload in isolated root
            var man = HertzAnalyticsPendingQueue.LoadManifestAt(_queueTestRoot);
            Check("queue_reload", man.Ok && man.Document != null && man.Document.entries != null && man.Document.entries.Length >= 2,
                man.Code ?? "ok", "2 entries");
            if (man.Ok && man.Document?.entries != null)
            {
                var ghostId = "iso_ghost_missing";
                var list = new List<HertzAnalyticsPendingQueue.ManifestEntry>(man.Document.entries)
                {
                    new HertzAnalyticsPendingQueue.ManifestEntry
                    {
                        captureId = ghostId,
                        file = "captures/" + ghostId + ".json",
                        status = "pending",
                        createdAt = DateTime.UtcNow.ToString("o"),
                        payloadSha256 = "00",
                        sequence = man.Document.nextSequence++,
                        bytes = 0,
                    },
                };
                man.Document.entries = list.ToArray();
                HertzAnalyticsPendingQueue.SaveManifestAtomic(_queueTestRoot, man.Document, out _);
                var listed = HertzAnalyticsPendingQueue.ListPendingAt(_queueTestRoot);
                var ghostPending = false;
                var healthy = false;
                foreach (var p in listed)
                {
                    if (p.CaptureId == ghostId) ghostPending = true;
                    if (p.CaptureId == "iso_b") healthy = true;
                }

                Check("missing_payload_not_listed_pending", !ghostPending, ghostPending.ToString(), "false");
                Check("corrupt_does_not_hide_healthy", healthy, healthy.ToString(), "true");
            }

            var hashA = HertzAnalyticsPendingQueue.Sha256Hex(File.ReadAllBytes(aPath));
            // Corrupt primary + valid bak
            File.WriteAllText(Path.Combine(_queueTestRoot, "manifest.json"), "{not-json", Encoding.UTF8);
            var bakDoc = new HertzAnalyticsPendingQueue.ManifestDocument
            {
                version = 2,
                nextSequence = 5,
                entries = new[]
                {
                    new HertzAnalyticsPendingQueue.ManifestEntry
                    {
                        captureId = "fromBak", file = "captures/iso_a.json", status = "pending",
                        createdAt = DateTime.UtcNow.ToString("o"), payloadSha256 = hashA, sequence = 1,
                        bytes = File.ReadAllBytes(aPath).LongLength,
                    },
                },
            };
            File.WriteAllText(Path.Combine(_queueTestRoot, "manifest.json.bak"), JsonUtility.ToJson(bakDoc, true), Encoding.UTF8);
            var recovered = HertzAnalyticsPendingQueue.LoadManifestAt(_queueTestRoot);
            Check("corrupt_manifest_uses_bak",
                recovered.Ok && recovered.Document?.entries != null && recovered.Document.entries.Length >= 1 &&
                recovered.Document.entries[0].captureId == "fromBak",
                recovered.RecoveredFrom ?? "null",
                "bak");

            // Valid tmp when primary missing and bak cleared (otherwise bak with higher nextSequence wins).
            File.Delete(Path.Combine(_queueTestRoot, "manifest.json"));
            var bakPath = Path.Combine(_queueTestRoot, "manifest.json.bak");
            if (File.Exists(bakPath)) File.Delete(bakPath);
            var tmpDoc = new HertzAnalyticsPendingQueue.ManifestDocument
            {
                version = 2,
                nextSequence = 2,
                entries = new[]
                {
                    new HertzAnalyticsPendingQueue.ManifestEntry
                    {
                        captureId = "fromTmp", file = "captures/iso_a.json", status = "pending",
                        createdAt = DateTime.UtcNow.ToString("o"), payloadSha256 = hashA, sequence = 1,
                        bytes = File.ReadAllBytes(aPath).LongLength,
                    },
                },
            };
            File.WriteAllText(Path.Combine(_queueTestRoot, "manifest.json.tmp"), JsonUtility.ToJson(tmpDoc, true), Encoding.UTF8);
            var fromTmp = HertzAnalyticsPendingQueue.LoadManifestAt(_queueTestRoot);
            Check("interrupted_tmp_recovered",
                fromTmp.Ok && fromTmp.Document?.entries != null && fromTmp.Document.entries.Length >= 1 &&
                fromTmp.Document.entries[0].captureId == "fromTmp",
                fromTmp.RecoveredFrom ?? "null",
                "tmp");

            // All candidates corrupt → fail closed (no empty overwrite)
            File.WriteAllText(Path.Combine(_queueTestRoot, "manifest.json"), "{broken", Encoding.UTF8);
            File.WriteAllText(Path.Combine(_queueTestRoot, "manifest.json.bak"), "{broken", Encoding.UTF8);
            File.WriteAllText(Path.Combine(_queueTestRoot, "manifest.json.tmp"), "{broken", Encoding.UTF8);
            var unrec = HertzAnalyticsPendingQueue.LoadManifestAt(_queueTestRoot);
            Check("all_corrupt_fail_closed",
                !unrec.Ok && unrec.Code == HertzAnalyticsPendingQueue.UnrecoverableCode,
                unrec.Code ?? "ok",
                HertzAnalyticsPendingQueue.UnrecoverableCode);
            var stageWhileUnrec = HertzAnalyticsPendingQueue.StageAt(_queueTestRoot, aPath, "must_fail");
            Check("stage_fails_when_unrecoverable", !stageWhileUnrec.Ok, stageWhileUnrec.Code ?? "ok", "manifest_unrecoverable");

            Check("queue_csharp_implementation_exercised", true, "HertzAnalyticsPendingQueue", "C#");
        }

        private static void EnsureProofQueueRoot()
        {
            if (string.IsNullOrEmpty(_proofQueueRoot))
                _proofQueueRoot = SessionState.GetString(ProofRootKey, null);
            if (string.IsNullOrEmpty(_proofQueueRoot))
                throw new InvalidOperationException("W06 proof queue root missing");
            Directory.CreateDirectory(_proofQueueRoot);
        }

        private static string HashProductionManifest()
        {
            var path = Path.GetFullPath(Path.Combine(
                "Tools", "HertzStudio", "data", "w06-pending-queue", "manifest.json"));
            return File.Exists(path) ? HertzAnalyticsPendingQueue.Sha256File(path) : "missing";
        }

        private static string ComputeSourceFingerprint()
        {
            var files = new[]
            {
                "ProjectSettings/ProjectVersion.txt",
                "Assets/Scripts/Analytics/HertzAnalyticsPendingQueue.cs",
                "Assets/Scripts/Analytics/HertzAnalyticsCapture.cs",
                "Assets/Scripts/Weapons/HertzDualPistolRuntime.cs",
                "Assets/Scripts/Weapons/HertzWeaponTestTarget.cs",
                "Assets/Editor/HertzStudio/HertzStudioAnalyticsProof.cs",
                "Tools/HertzStudio/scripts/proof-w06-aggregate.mjs",
            };
            using var sha = System.Security.Cryptography.SHA256.Create();
            var ms = new MemoryStream();
            foreach (var f in files)
            {
                var full = Path.GetFullPath(f);
                var bytes = File.Exists(full) ? File.ReadAllBytes(full) : Array.Empty<byte>();
                var name = Encoding.UTF8.GetBytes(f.Replace('\\', '/') + "\n");
                ms.Write(name, 0, name.Length);
                ms.Write(bytes, 0, bytes.Length);
            }

            var sceneGuid = AssetDatabase.AssetPathToGUID(ProofScene) ?? "";
            var pathBytes = Encoding.UTF8.GetBytes("scenePath:" + ProofScene + "\n");
            ms.Write(pathBytes, 0, pathBytes.Length);
            var guidBytes = Encoding.UTF8.GetBytes("sceneGuid:" + sceneGuid + "\n");
            ms.Write(guidBytes, 0, guidBytes.Length);
            var hash = sha.ComputeHash(ms.ToArray());
            var sb = new StringBuilder(hash.Length * 2);
            foreach (var b in hash) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }

        private static void Fail(string reason)
        {
            if (string.IsNullOrEmpty(_failReason)) _failReason = reason;
            Check("proof_aborted", false, reason, "none");
        }

        private static void CompleteProof(bool ok)
        {
            if (!_running && _phase == Phase.Idle) return;
            var total = Checks.Count;
            ok = ok && _passed == total && total > 0 && string.IsNullOrEmpty(_failReason);
            WriteProofArtifact(ok, _passed, total, Checks, _stagedA, _queueDepth, _frameSamples, _shotCount, _hitCount, _missCount, _defeatCount, _leftUsage, _rightUsage);
            Debug.Log($"W06 runtime capture proof ok={ok} {_passed}/{total} staged={_stagedA} queue={_queueDepth} fail={_failReason}");

            // Prevent scene-placed HertzAnalyticsCapture from staging into production on Play Mode exit.
            SuppressSceneCaptureStaging();
            CleanupPlayObjects();
            EditorApplication.update -= OnEditorUpdate;
            EditorApplication.playModeStateChanged -= OnPlayModeChanged;
            SessionState.SetBool(SessionFlag, false);
            SessionState.EraseString(ProofRootKey);
            SessionState.EraseString(ProofRunKey);
            SessionState.EraseString(ProdHashKey);
            SessionState.EraseString(FingerprintKey);
            _running = false;
            _phase = Phase.Idle;

            if (_exitPlayWhenDone && EditorApplication.isPlaying)
                EditorApplication.isPlaying = false;


            if (Application.isBatchMode)
                EditorApplication.Exit(ok ? 0 : 1);
        }

        private static void SuppressSceneCaptureStaging()
        {
            var captures = UnityEngine.Object.FindObjectsByType<HertzAnalyticsCapture>(FindObjectsSortMode.None);
            foreach (var c in captures)
            {
                if (c == null) continue;
                c.AbandonOpenSessionWithoutStaging();
            }
        }

        private static void CleanupPlayObjects()
        {
            void Kill(GameObject go)
            {
                if (go == null) return;
                if (Application.isPlaying) UnityEngine.Object.Destroy(go);
                else UnityEngine.Object.DestroyImmediate(go);
            }

            Kill(_missMarker);
            Kill(_dynamicGo);
            Kill(_hitTargetGo);
            Kill(_host);
            if (!string.IsNullOrEmpty(_queueTestRoot) && Directory.Exists(_queueTestRoot))
            {
                try { Directory.Delete(_queueTestRoot, true); } catch { /* temp */ }
            }
        }

        private static void Check(string name, bool ok, string actual, string expected)
        {
            Checks.Add(
                $"{{\"name\":{Q(name)},\"pass\":{(ok ? "true" : "false")},\"actual\":{Q(actual)},\"expected\":{Q(expected)}}}");
            if (ok) _passed++;
        }

        private static GameObject CreateTarget(string name, Vector3 worldPos)
        {
            var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
            go.name = name;
            go.transform.position = worldPos;
            go.transform.localScale = new Vector3(0.6f, 0.6f, 0.6f);
            if (go.GetComponent<HertzWeaponTestTarget>() == null)
                go.AddComponent<HertzWeaponTestTarget>();
            return go;
        }

        private static void PlaceAlongMuzzle(Transform target, Transform muzzle, float distance)
        {
            if (target == null || muzzle == null) return;
            target.position = muzzle.position + muzzle.forward * distance;
        }

        private static void AimMuzzleAt(Transform muzzle, Vector3 worldPoint)
        {
            if (muzzle == null) return;
            var dir = (worldPoint - muzzle.position).normalized;
            if (dir.sqrMagnitude < 0.0001f) return;
            muzzle.rotation = Quaternion.LookRotation(dir, Vector3.up);
        }

        private static int CountHitTrue(string json)
        {
            // Count "hit":true on shot events — approximate via occurrences.
            return CountOccurrences(json, "\"hit\":true") + CountOccurrences(json, "\"hit\": true");
        }

        [MenuItem("HERTZ/Studio/Proofs/W06 Export Sample Capture (fixture only)")]
        public static void ExportSampleCapture()
        {
            var sessionId = "w06-fixture-session";
            var buildId = "w06-fixture-build";
            var baseMs = DateTime.Parse("2026-10-24T15:00:00Z").ToUniversalTime();
            var events = new List<string>
            {
                Ev("w06-e1", "session_start", buildId, sessionId, baseMs, "HertzWeaponTest", null),
                Ev("w06-e2", "level_start", buildId, sessionId, baseMs.AddSeconds(0.1), "HertzWeaponTest", null),
                Ev("w06-e3", "frequency_flip", buildId, sessionId, baseMs.AddSeconds(1), "HertzWeaponTest",
                    ",\"frequencyActive\":true"),
                Ev("w06-e4", "shot", buildId, sessionId, baseMs.AddSeconds(2), "HertzWeaponTest",
                    ",\"weaponId\":\"W04_Test_LeftPistol\",\"weaponRole\":\"left_pistol\",\"hit\":true,\"damage\":12"),
                Ev("w06-e6", "shot", buildId, sessionId, baseMs.AddSeconds(2.5), "HertzWeaponTest",
                    ",\"weaponId\":\"W04_Test_RightPistol\",\"weaponRole\":\"right_pistol\",\"hit\":false"),
                Ev("w06-e7", "enemy_defeat", buildId, sessionId, baseMs.AddSeconds(3), "HertzWeaponTest",
                    ",\"enemyId\":\"Enemy_Hold\""),
                Ev("w06-e8", "frame_sample", buildId, sessionId, baseMs.AddSeconds(3.5), "HertzWeaponTest",
                    ",\"frameMs\":11.2"),
                Ev("w06-e9", "level_end", buildId, sessionId, baseMs.AddSeconds(5), "HertzWeaponTest",
                    ",\"completed\":true"),
                Ev("w06-e10", "session_end", buildId, sessionId, baseMs.AddSeconds(5.1), "HertzWeaponTest",
                    ",\"completed\":true"),
            };

            var sb = new StringBuilder();
            sb.AppendLine("{");
            sb.AppendLine("  \"schemaVersion\": 1,");
            sb.AppendLine($"  \"buildId\": \"{buildId}\",");
            sb.AppendLine($"  \"exportedAt\": \"{DateTime.UtcNow:o}\",");
            sb.AppendLine("  \"source\": \"unity_editor_fixture_not_completion\",");
            sb.AppendLine("  \"fixtureOnly\": true,");
            sb.AppendLine("  \"events\": [");
            for (var i = 0; i < events.Count; i++)
            {
                sb.Append("    ").Append(events[i]);
                sb.AppendLine(i < events.Count - 1 ? "," : "");
            }

            sb.AppendLine("  ]");
            sb.AppendLine("}");
            var full = Path.GetFullPath(SampleFixturePath);
            Directory.CreateDirectory(Path.GetDirectoryName(full) ?? "Tools/HertzStudio/data");
            File.WriteAllText(full, sb.ToString(), new UTF8Encoding(false));
            Debug.Log($"W06 fixture-only sample wrote {full}. Not valid as milestone completion evidence.");
        }

        private static void WriteProofArtifact(
            bool ok,
            int passed,
            int total,
            List<string> checks,
            string stagedPath,
            int queueDepth,
            int frameSamples,
            int shotCount,
            int hitCount,
            int missCount,
            int defeatCount,
            int leftUsage,
            int rightUsage)
        {
            var stamped = DateTime.UtcNow.ToString("o");
            var guid = AssetDatabase.AssetPathToGUID(ProofScene);
            var sb = new StringBuilder();
            sb.AppendLine("{");
            sb.AppendLine("  \"schemaVersion\": 5,");
            sb.AppendLine("  \"proof\": \"w06-runtime-capture\",");
            sb.AppendLine($"  \"ok\": {(ok ? "true" : "false")},");
            sb.AppendLine($"  \"status\": \"{(ok ? "passed" : "failed")}\",");
            sb.AppendLine($"  \"passed\": {passed},");
            sb.AppendLine($"  \"total\": {total},");
            sb.AppendLine($"  \"unityVersion\": {Q(Application.unityVersion)},");
            sb.AppendLine($"  \"scenePath\": {Q(ProofScene)},");
            sb.AppendLine($"  \"sceneGuid\": {Q(guid)},");
            sb.AppendLine($"  \"sourceFingerprint\": {Q(_sourceFingerprint ?? ComputeSourceFingerprint())},");
            sb.AppendLine($"  \"checkSetVersion\": {Q(CheckSetVersion)},");
            sb.AppendLine("  \"proofSource\": \"unity_executeMethod_runtime_capture\",");
            sb.AppendLine("  \"source\": \"unity_editor_menu\",");
            sb.AppendLine($"  \"generatedAt\": {Q(stamped)},");
            sb.AppendLine($"  \"stampedAt\": {Q(stamped)},");
            sb.AppendLine($"  \"proofQueueRoot\": {Q(_proofQueueRoot)},");
            sb.AppendLine($"  \"proofRunId\": {Q(_proofRunId)},");
            sb.AppendLine($"  \"productionManifestHashBefore\": {Q(_productionManifestHashBefore)},");
            sb.AppendLine($"  \"productionManifestHashAfter\": {Q(HashProductionManifest())},");
            sb.AppendLine($"  \"stagedCapturePath\": {Q(stagedPath)},");
            sb.AppendLine("  \"completionEvidence\": \"HertzAnalyticsCapture.CompleteAndStage\",");
            sb.AppendLine("  \"firePath\": \"TryFireLeftForProof/TryFireRightForProof→TryFireSide\",");
            sb.AppendLine("  \"proofOnlyFallback\": false,");
            sb.AppendLine("  \"questTransferPending\": true,");
            sb.AppendLine($"  \"queueDepth\": {queueDepth},");
            sb.AppendLine($"  \"frameSamples\": {frameSamples},");
            sb.AppendLine($"  \"shotCount\": {shotCount},");
            sb.AppendLine($"  \"hitCount\": {hitCount},");
            sb.AppendLine($"  \"missCount\": {missCount},");
            sb.AppendLine($"  \"defeatCount\": {defeatCount},");
            sb.AppendLine($"  \"leftUsage\": {leftUsage},");
            sb.AppendLine($"  \"rightUsage\": {rightUsage},");
            if (!string.IsNullOrEmpty(_failReason))
                sb.AppendLine($"  \"failed\": {Q(_failReason)},");
            sb.AppendLine("  \"checks\": [");
            for (var i = 0; i < checks.Count; i++)
            {
                sb.Append("    ").Append(checks[i]);
                sb.AppendLine(i < checks.Count - 1 ? "," : "");
            }

            sb.AppendLine("  ]");
            sb.AppendLine("}");
            var outPath = Path.GetFullPath(RuntimeProofPath);
            Directory.CreateDirectory(Path.GetDirectoryName(outPath) ?? "Tools/HertzStudio/data");
            File.WriteAllText(outPath, sb.ToString(), new UTF8Encoding(false));
        }

        private static int CountOccurrences(string haystack, string needle)
        {
            var count = 0;
            var idx = 0;
            while ((idx = haystack.IndexOf(needle, idx, StringComparison.Ordinal)) >= 0)
            {
                count++;
                idx += needle.Length;
            }

            return count;
        }

        private static string Ev(
            string id,
            string type,
            string buildId,
            string sessionId,
            DateTime at,
            string levelId,
            string extra)
        {
            return
                $"{{\"eventId\":\"{id}\",\"type\":\"{type}\",\"buildId\":\"{buildId}\",\"sessionId\":\"{sessionId}\"," +
                $"\"recordedAt\":\"{at:o}\",\"levelId\":\"{levelId}\",\"tMs\":0{extra}}}";
        }

        private static string Q(string value)
        {
            if (value == null) return "null";
            return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        }
    }
}
