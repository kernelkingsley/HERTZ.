using UnityEngine;
using UnityEngine.InputSystem;

namespace Hertz.Weapons
{
    /// <summary>
    /// On-screen controls for HertzWeaponTest: frequency toggle, reset, and status.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class HertzWeaponTestHud : MonoBehaviour
    {
        [SerializeField] private HertzFrequencyGate frequencyGate;
        [SerializeField] private HertzDualPistolRuntime dualPistols;
        [SerializeField] private HertzWeaponTestTarget[] targets;

        private void Reset()
        {
            frequencyGate = FindFirstObjectByType<HertzFrequencyGate>();
            dualPistols = FindFirstObjectByType<HertzDualPistolRuntime>();
            targets = FindObjectsByType<HertzWeaponTestTarget>(FindObjectsSortMode.None);
        }

        private void OnGUI()
        {
            const float w = 440f;
            var rect = new Rect(16f, 16f, w, 230f);
            GUI.Box(rect, "HERTZ Weapon Test — PLACEHOLDER pistols (not final art)");
            GUILayout.BeginArea(new Rect(28f, 44f, w - 24f, 190f));
            var freq = frequencyGate != null && frequencyGate.IsFrequencyActive;
            GUILayout.Label("Frequency: " + (freq ? "ON (pistols can fire)" : "OFF (fire blocked)"));
            GUILayout.Label("Fire: mouse left / key 1 = left · mouse right / key 2 = right");
            GUILayout.Label("F = toggle frequency · R = reset targets + shot counts");
            if (dualPistols != null)
            {
                GUILayout.Label(
                    "Shots L/R: " + dualPistols.LeftShotCount + " / " + dualPistols.RightShotCount);
                if (!string.IsNullOrEmpty(dualPistols.BindError))
                {
                    GUILayout.Label("BIND ERROR: " + dualPistols.BindError);
                }
            }

            if (GUILayout.Button(freq ? "Turn Frequency OFF" : "Turn Frequency ON", GUILayout.Height(28f)))
            {
                if (frequencyGate != null) frequencyGate.ToggleFrequency();
            }

            if (GUILayout.Button("Reset test", GUILayout.Height(28f)))
            {
                ResetTest();
            }

            GUILayout.EndArea();
        }

        private void Update()
        {
            var keyboard = Keyboard.current;
            if (keyboard == null) return;
            if (keyboard.fKey.wasPressedThisFrame && frequencyGate != null)
            {
                frequencyGate.ToggleFrequency();
            }

            if (keyboard.rKey.wasPressedThisFrame)
            {
                ResetTest();
            }
        }

        public void ResetTest()
        {
            if (dualPistols != null) dualPistols.ResetShotCounts();
            if (targets == null) return;
            for (var i = 0; i < targets.Length; i++)
            {
                if (targets[i] != null) targets[i].ResetTarget();
            }
        }
    }
}
