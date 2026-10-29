using System;
using Hertz.Weapons;
using UnityEngine;

namespace Hertz.Characters
{
    /// <summary>
    /// Frequency-gated spirit/enemy target. Only damageable when frequency is active.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class HertzSpiritTarget : MonoBehaviour
    {
        [SerializeField] private HertzFrequencyGate frequencyGate;
        [SerializeField] private float maxHealth = 30f;
        [SerializeField] private float currentHealth = 30f;

        /// <summary>Fired once when health reaches zero (W06 analytics).</summary>
        public event Action<HertzSpiritTarget> Defeated;

        /// <summary>Lifecycle for analytics/runtime subscribers (no Update scene search).</summary>
        public static event Action<HertzSpiritTarget> EnabledInScene;
        public static event Action<HertzSpiritTarget> DisabledInScene;

        public float MaxHealth => maxHealth;
        public float CurrentHealth => currentHealth;
        public bool IsDefeated => currentHealth <= 0f;

        private void OnEnable()
        {
            EnabledInScene?.Invoke(this);
        }

        private void OnDisable()
        {
            DisabledInScene?.Invoke(this);
        }

        public void Configure(HertzFrequencyGate gate, float health)
        {
            frequencyGate = gate;
            maxHealth = Mathf.Max(1f, health);
            currentHealth = maxHealth;
        }

        public bool IsTargetable
        {
            get
            {
                if (IsDefeated) return false;
                return frequencyGate == null || frequencyGate.IsFrequencyActive;
            }
        }

        public bool TryApplyDamage(float amount)
        {
            if (!IsTargetable || amount <= 0f) return false;
            var wasAlive = currentHealth > 0f;
            currentHealth = Mathf.Max(0f, currentHealth - amount);
            if (wasAlive && currentHealth <= 0f)
            {
                Defeated?.Invoke(this);
            }

            return true;
        }

        public void ResetHealth()
        {
            currentHealth = maxHealth;
        }
    }
}
