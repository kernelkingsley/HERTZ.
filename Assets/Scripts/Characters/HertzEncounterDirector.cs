using System.Collections.Generic;
using Hertz.Weapons;
using UnityEngine;

namespace Hertz.Characters
{
    /// <summary>
    /// Play Mode encounter runner: after each marker delay, spawns a runtime enemy instance.
    /// Studio bridge can also force spawn/reset. Never parents under XR.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class HertzEncounterDirector : MonoBehaviour
    {
        private const string RuntimeSuffix = "_Runtime";

        [SerializeField] private string encounterId = "";
        [SerializeField] private bool autoStart = true;

        private readonly List<PendingSpawn> _pending = new List<PendingSpawn>(16);
        private bool _started;
        private int _spawnedCount;

        public string EncounterId => encounterId;
        public int SpawnedCount => _spawnedCount;
        public bool IsRunning => _started;

        public void Configure(string id, bool startAutomatically = true)
        {
            encounterId = id ?? "";
            autoStart = startAutomatically;
        }

        private void Start()
        {
            if (autoStart) Begin();
        }

        private void Update()
        {
            if (!_started || _pending.Count == 0) return;
            var dt = Time.deltaTime;
            for (var i = _pending.Count - 1; i >= 0; i--)
            {
                var item = _pending[i];
                item.Remaining -= dt;
                if (item.Remaining > 0f)
                {
                    _pending[i] = item;
                    continue;
                }

                SpawnFromMarker(item.Marker);
                _pending.RemoveAt(i);
            }
        }

        public void Begin()
        {
            if (_started) return;
            _started = true;
            _pending.Clear();
            var markers = GetComponentsInChildren<HertzEncounterSpawnMarker>(true);
            for (var i = 0; i < markers.Length; i++)
            {
                var marker = markers[i];
                if (marker == null) continue;
                _pending.Add(new PendingSpawn
                {
                    Marker = marker,
                    Remaining = marker.DelaySeconds,
                });
            }
        }

        public int SpawnAllImmediate()
        {
            var spawned = 0;
            var markers = GetComponentsInChildren<HertzEncounterSpawnMarker>(true);
            for (var i = 0; i < markers.Length; i++)
            {
                if (SpawnFromMarker(markers[i])) spawned++;
            }

            _started = true;
            _pending.Clear();
            return spawned;
        }

        public int ClearRuntimeSpawns()
        {
            var cleared = 0;
            for (var i = transform.childCount - 1; i >= 0; i--)
            {
                var child = transform.GetChild(i);
                if (child == null) continue;
                if (child.name.IndexOf(RuntimeSuffix, System.StringComparison.OrdinalIgnoreCase) < 0) continue;
                if (Application.isPlaying) Destroy(child.gameObject);
                else DestroyImmediate(child.gameObject);
                cleared++;
            }

            _spawnedCount = Mathf.Max(0, _spawnedCount - cleared);
            _pending.Clear();
            _started = false;
            return cleared;
        }

        private bool SpawnFromMarker(HertzEncounterSpawnMarker marker)
        {
            if (marker == null) return false;
            var instance = new GameObject($"EncounterSpawn_{marker.SpawnIndex}{RuntimeSuffix}");
            instance.transform.SetParent(transform, false);
            instance.transform.position = marker.transform.position;
            instance.transform.rotation = marker.transform.rotation;

            var profile = marker.EnemyProfile;
            var gate = FindFirstObjectByType<HertzFrequencyGate>();
            var player = ResolvePlayerTarget();
            var spirit = instance.AddComponent<HertzSpiritTarget>();
            spirit.Configure(gate, 30f);
            var agent = instance.AddComponent<HertzEnemyAgent>();
            if (profile != null)
                agent.Configure(profile, gate, player, System.Array.Empty<Transform>(), spirit);
            _spawnedCount++;
            return true;
        }

        private static Transform ResolvePlayerTarget()
        {
            var proxy = GameObject.Find("PlayerProxy");
            if (proxy != null) return proxy.transform;
            var cam = Camera.main;
            return cam != null ? cam.transform : null;
        }

        private struct PendingSpawn
        {
            public HertzEncounterSpawnMarker Marker;
            public float Remaining;
        }
    }
}
