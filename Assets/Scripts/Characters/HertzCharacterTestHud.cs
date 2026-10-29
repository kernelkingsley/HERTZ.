using Hertz.Weapons;
using UnityEngine;

namespace Hertz.Characters
{
    /// <summary>Minimal HUD for HertzCharacterTest frequency + shot counters.</summary>
    [DisallowMultipleComponent]
    public sealed class HertzCharacterTestHud : MonoBehaviour
    {
        [SerializeField] private HertzFrequencyGate frequencyGate;
        [SerializeField] private HertzEnemyAgent holdAgent;
        [SerializeField] private HertzEnemyAgent rushAgent;

        public void Configure(HertzFrequencyGate gate, HertzEnemyAgent hold, HertzEnemyAgent rush)
        {
            frequencyGate = gate;
            holdAgent = hold;
            rushAgent = rush;
        }

        private void OnGUI()
        {
            var freq = frequencyGate != null && frequencyGate.IsFrequencyActive;
            GUILayout.BeginArea(new Rect(12, 12, 420, 160));
            GUILayout.Label("W05 Character Test — PLACEHOLDER enemies");
            GUILayout.Label(freq ? "Frequency: ON" : "Frequency: OFF");
            if (holdAgent != null)
            {
                GUILayout.Label(
                    "Hold shots=" + holdAgent.ShotsFired +
                    " detected=" + holdAgent.HasDetectedPlayer +
                    " waiting=" + holdAgent.IsWaiting);
            }

            if (rushAgent != null)
            {
                GUILayout.Label(
                    "Rush shots=" + rushAgent.ShotsFired +
                    " dist=" + rushAgent.DistanceToPlayer.ToString("0.0"));
            }

            if (GUILayout.Button(freq ? "Turn Frequency OFF" : "Turn Frequency ON"))
            {
                if (frequencyGate != null) frequencyGate.ToggleFrequency();
            }

            GUILayout.EndArea();
        }
    }
}
