using UnityEngine;

namespace Hertz.Characters
{
    /// <summary>
    /// W05 enemy behavior profile — separate from visual model assets.
    /// Optional animation slot overrides; otherwise inherit from visual model.
    /// </summary>
    [CreateAssetMenu(fileName = "HertzEnemyProfile", menuName = "HERTZ/Enemy Behavior Profile", order = 21)]
    public sealed class HertzEnemyBehaviorProfile : ScriptableObject
    {
        public enum BehaviorMode
        {
            Idle = 0,
            Patrol = 1,
            HoldPosition = 2,
            Rush = 3,
        }

        [SerializeField] private string profileId = "";
        [SerializeField] private string displayName = "Enemy Profile";
        [SerializeField] private bool enabled = true;
        [SerializeField] private HertzCharacterDefinition visualModel;
        [SerializeField] private float moveSpeed = 2.5f;
        [SerializeField] private float detectionRangeMeters = 12f;
        [SerializeField] private float attackRangeMeters = 8f;
        [SerializeField] private float waitReactionDelaySeconds = 0.4f;
        [SerializeField] private float shotBurstIntervalSeconds = 0.75f;
        [SerializeField] private float approachDistanceMeters = 3f;
        [SerializeField] private BehaviorMode mode = BehaviorMode.HoldPosition;
        [SerializeField] private AnimationClip idleClip;
        [SerializeField] private AnimationClip attackClip;
        [SerializeField] private AnimationClip locomotionClip;
        [SerializeField] private RuntimeAnimatorController idleController;
        [SerializeField] private RuntimeAnimatorController attackController;
        [SerializeField] private RuntimeAnimatorController locomotionController;
        [SerializeField] private int studioVersion = 1;
        [SerializeField] private string studioPayloadHash = "";

        public string ProfileId => profileId;
        public string DisplayName => displayName;
        public bool Enabled => enabled;
        public HertzCharacterDefinition VisualModel => visualModel;
        public float MoveSpeed => moveSpeed;
        public float DetectionRangeMeters => detectionRangeMeters;
        public float AttackRangeMeters => attackRangeMeters;
        public float WaitReactionDelaySeconds => waitReactionDelaySeconds;
        public float ShotBurstIntervalSeconds => shotBurstIntervalSeconds;
        public float ApproachDistanceMeters => approachDistanceMeters;
        public BehaviorMode Mode => mode;
        public AnimationClip IdleClip => idleClip != null ? idleClip : visualModel != null ? visualModel.IdleClip : null;
        public AnimationClip AttackClip => attackClip != null ? attackClip : visualModel != null ? visualModel.AttackClip : null;
        public AnimationClip LocomotionClip =>
            locomotionClip != null ? locomotionClip : visualModel != null ? visualModel.LocomotionClip : null;
        public RuntimeAnimatorController IdleController =>
            idleController != null ? idleController : visualModel != null ? visualModel.IdleController : null;
        public RuntimeAnimatorController AttackController =>
            attackController != null ? attackController : visualModel != null ? visualModel.AttackController : null;
        public RuntimeAnimatorController LocomotionController =>
            locomotionController != null
                ? locomotionController
                : visualModel != null
                    ? visualModel.LocomotionController
                    : null;
        public int StudioVersion => studioVersion;
        public string StudioPayloadHash => studioPayloadHash;

        public bool TryApplyStudioFields(
            string id,
            string name,
            bool isEnabled,
            HertzCharacterDefinition model,
            float speed,
            float detection,
            float attack,
            float waitDelay,
            float shotInterval,
            float approach,
            BehaviorMode behaviorMode,
            AnimationClip idle,
            AnimationClip attackAnim,
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
                error = "profileId required.";
                return false;
            }

            if (!IsFiniteInRange(speed, 0.1f, 20f) ||
                !IsFiniteInRange(detection, 0.5f, 200f) ||
                !IsFiniteInRange(attack, 0.5f, 200f) ||
                !IsFiniteInRange(waitDelay, 0f, 30f) ||
                !IsFiniteInRange(shotInterval, 0.05f, 30f) ||
                !IsFiniteInRange(approach, 0.25f, 100f))
            {
                error = "Invalid behavior ranges.";
                return false;
            }

            profileId = id.Trim();
            displayName = string.IsNullOrWhiteSpace(name) ? "Enemy Profile" : name.Trim();
            enabled = isEnabled;
            visualModel = model;
            moveSpeed = speed;
            detectionRangeMeters = detection;
            attackRangeMeters = attack;
            waitReactionDelaySeconds = waitDelay;
            shotBurstIntervalSeconds = shotInterval;
            approachDistanceMeters = approach;
            mode = behaviorMode;
            idleClip = idle;
            attackClip = attackAnim;
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
