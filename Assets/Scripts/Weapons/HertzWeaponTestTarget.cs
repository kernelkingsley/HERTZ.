using System;
using UnityEngine;

namespace Hertz.Weapons
{
    /// <summary>
    /// Simple hitscan damage sink for HertzWeaponTest. Not a full combat system.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class HertzWeaponTestTarget : MonoBehaviour
    {
        [SerializeField] private float maxHealth = 100f;
        [SerializeField] private Renderer feedbackRenderer;

        private float _health;
        private Color _baseColor = Color.gray;
        private float _flashUntil;
        private bool _defeatedRaised;

        public event Action<HertzWeaponTestTarget> Defeated;

        /// <summary>Lifecycle for analytics/runtime subscribers (no Update scene search).</summary>
        public static event Action<HertzWeaponTestTarget> EnabledInScene;
        public static event Action<HertzWeaponTestTarget> DisabledInScene;

        public float MaxHealth => maxHealth;
        public float Health => _health;
        public float TotalDamageTaken { get; private set; }
        public int HitCount { get; private set; }

        private void Awake()
        {
            _health = maxHealth;
            if (feedbackRenderer == null) feedbackRenderer = GetComponentInChildren<Renderer>();
            if (feedbackRenderer != null && feedbackRenderer.sharedMaterial != null)
            {
                _baseColor = feedbackRenderer.sharedMaterial.color;
            }
        }

        private void OnEnable()
        {
            EnabledInScene?.Invoke(this);
        }

        private void OnDisable()
        {
            DisabledInScene?.Invoke(this);
        }

        private void Update()
        {
            if (feedbackRenderer == null || Time.time >= _flashUntil) return;
            // Brief hit flash without allocating materials each frame after first.
            EnsureInstanceMaterial().color = Color.Lerp(Color.white, _baseColor, (_flashUntil - Time.time) / 0.12f);
            if (Time.time >= _flashUntil - 0.001f)
            {
                EnsureInstanceMaterial().color = _baseColor;
            }
        }

        public void ApplyDamage(float amount)
        {
            if (amount <= 0f) return;
            TotalDamageTaken += amount;
            HitCount++;
            _health = Mathf.Max(0f, _health - amount);
            _flashUntil = Time.time + 0.12f;
            if (feedbackRenderer != null)
            {
                EnsureInstanceMaterial().color = Color.white;
            }

            if (!_defeatedRaised && _health <= 0f)
            {
                _defeatedRaised = true;
                Defeated?.Invoke(this);
            }
        }

        public void ResetTarget()
        {
            _health = maxHealth;
            TotalDamageTaken = 0f;
            HitCount = 0;
            _flashUntil = 0f;
            _defeatedRaised = false;
            if (feedbackRenderer != null)
            {
                EnsureInstanceMaterial().color = _baseColor;
            }
        }

        /// <summary>Proof helper: set max health then reset so one weapon hit can defeat.</summary>
        public void ConfigureHealthForProof(float max)
        {
            maxHealth = Mathf.Max(0.01f, max);
            ResetTarget();
        }

        private Material EnsureInstanceMaterial()
        {
            return feedbackRenderer.material;
        }
    }
}
