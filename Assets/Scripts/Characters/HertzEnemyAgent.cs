using Hertz.Weapons;
using UnityEngine;

namespace Hertz.Characters
{
    /// <summary>
    /// Simple transform-seek enemy AI (no NavMesh package). Modes: idle/patrol/hold/rush.
    /// Detects and fires only when frequency is active.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class HertzEnemyAgent : MonoBehaviour
    {
        [SerializeField] private HertzEnemyBehaviorProfile profile;
        [SerializeField] private HertzFrequencyGate frequencyGate;
        [SerializeField] private Transform playerTarget;
        [SerializeField] private Transform[] patrolPoints;
        [SerializeField] private HertzSpiritTarget spiritTarget;

        private float _waitElapsed;
        private float _shotCooldown;
        private int _patrolIndex;
        private bool _detected;
        private int _shotsFired;
        private GameObject _visualInstance;
        private Vector3 _home;
        private Animation _legacyAnimation;
        private Animator _animator;
        private string _activeAnimSlot = "idle";
        private bool _movingThisTick;

        public HertzEnemyBehaviorProfile Profile => profile;
        public bool HasDetectedPlayer => _detected;
        public int ShotsFired => _shotsFired;
        public string ActiveAnimationSlot => _activeAnimSlot;
        public bool IsWaiting => _detected && _waitElapsed < (profile != null ? profile.WaitReactionDelaySeconds : 0f);
        public float DistanceToPlayer
        {
            get
            {
                if (playerTarget == null) return float.PositiveInfinity;
                return Vector3.Distance(transform.position, playerTarget.position);
            }
        }

        public void Configure(
            HertzEnemyBehaviorProfile behaviorProfile,
            HertzFrequencyGate gate,
            Transform player,
            Transform[] patrol,
            HertzSpiritTarget target)
        {
            profile = behaviorProfile;
            frequencyGate = gate;
            playerTarget = player;
            patrolPoints = patrol;
            spiritTarget = target;
            _home = transform.position;
            BindVisual();
            BindAnimationPlayback();
            ResetRuntimeCounters();
            PlayAnimationSlot("idle", loop: true);
        }

        public void ResetRuntimeCounters()
        {
            _waitElapsed = 0f;
            _shotCooldown = 0f;
            _patrolIndex = 0;
            _detected = false;
            _shotsFired = 0;
            if (spiritTarget != null) spiritTarget.ResetHealth();
        }

        /// <summary>Rebind visual model from the current profile (model swap).</summary>
        public void RebindVisual()
        {
            BindVisual();
            BindAnimationPlayback();
            PlayAnimationSlot("idle", loop: true);
        }

        public GameObject VisualInstance => _visualInstance;

        private void OnEnable()
        {
            _home = transform.position;
            BindVisual();
            BindAnimationPlayback();
            PlayAnimationSlot("idle", loop: true);
        }

        private void OnDisable()
        {
            ClearVisual();
        }

        private void Update()
        {
            Tick(Time.deltaTime);
        }

        /// <summary>Production tick path; proofs call this with a fixed dt in Edit Mode.</summary>
        public void Tick(float dt)
        {
            if (dt < 0f) dt = 0f;
            if (profile == null || !profile.Enabled) return;
            if (spiritTarget != null && spiritTarget.IsDefeated) return;

            var freqOn = frequencyGate == null || frequencyGate.IsFrequencyActive;
            var dist = DistanceToPlayer;
            if (freqOn && playerTarget != null && dist <= profile.DetectionRangeMeters)
            {
                if (!_detected)
                {
                    _detected = true;
                    _waitElapsed = 0f;
                }
            }

            _movingThisTick = false;
            if (!_detected || !freqOn)
            {
                TickUndetected(dt);
                if (!_movingThisTick) PlayAnimationSlot("idle", loop: true);
                return;
            }

            _waitElapsed += dt;
            if (_waitElapsed < profile.WaitReactionDelaySeconds)
            {
                PlayAnimationSlot("idle", loop: true);
                return;
            }

            switch (profile.Mode)
            {
                case HertzEnemyBehaviorProfile.BehaviorMode.Rush:
                    TickRush(dt, dist);
                    break;
                case HertzEnemyBehaviorProfile.BehaviorMode.Patrol:
                case HertzEnemyBehaviorProfile.BehaviorMode.Idle:
                case HertzEnemyBehaviorProfile.BehaviorMode.HoldPosition:
                default:
                    TryFire(dt, dist);
                    break;
            }

            if (!_movingThisTick && _activeAnimSlot != "attack")
            {
                PlayAnimationSlot("idle", loop: true);
            }
        }

        private void TickUndetected(float dt)
        {
            if (profile.Mode != HertzEnemyBehaviorProfile.BehaviorMode.Patrol) return;
            if (patrolPoints == null || patrolPoints.Length == 0) return;
            var point = patrolPoints[Mathf.Clamp(_patrolIndex, 0, patrolPoints.Length - 1)];
            if (point == null) return;
            MoveToward(point.position, dt);
            if (Vector3.Distance(transform.position, point.position) <= 0.25f)
            {
                _patrolIndex = (_patrolIndex + 1) % patrolPoints.Length;
            }
        }

        private void TickRush(float dt, float dist)
        {
            if (dist > profile.ApproachDistanceMeters)
            {
                MoveToward(playerTarget.position, dt);
                return;
            }

            TryFire(dt, dist);
        }

        private void MoveToward(Vector3 worldTarget, float dt)
        {
            var flat = worldTarget;
            flat.y = transform.position.y;
            var dir = flat - transform.position;
            if (dir.sqrMagnitude < 0.0001f) return;
            dir.Normalize();
            transform.position += dir * (profile.MoveSpeed * dt);
            transform.rotation = Quaternion.Slerp(
                transform.rotation,
                Quaternion.LookRotation(dir, Vector3.up),
                Mathf.Clamp01(dt * 8f));
            _movingThisTick = true;
            PlayAnimationSlot("locomotion", loop: true);
        }

        private void TryFire(float dt, float dist)
        {
            if (dist > profile.AttackRangeMeters) return;
            _shotCooldown -= dt;
            if (_shotCooldown > 0f) return;
            _shotCooldown = profile.ShotBurstIntervalSeconds;
            _shotsFired += 1;
            PlayAnimationSlot("attack", loop: false);
        }

        private void BindVisual()
        {
            ClearVisual();
            if (profile == null || profile.VisualModel == null || profile.VisualModel.ModelPrefab == null) return;
            _visualInstance = Instantiate(profile.VisualModel.ModelPrefab, transform);
            _visualInstance.name = profile.VisualModel.DisplayName + "_Runtime";
            var s = profile.VisualModel.Scale;
            _visualInstance.transform.localScale = new Vector3(s, s, s);
            _visualInstance.transform.localPosition = Vector3.zero;
            _visualInstance.transform.localRotation = Quaternion.identity;
        }

        private void BindAnimationPlayback()
        {
            if (profile == null) return;
            _legacyAnimation = GetComponent<Animation>();
            if (_legacyAnimation == null) _legacyAnimation = gameObject.AddComponent<Animation>();
            _legacyAnimation.playAutomatically = false;
            AddClip(_legacyAnimation, "idle", profile.IdleClip);
            AddClip(_legacyAnimation, "attack", profile.AttackClip);
            AddClip(_legacyAnimation, "locomotion", profile.LocomotionClip);

            _animator = GetComponent<Animator>();
            if (_animator == null) _animator = gameObject.AddComponent<Animator>();
            // Prefer idle controller as default; slot switches swap controller when present.
            if (profile.IdleController != null)
            {
                _animator.runtimeAnimatorController = profile.IdleController;
            }
        }

        private static void AddClip(Animation anim, string name, AnimationClip clip)
        {
            if (anim == null || clip == null) return;
            if (anim.GetClip(name) != null) anim.RemoveClip(name);
            anim.AddClip(clip, name);
        }

        public void PlayAnimationSlot(string slot, bool loop)
        {
            if (string.IsNullOrEmpty(slot)) slot = "idle";
            _activeAnimSlot = slot;
            RuntimeAnimatorController ctrl = null;
            AnimationClip clip = null;
            if (profile != null)
            {
                switch (slot)
                {
                    case "attack":
                        ctrl = profile.AttackController;
                        clip = profile.AttackClip;
                        break;
                    case "locomotion":
                        ctrl = profile.LocomotionController;
                        clip = profile.LocomotionClip;
                        break;
                    default:
                        ctrl = profile.IdleController;
                        clip = profile.IdleClip;
                        break;
                }
            }

            if (ctrl != null && _animator != null)
            {
                if (_animator.runtimeAnimatorController != ctrl)
                {
                    _animator.runtimeAnimatorController = ctrl;
                }

                _animator.enabled = true;
                if (_legacyAnimation != null) _legacyAnimation.Stop();
                return;
            }

            if (_animator != null) _animator.enabled = false;
            if (_legacyAnimation == null || clip == null) return;
            if (_legacyAnimation.GetClip(slot) == null) AddClip(_legacyAnimation, slot, clip);
            var state = _legacyAnimation[slot];
            if (state != null) state.wrapMode = loop ? WrapMode.Loop : WrapMode.Once;
            if (!_legacyAnimation.IsPlaying(slot)) _legacyAnimation.Play(slot);
        }

        private void ClearVisual()
        {
            if (_visualInstance == null) return;
            if (Application.isPlaying) Destroy(_visualInstance);
            else DestroyImmediate(_visualInstance);
            _visualInstance = null;
        }
    }
}
