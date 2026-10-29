using System;
using UnityEngine;

namespace Hertz.Weapons
{
    /// <summary>
    /// Existing frequency-flip gate used by dual-pistol fire. Off by default;
    /// catalog import never flips this on.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class HertzFrequencyGate : MonoBehaviour
    {
        [SerializeField] private bool frequencyActive;

        /// <summary>Fired when frequency active state changes (W06 analytics).</summary>
        public event Action<bool> FrequencyChanged;

        public bool IsFrequencyActive => frequencyActive;

        public void SetFrequencyActive(bool active)
        {
            if (frequencyActive == active) return;
            frequencyActive = active;
            FrequencyChanged?.Invoke(frequencyActive);
        }

        public void ToggleFrequency()
        {
            SetFrequencyActive(!frequencyActive);
        }
    }
}
