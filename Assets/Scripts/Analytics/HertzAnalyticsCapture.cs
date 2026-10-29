using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using Hertz.Characters;
using Hertz.Weapons;
using UnityEngine;

namespace Hertz.Analytics
{
    /// <summary>
    /// W06 local playtest capture — batches approved events for Studio import.
    /// No personal identifiers. Bounded event list. Runtime must not reference UnityEditor.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class HertzAnalyticsCapture : MonoBehaviour
    {
        public const int MaxEvents = 5000;
        public const int MaxRetainedPendingFiles = 32;
        public const string SchemaVersion = "1";

        [SerializeField] private string buildId = "editor-dev";
        [SerializeField] private string levelId = "HertzWeaponTest";
        [SerializeField] private HertzFrequencyGate frequencyGate;
        [SerializeField] private HertzDualPistolRuntime dualPistol;
        [SerializeField] private bool sampleFrames = true;
        [SerializeField] private float frameSampleIntervalSeconds = 1f;

        private readonly List<EventRecord> _events = new List<EventRecord>(256);
        private readonly HashSet<HertzSpiritTarget> _spirits = new HashSet<HertzSpiritTarget>();
        private readonly HashSet<HertzWeaponTestTarget> _weaponTargets = new HashSet<HertzWeaponTestTarget>();
        private readonly HashSet<string> _defeatKeys = new HashSet<string>();

        private string _sessionId;
        private float _sessionStartRealtime;
        private float _nextFrameSample;
        private bool _sessionOpen;
        private bool _subscribed;
        private bool _captureWritten;
        private string _lastCapturePath;
        private string _lastStagedPath;
        private string _pendingQueueRootOverride;

        public string SessionId => _sessionId;
        public int EventCount => _events.Count;
        public string BuildId => buildId;
        public string LevelId => levelId;
        public bool IsSessionOpen => _sessionOpen;
        public bool CaptureWritten => _captureWritten;
        public string LastCapturePath => _lastCapturePath;
        public string LastStagedPath => _lastStagedPath;

        public void Configure(
            string captureBuildId,
            string captureLevelId,
            HertzFrequencyGate gate,
            HertzDualPistolRuntime pistol)
        {
            // Rebind after field assignment — OnEnable may have subscribed with null gate/pistol.
            Unsubscribe();
            if (!string.IsNullOrWhiteSpace(captureBuildId)) buildId = captureBuildId.Trim();
            if (!string.IsNullOrWhiteSpace(captureLevelId)) levelId = captureLevelId.Trim();
            frequencyGate = gate;
            dualPistol = pistol;
            Subscribe();
        }

        private void OnEnable()
        {
            Subscribe();
            if (!_sessionOpen) BeginSession();
        }

        private void OnDisable()
        {
            // Interrupted completion: end + write + stage once if not already written.
            // Contain filesystem exceptions so domain reload / shutdown cannot throw from OnDisable.
            try
            {
                if (_sessionOpen && !_captureWritten)
                {
                    CompleteAndStage(completed: false);
                }
                else
                {
                    Unsubscribe();
                    if (_sessionOpen) EndSession(completed: false);
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"HertzAnalyticsCapture.OnDisable staging failed (retryable state preserved): {ex.Message}");
                try { Unsubscribe(); } catch { /* shutdown */ }
                try { if (_sessionOpen) EndSession(completed: false); } catch { /* shutdown */ }
            }
        }

        private void Update()
        {
            if (!_sessionOpen || !sampleFrames) return;
            if (Time.unscaledTime < _nextFrameSample) return;
            _nextFrameSample = Time.unscaledTime + Mathf.Max(0.25f, frameSampleIntervalSeconds);
            Record("frame_sample", frameMs: Time.unscaledDeltaTime * 1000f);
        }

        /// <summary>Assign an isolated queue root to this capture only. Production captures leave this unset.</summary>
        public void ConfigurePendingQueueRootForProof(string queueRoot)
        {
            if (string.IsNullOrWhiteSpace(queueRoot))
                throw new ArgumentException("queue root required", nameof(queueRoot));
            _pendingQueueRootOverride = Path.GetFullPath(queueRoot);
            Directory.CreateDirectory(_pendingQueueRootOverride);
        }

        /// <summary>Editor/proof helper: ensure a dynamically created target is subscribed.</summary>
        public void RegisterWeaponTargetForProof(HertzWeaponTestTarget target) => AttachWeaponTarget(target);

        /// <summary>Proof helper: tighten frame sampling so Play Mode Update records real unscaledDeltaTime samples.</summary>
        public void ConfigureFrameSamplingForProof(bool enabled, float intervalSeconds)
        {
            sampleFrames = enabled;
            frameSampleIntervalSeconds = Mathf.Max(0.05f, intervalSeconds);
            _nextFrameSample = 0f;
        }

        /// <summary>
        /// Proof isolation: close an open session without staging to the pending queue.
        /// Prevents scene-placed captures from polluting production on Play Mode exit.
        /// </summary>
        public void AbandonOpenSessionWithoutStaging()
        {
            try { Unsubscribe(); } catch { /* proof cleanup */ }
            _sessionOpen = false;
            _captureWritten = true;
            _lastStagedPath = null;
        }

        public void BeginSession()
        {
            // Never erase an un-staged previous capture. A failed OnDisable stage leaves the
            // written file retryable; do not clear that pointer until staging succeeds.
            if (!_sessionOpen && !_captureWritten &&
                !string.IsNullOrEmpty(_lastCapturePath) && File.Exists(_lastCapturePath))
            {
                try { CompleteAndStage(completed: false); }
                catch (Exception ex)
                {
                    Debug.LogWarning($"HertzAnalyticsCapture: prior written capture still cannot stage: {ex.Message}");
                    return;
                }
            }

            if (_sessionOpen && !_captureWritten)
            {
                try { CompleteAndStage(completed: false); }
                catch (Exception ex)
                {
                    Debug.LogWarning($"HertzAnalyticsCapture: prior session stage failed before BeginSession: {ex.Message}");
                    return;
                }
            }
            else if (_sessionOpen)
            {
                EndSession(completed: false);
            }

            _sessionId = Guid.NewGuid().ToString("N");
            _sessionStartRealtime = Time.realtimeSinceStartup;
            _sessionOpen = true;
            _captureWritten = false;
            _lastCapturePath = null;
            _lastStagedPath = null;
            _events.Clear();
            _defeatKeys.Clear();
            // CompleteAndStage unsubscribes the prior session. Public BeginSession must restore
            // runtime event subscriptions for the new session.
            Subscribe();
            Record("session_start");
            Record("level_start");
        }

        public void EndSession(bool completed)
        {
            if (!_sessionOpen) return;
            Record("level_end", completed: completed);
            Record("session_end", completed: completed);
            _sessionOpen = false;
        }

        /// <summary>
        /// Production completion path: end session exactly once, write capture, stage for connector.
        /// Idempotent — repeated calls return the prior path.
        /// </summary>
        public string CompleteAndStage(bool completed)
        {
            if (_captureWritten && !string.IsNullOrEmpty(_lastStagedPath) && File.Exists(_lastStagedPath))
            {
                return _lastStagedPath;
            }

            if (_sessionOpen) EndSession(completed);
            Unsubscribe();

            var written = !string.IsNullOrEmpty(_lastCapturePath) && File.Exists(_lastCapturePath)
                ? _lastCapturePath
                : WriteCaptureFile();
            _lastCapturePath = written;
            try
            {
                _lastStagedPath = string.IsNullOrEmpty(_pendingQueueRootOverride)
                    ? StagePendingCapture(written, _sessionId)
                    : StagePendingCaptureAt(_pendingQueueRootOverride, written, _sessionId);
                _captureWritten = true;
                return _lastStagedPath;
            }
            catch (Exception)
            {
                // Failed staging: keep retryable state (_captureWritten false, file on disk).
                _captureWritten = false;
                throw;
            }
        }

        public string ExportJson()
        {
            var sb = new StringBuilder(Math.Max(256, _events.Count * 120));
            sb.Append("{\n");
            sb.Append("  \"schemaVersion\": ").Append(SchemaVersion).Append(",\n");
            sb.Append("  \"buildId\": ").Append(JsonString(buildId)).Append(",\n");
            sb.Append("  \"exportedAt\": ").Append(JsonString(DateTime.UtcNow.ToString("o"))).Append(",\n");
            sb.Append("  \"source\": \"unity_runtime\",\n");
            sb.Append("  \"sessionId\": ").Append(JsonString(_sessionId)).Append(",\n");
            sb.Append("  \"levelId\": ").Append(JsonString(levelId)).Append(",\n");
            sb.Append("  \"completed\": ").Append(SessionCompletedFlag() ? "true" : "false").Append(",\n");
            sb.Append("  \"events\": [\n");
            for (var i = 0; i < _events.Count; i++)
            {
                AppendEvent(sb, _events[i]);
                if (i < _events.Count - 1) sb.Append(',');
                sb.Append('\n');
            }

            sb.Append("  ]\n}\n");
            return sb.ToString();
        }

        public string WriteCaptureFile()
        {
            var dir = Path.Combine(Application.persistentDataPath, "HertzAnalytics");
            Directory.CreateDirectory(dir);
            TrimRetained(dir);
            var name = $"HertzAnalytics_{buildId}_{_sessionId}_{DateTime.UtcNow:yyyyMMddHHmmss}.json";
            var path = Path.Combine(dir, name);
            File.WriteAllText(path, ExportJson(), new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            return path;
        }

        /// <summary>
        /// Runtime-safe durable queue staging via <see cref="HertzAnalyticsPendingQueue"/>.
        /// Immutable payload + SHA-256 + atomic manifest. Quest→Studio transfer remains pending.
        /// </summary>
        public static string StagePendingCapture(string sourcePath, string captureId = null)
        {
            var result = HertzAnalyticsPendingQueue.Stage(sourcePath, captureId);
            if (!result.Ok)
            {
                if (result.Code == "missing_source")
                    throw new FileNotFoundException(result.Message ?? "Analytics capture source missing.", sourcePath);
                throw new InvalidOperationException(result.Code + ": " + (result.Message ?? "stage failed"));
            }

            return result.FilePath;
        }

        private static string StagePendingCaptureAt(string queueRoot, string sourcePath, string captureId)
        {
            var result = HertzAnalyticsPendingQueue.StageAt(queueRoot, sourcePath, captureId);
            if (!result.Ok)
            {
                if (result.Code == "missing_source")
                    throw new FileNotFoundException(result.Message ?? "Analytics capture source missing.", sourcePath);
                throw new InvalidOperationException(result.Code + ": " + (result.Message ?? "stage failed"));
            }

            return result.FilePath;
        }

        public static string ResolvePendingQueueRoot() => HertzAnalyticsPendingQueue.ResolveQueueRoot();

        /// <summary>Legacy single-file path — prefer queue APIs.</summary>
        public static string ResolvePendingCapturePath()
        {
            return Path.Combine(Path.GetDirectoryName(ResolvePendingQueueRoot()) ?? ".", "w06-pending-capture.json");
        }

        public static IReadOnlyList<PendingCaptureInfo> ListPendingCaptures() =>
            HertzAnalyticsPendingQueue.ListPending();

        public static bool AckPendingCapture(string captureId) =>
            HertzAnalyticsPendingQueue.Ack(captureId).Ok;

        public struct PendingCaptureInfo
        {
            public string CaptureId;
            public string FilePath;
            public string Status;
        }

        private bool SessionCompletedFlag()
        {
            for (var i = _events.Count - 1; i >= 0; i--)
            {
                if (_events[i].Type == "session_end" && _events[i].Completed.HasValue)
                    return _events[i].Completed.Value;
            }

            return false;
        }

        private static void TrimRetained(string dir)
        {
            if (!Directory.Exists(dir)) return;
            var files = Directory.GetFiles(dir, "HertzAnalytics_*.json");
            if (files.Length <= MaxRetainedPendingFiles) return;
            Array.Sort(files, (a, b) => File.GetCreationTimeUtc(a).CompareTo(File.GetCreationTimeUtc(b)));
            var remove = files.Length - MaxRetainedPendingFiles;
            for (var i = 0; i < remove; i++)
            {
                try { File.Delete(files[i]); } catch { /* best-effort retention bound */ }
            }
        }

        private void Subscribe()
        {
            if (_subscribed) return;
            if (frequencyGate != null) frequencyGate.FrequencyChanged += OnFrequencyChanged;
            if (dualPistol != null) dualPistol.ShotAccepted += OnShotAccepted;

            HertzSpiritTarget.EnabledInScene += OnSpiritRegistered;
            HertzSpiritTarget.DisabledInScene += OnSpiritUnregistered;
            HertzWeaponTestTarget.EnabledInScene += OnWeaponTargetRegistered;
            HertzWeaponTestTarget.DisabledInScene += OnWeaponTargetUnregistered;

            // Seed currently active targets once (no per-frame search).
            foreach (var spirit in FindObjectsByType<HertzSpiritTarget>(FindObjectsSortMode.None))
                AttachSpirit(spirit);
            foreach (var target in FindObjectsByType<HertzWeaponTestTarget>(FindObjectsSortMode.None))
                AttachWeaponTarget(target);

            _subscribed = true;
        }

        private void Unsubscribe()
        {
            if (!_subscribed) return;
            if (frequencyGate != null) frequencyGate.FrequencyChanged -= OnFrequencyChanged;
            if (dualPistol != null) dualPistol.ShotAccepted -= OnShotAccepted;

            HertzSpiritTarget.EnabledInScene -= OnSpiritRegistered;
            HertzSpiritTarget.DisabledInScene -= OnSpiritUnregistered;
            HertzWeaponTestTarget.EnabledInScene -= OnWeaponTargetRegistered;
            HertzWeaponTestTarget.DisabledInScene -= OnWeaponTargetUnregistered;

            foreach (var spirit in _spirits)
            {
                if (spirit != null) spirit.Defeated -= OnSpiritDefeated;
            }

            foreach (var target in _weaponTargets)
            {
                if (target != null) target.Defeated -= OnWeaponTestTargetDefeated;
            }

            _spirits.Clear();
            _weaponTargets.Clear();
            _subscribed = false;
        }

        private void OnSpiritRegistered(HertzSpiritTarget target) => AttachSpirit(target);

        private void OnSpiritUnregistered(HertzSpiritTarget target)
        {
            if (target == null) return;
            target.Defeated -= OnSpiritDefeated;
            _spirits.Remove(target);
        }

        private void OnWeaponTargetRegistered(HertzWeaponTestTarget target) => AttachWeaponTarget(target);

        private void OnWeaponTargetUnregistered(HertzWeaponTestTarget target)
        {
            if (target == null) return;
            target.Defeated -= OnWeaponTestTargetDefeated;
            _weaponTargets.Remove(target);
        }

        private void AttachSpirit(HertzSpiritTarget spirit)
        {
            if (spirit == null || !_spirits.Add(spirit)) return;
            spirit.Defeated -= OnSpiritDefeated;
            spirit.Defeated += OnSpiritDefeated;
        }

        private void AttachWeaponTarget(HertzWeaponTestTarget target)
        {
            if (target == null || !_weaponTargets.Add(target)) return;
            target.Defeated -= OnWeaponTestTargetDefeated;
            target.Defeated += OnWeaponTestTargetDefeated;
        }

        private void OnFrequencyChanged(bool active)
        {
            Record("frequency_flip", frequencyActive: active);
        }

        private void OnShotAccepted(HertzWeaponShotEvent shot)
        {
            var weaponId = shot.Definition != null ? shot.Definition.WeaponId : null;
            Record(
                "shot",
                weaponId: weaponId,
                weaponRole: RoleString(shot.Side),
                hit: shot.Hit,
                damage: shot.DamageApplied);
        }

        private void OnSpiritDefeated(HertzSpiritTarget target)
        {
            RecordEnemyDefeat(target != null ? target.GetInstanceID().ToString(CultureInfo.InvariantCulture) : null,
                target != null ? target.gameObject.name : null);
        }

        private void OnWeaponTestTargetDefeated(HertzWeaponTestTarget target)
        {
            RecordEnemyDefeat(target != null ? target.GetInstanceID().ToString(CultureInfo.InvariantCulture) : null,
                target != null ? target.gameObject.name : null);
        }

        private void RecordEnemyDefeat(string instanceKey, string enemyId)
        {
            var key = instanceKey ?? enemyId ?? Guid.NewGuid().ToString("N");
            if (!_defeatKeys.Add(key)) return; // exactly one enemy_defeat per target instance
            Record("enemy_defeat", enemyId: enemyId);
        }

        private static string RoleString(HertzWeaponDefinition.WeaponRole role)
        {
            return role == HertzWeaponDefinition.WeaponRole.RightPistol ? "right_pistol" : "left_pistol";
        }

        private void Record(
            string type,
            string weaponId = null,
            string weaponRole = null,
            string enemyId = null,
            bool? frequencyActive = null,
            bool? hit = null,
            float? damage = null,
            float? frameMs = null,
            bool? completed = null)
        {
            if (_events.Count >= MaxEvents) return;
            if (string.IsNullOrEmpty(_sessionId)) return;
            _events.Add(new EventRecord
            {
                EventId = Guid.NewGuid().ToString("N"),
                Type = type,
                BuildId = buildId,
                SessionId = _sessionId,
                LevelId = levelId,
                RecordedAt = DateTime.UtcNow.ToString("o"),
                TMs = (Time.realtimeSinceStartup - _sessionStartRealtime) * 1000f,
                WeaponId = weaponId,
                WeaponRole = weaponRole,
                EnemyId = enemyId,
                FrequencyActive = frequencyActive,
                Hit = hit,
                Damage = damage,
                FrameMs = frameMs,
                Completed = completed,
            });
        }

        private static void AppendEvent(StringBuilder sb, EventRecord e)
        {
            sb.Append("    {");
            sb.Append("\"eventId\":").Append(JsonString(e.EventId)).Append(',');
            sb.Append("\"type\":").Append(JsonString(e.Type)).Append(',');
            sb.Append("\"buildId\":").Append(JsonString(e.BuildId)).Append(',');
            sb.Append("\"sessionId\":").Append(JsonString(e.SessionId)).Append(',');
            sb.Append("\"recordedAt\":").Append(JsonString(e.RecordedAt)).Append(',');
            sb.Append("\"levelId\":").Append(JsonString(e.LevelId)).Append(',');
            sb.Append("\"tMs\":").Append(e.TMs.ToString("0.###", CultureInfo.InvariantCulture));
            if (e.WeaponId != null) sb.Append(",\"weaponId\":").Append(JsonString(e.WeaponId));
            if (e.WeaponRole != null) sb.Append(",\"weaponRole\":").Append(JsonString(e.WeaponRole));
            if (e.EnemyId != null) sb.Append(",\"enemyId\":").Append(JsonString(e.EnemyId));
            if (e.FrequencyActive.HasValue)
                sb.Append(",\"frequencyActive\":").Append(e.FrequencyActive.Value ? "true" : "false");
            if (e.Hit.HasValue) sb.Append(",\"hit\":").Append(e.Hit.Value ? "true" : "false");
            if (e.Damage.HasValue)
                sb.Append(",\"damage\":").Append(e.Damage.Value.ToString("0.###", CultureInfo.InvariantCulture));
            if (e.FrameMs.HasValue)
                sb.Append(",\"frameMs\":").Append(e.FrameMs.Value.ToString("0.###", CultureInfo.InvariantCulture));
            if (e.Completed.HasValue)
                sb.Append(",\"completed\":").Append(e.Completed.Value ? "true" : "false");
            sb.Append('}');
        }

        private static string JsonString(string value)
        {
            if (value == null) return "null";
            return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        }

        private struct EventRecord
        {
            public string EventId;
            public string Type;
            public string BuildId;
            public string SessionId;
            public string LevelId;
            public string RecordedAt;
            public float TMs;
            public string WeaponId;
            public string WeaponRole;
            public string EnemyId;
            public bool? FrequencyActive;
            public bool? Hit;
            public float? Damage;
            public float? FrameMs;
            public bool? Completed;
        }
    }
}
