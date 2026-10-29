using UnityEngine;

namespace Hertz.Weapons
{
    /// <summary>
    /// Pooled muzzle flash, hitscan tracer, and impact markers for Quest-friendly gunfire feedback.
    /// No Instantiate/Destroy on the fire hot path after warmup.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class HertzWeaponFireEffects : MonoBehaviour
    {
        private const int PoolSize = 8;
        private const float MuzzleDuration = 0.05f;
        private const float TracerDuration = 0.06f;
        private const float ImpactDuration = 0.2f;

        private Transform _poolRoot;
        private MuzzleSlot[] _muzzles;
        private TracerSlot[] _tracers;
        private ImpactSlot[] _impacts;
        private int _muzzleCursor;
        private int _tracerCursor;
        private int _impactCursor;
        private int _spawnedAtRuntime;
        private bool _ready;

        public int RuntimeSpawnCount => _spawnedAtRuntime;
        public int MuzzlePlayCount { get; private set; }
        public int TracerPlayCount { get; private set; }
        public int ImpactPlayCount { get; private set; }
        public bool IsPooledReady => _ready;

        private void Awake()
        {
            EnsurePools();
        }

        public void EnsurePools()
        {
            if (_ready) return;
            _poolRoot = new GameObject("HertzWeaponFxPool").transform;
            _poolRoot.SetParent(transform, false);
            _muzzles = new MuzzleSlot[PoolSize];
            _tracers = new TracerSlot[PoolSize];
            _impacts = new ImpactSlot[PoolSize];
            for (var i = 0; i < PoolSize; i++)
            {
                _muzzles[i] = CreateMuzzle(i);
                _tracers[i] = CreateTracer(i);
                _impacts[i] = CreateImpact(i);
            }

            _ready = true;
        }

        public void PlayMuzzle(Transform muzzle)
        {
            if (muzzle == null) return;
            EnsurePools();
            var slot = _muzzles[_muzzleCursor];
            _muzzleCursor = (_muzzleCursor + 1) % PoolSize;
            slot.Root.position = muzzle.position;
            slot.Root.rotation = muzzle.rotation;
            slot.Root.gameObject.SetActive(true);
            slot.HideAt = Time.time + MuzzleDuration;
            MuzzlePlayCount++;
        }

        public void PlayTracer(Vector3 origin, Vector3 end)
        {
            EnsurePools();
            var slot = _tracers[_tracerCursor];
            _tracerCursor = (_tracerCursor + 1) % PoolSize;
            slot.Line.SetPosition(0, origin);
            slot.Line.SetPosition(1, end);
            slot.Line.enabled = true;
            slot.Root.gameObject.SetActive(true);
            slot.HideAt = Time.time + TracerDuration;
            TracerPlayCount++;
        }

        public void PlayImpact(Vector3 point, Vector3 normal)
        {
            EnsurePools();
            var slot = _impacts[_impactCursor];
            _impactCursor = (_impactCursor + 1) % PoolSize;
            slot.Root.position = point + normal * 0.01f;
            slot.Root.rotation = Quaternion.LookRotation(normal.sqrMagnitude > 0.001f ? normal : Vector3.forward);
            slot.Root.gameObject.SetActive(true);
            slot.HideAt = Time.time + ImpactDuration;
            ImpactPlayCount++;
        }

        public void ResetCounts()
        {
            MuzzlePlayCount = 0;
            TracerPlayCount = 0;
            ImpactPlayCount = 0;
        }

        private void LateUpdate()
        {
            if (!_ready) return;
            var now = Time.time;
            for (var i = 0; i < PoolSize; i++)
            {
                if (_muzzles[i].Root.gameObject.activeSelf && now >= _muzzles[i].HideAt)
                    _muzzles[i].Root.gameObject.SetActive(false);
                if (_tracers[i].Root.gameObject.activeSelf && now >= _tracers[i].HideAt)
                {
                    _tracers[i].Line.enabled = false;
                    _tracers[i].Root.gameObject.SetActive(false);
                }

                if (_impacts[i].Root.gameObject.activeSelf && now >= _impacts[i].HideAt)
                    _impacts[i].Root.gameObject.SetActive(false);
            }
        }

        private MuzzleSlot CreateMuzzle(int index)
        {
            var go = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            _spawnedAtRuntime++;
            go.name = "PooledMuzzle_" + index;
            go.transform.SetParent(_poolRoot, false);
            go.transform.localScale = Vector3.one * 0.06f;
            var col = go.GetComponent<Collider>();
            if (col != null) DestroyCollider(col);
            var r = go.GetComponent<Renderer>();
            if (r != null)
            {
                r.sharedMaterial = CreateUnlit(new Color(1f, 0.85f, 0.35f, 1f));
            }

            go.SetActive(false);
            return new MuzzleSlot { Root = go.transform };
        }

        private TracerSlot CreateTracer(int index)
        {
            var go = new GameObject("PooledTracer_" + index);
            _spawnedAtRuntime++;
            go.transform.SetParent(_poolRoot, false);
            var line = go.AddComponent<LineRenderer>();
            line.positionCount = 2;
            line.startWidth = 0.015f;
            line.endWidth = 0.005f;
            line.material = CreateUnlit(new Color(1f, 0.7f, 0.2f, 1f));
            line.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            line.receiveShadows = false;
            line.enabled = false;
            go.SetActive(false);
            return new TracerSlot { Root = go.transform, Line = line };
        }

        private ImpactSlot CreateImpact(int index)
        {
            var go = GameObject.CreatePrimitive(PrimitiveType.Quad);
            _spawnedAtRuntime++;
            go.name = "PooledImpact_" + index;
            go.transform.SetParent(_poolRoot, false);
            go.transform.localScale = Vector3.one * 0.12f;
            var col = go.GetComponent<Collider>();
            if (col != null) DestroyCollider(col);
            var r = go.GetComponent<Renderer>();
            if (r != null)
            {
                r.sharedMaterial = CreateUnlit(new Color(1f, 0.4f, 0.15f, 1f));
            }

            go.SetActive(false);
            return new ImpactSlot { Root = go.transform };
        }

        private static void DestroyCollider(Collider col)
        {
            if (Application.isPlaying) Destroy(col);
            else DestroyImmediate(col);
        }

        private static Material CreateUnlit(Color color)
        {
            // URP Lit fallback if Unlit missing — still cheap solid color, no particles.
            var shader = Shader.Find("Universal Render Pipeline/Unlit");
            if (shader == null) shader = Shader.Find("Unlit/Color");
            if (shader == null) shader = Shader.Find("Sprites/Default");
            var mat = new Material(shader);
            if (mat.HasProperty("_BaseColor")) mat.SetColor("_BaseColor", color);
            if (mat.HasProperty("_Color")) mat.SetColor("_Color", color);
            return mat;
        }

        private struct MuzzleSlot
        {
            public Transform Root;
            public float HideAt;
        }

        private struct TracerSlot
        {
            public Transform Root;
            public LineRenderer Line;
            public float HideAt;
        }

        private struct ImpactSlot
        {
            public Transform Root;
            public float HideAt;
        }
    }
}
