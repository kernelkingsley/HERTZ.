using UnityEngine;

namespace Hertz.Characters
{
    /// <summary>
    /// W05 visual character/enemy model definition. Never replaces tracked XR rig/camera.
    /// Animation slots: idle / attack / locomotion (clip or controller paths from Studio).
    /// </summary>
    [CreateAssetMenu(fileName = "HertzCharacter", menuName = "HERTZ/Character Definition", order = 20)]
    public sealed class HertzCharacterDefinition : ScriptableObject
    {
        public enum CharacterKind
        {
            PlayerCharacter = 0,
            EnemyVisual = 1,
        }

        [SerializeField] private string characterId = "";
        [SerializeField] private string displayName = "Character";
        [SerializeField] private CharacterKind kind = CharacterKind.EnemyVisual;
        [SerializeField] private bool enabled = true;
        [SerializeField] private GameObject modelPrefab;
        [SerializeField] private float scale = 1f;
        [SerializeField] private bool replaceTrackedXrRig;
        [SerializeField] private AnimationClip idleClip;
        [SerializeField] private AnimationClip attackClip;
        [SerializeField] private AnimationClip locomotionClip;
        [SerializeField] private RuntimeAnimatorController idleController;
        [SerializeField] private RuntimeAnimatorController attackController;
        [SerializeField] private RuntimeAnimatorController locomotionController;
        [SerializeField] private int studioVersion = 1;
        [SerializeField] private string studioPayloadHash = "";

        public string CharacterId => characterId;
        public string DisplayName => displayName;
        public CharacterKind Kind => kind;
        public bool Enabled => enabled;
        public GameObject ModelPrefab => modelPrefab;
        public float Scale => scale;
        public bool ReplaceTrackedXrRig => false;
        public AnimationClip IdleClip => idleClip;
        public AnimationClip AttackClip => attackClip;
        public AnimationClip LocomotionClip => locomotionClip;
        public RuntimeAnimatorController IdleController => idleController;
        public RuntimeAnimatorController AttackController => attackController;
        public RuntimeAnimatorController LocomotionController => locomotionController;
        public int StudioVersion => studioVersion;
        public string StudioPayloadHash => studioPayloadHash;

        public bool TryApplyStudioFields(
            string id,
            string name,
            CharacterKind characterKind,
            bool isEnabled,
            GameObject prefab,
            float modelScale,
            bool replaceXr,
            AnimationClip idle,
            AnimationClip attack,
            AnimationClip locomotion,
            RuntimeAnimatorController idleCtrl,
            RuntimeAnimatorController attackCtrl,
            RuntimeAnimatorController locomotionCtrl,
            int version,
            string payloadHash,
            out string error)
        {
            error = null;
            if (string.IsNullOrWhiteSpace(id))
            {
                error = "characterId required.";
                return false;
            }

            if (replaceXr)
            {
                error = "replaceTrackedXrRig is forbidden.";
                return false;
            }

            if (!IsFiniteInRange(modelScale, 0.05f, 10f))
            {
                error = "Invalid scale.";
                return false;
            }

            characterId = id.Trim();
            displayName = string.IsNullOrWhiteSpace(name) ? "Character" : name.Trim();
            kind = characterKind;
            enabled = isEnabled;
            modelPrefab = prefab;
            scale = modelScale;
            replaceTrackedXrRig = false;
            idleClip = idle;
            attackClip = attack;
            locomotionClip = locomotion;
            idleController = idleCtrl;
            attackController = attackCtrl;
            locomotionController = locomotionCtrl;
            studioVersion = version;
            studioPayloadHash = payloadHash ?? "";
            return true;
        }

        private static bool IsFiniteInRange(float v, float min, float max)
        {
            return !float.IsNaN(v) && !float.IsInfinity(v) && v >= min && v <= max;
        }
    }
}
