using System;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.XR;

namespace Hertz.Weapons
{
    /// <summary>
    /// Production dual-pistol consumer: binds left/right <see cref="HertzWeaponDefinition"/>,
    /// attaches model prefabs at validated grips, hitscan fires only when frequency allows,
    /// and presents pooled gunfire feedback. Does not move tracked controller transforms.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class HertzDualPistolRuntime : MonoBehaviour
    {
        public enum WeaponSide
        {
            Left = 0,
            Right = 1,
        }

        [SerializeField] private HertzWeaponDefinition leftDefinition;
        [SerializeField] private HertzWeaponDefinition rightDefinition;
        [SerializeField] private HertzFrequencyGate frequencyGate;
        [SerializeField] private InputActionProperty leftActivate;
        [SerializeField] private InputActionProperty rightActivate;
        [SerializeField] private Transform leftAttach;
        [SerializeField] private Transform rightAttach;
        [SerializeField] private HertzWeaponFireEffects fireEffects;
        [SerializeField] private bool attemptControllerHaptics = true;
        [Tooltip("Optional MonoBehaviour implementing IHertzWeaponShotAudioPresenter (Sound section).")]
        [SerializeField] private MonoBehaviour shotAudioPresenter;

        private float _leftNextFireTime;
        private float _rightNextFireTime;
        private int _leftShotCount;
        private int _rightShotCount;
        private int _leftActivateCallbacks;
        private int _rightActivateCallbacks;
        private int _leftAcceptedShotSignals;
        private int _rightAcceptedShotSignals;
        private int _leftPresenterDeliveries;
        private int _rightPresenterDeliveries;
        private int _leftPresentationSequences;
        private int _rightPresentationSequences;
        private float _leftVisualRecoil;
        private float _rightVisualRecoil;
        private bool _subscribed;
        private bool _allowEditModeModelBind;
        private string _bindError;
        private GameObject _leftModel;
        private GameObject _rightModel;
        private Transform _leftMuzzle;
        private Transform _rightMuzzle;
        private Transform _leftRecoilPivot;
        private Transform _rightRecoilPivot;
        private Vector3 _leftRecoilRestLocal;
        private Vector3 _rightRecoilRestLocal;
        private IHertzWeaponShotAudioPresenter _audioPresenter;

        public event Action<HertzWeaponShotEvent> ShotAccepted;

        public HertzWeaponDefinition LeftDefinition => leftDefinition;
        public HertzWeaponDefinition RightDefinition => rightDefinition;
        public int LeftShotCount => _leftShotCount;
        public int RightShotCount => _rightShotCount;
        public int LeftActivateCallbackCount => _leftActivateCallbacks;
        public int RightActivateCallbackCount => _rightActivateCallbacks;
        /// <summary>Accepted-shot signals (event invoke attempts), not presenter deliveries.</summary>
        public int LeftAcceptedShotSignalCount => _leftAcceptedShotSignals;
        public int RightAcceptedShotSignalCount => _rightAcceptedShotSignals;
        /// <summary>Count of calls into an assigned <see cref="IHertzWeaponShotAudioPresenter"/>.</summary>
        public int LeftPresenterDeliveryCount => _leftPresenterDeliveries;
        public int RightPresenterDeliveryCount => _rightPresenterDeliveries;
        public int LeftPresentationSequenceCount => _leftPresentationSequences;
        public int RightPresentationSequenceCount => _rightPresentationSequences;
        public float LeftVisualRecoil => _leftVisualRecoil;
        public float RightVisualRecoil => _rightVisualRecoil;
        public Transform LeftMuzzle => _leftMuzzle;
        public Transform RightMuzzle => _rightMuzzle;
        public GameObject LeftModelInstance => _leftModel;
        public GameObject RightModelInstance => _rightModel;
        public HertzWeaponFireEffects FireEffects => fireEffects;
        public string BindError => _bindError;
        public bool IsBound => string.IsNullOrEmpty(_bindError);

        /// <param name="instantiateModels">
        /// When false (scene builder / Edit Mode serialization), only assign references and validate —
        /// do not spawn *_Runtime instances into the saved scene. Play Mode OnEnable binds models.
        /// Editor proofs that need hitscan may pass true.
        /// </param>
        public void Configure(
            HertzWeaponDefinition left,
            HertzWeaponDefinition right,
            HertzFrequencyGate gate,
            InputActionProperty leftAct,
            InputActionProperty rightAct,
            Transform leftHand,
            Transform rightHand,
            HertzWeaponFireEffects effects = null,
            MonoBehaviour audioPresenter = null,
            bool instantiateModels = true)
        {
            Unsubscribe();
            DestroyModels();
            leftDefinition = left;
            rightDefinition = right;
            frequencyGate = gate;
            leftActivate = leftAct;
            rightActivate = rightAct;
            leftAttach = leftHand;
            rightAttach = rightHand;
            if (effects != null) fireEffects = effects;
            if (audioPresenter != null) shotAudioPresenter = audioPresenter;
            _allowEditModeModelBind = instantiateModels;
            ValidateAndBind();
            if (isActiveAndEnabled && IsBound) Subscribe();
        }

        /// <summary>Assign optional audio presenter (Sound section / proofs). Null is valid.</summary>
        public void SetShotAudioPresenter(MonoBehaviour presenter)
        {
            shotAudioPresenter = presenter;
            ResolveAudioPresenter();
        }

        private void Awake()
        {
            if (fireEffects == null) fireEffects = GetComponent<HertzWeaponFireEffects>();
            if (fireEffects == null) fireEffects = gameObject.AddComponent<HertzWeaponFireEffects>();
            ResolveAudioPresenter();
        }

        private void OnEnable()
        {
            // Play Mode always materializes models; Edit Mode never leaves serialized clones.
            if (Application.isPlaying) _allowEditModeModelBind = true;
            ValidateAndBind();
            if (IsBound) Subscribe();
        }

        private void OnDisable()
        {
            Unsubscribe();
        }

        private void OnDestroy()
        {
            DestroyModels();
        }

        private void LateUpdate()
        {
            RecoverRecoil(ref _leftVisualRecoil, _leftRecoilPivot, _leftRecoilRestLocal);
            RecoverRecoil(ref _rightVisualRecoil, _rightRecoilPivot, _rightRecoilRestLocal);
        }

        private void ResolveAudioPresenter()
        {
            _audioPresenter = shotAudioPresenter as IHertzWeaponShotAudioPresenter;
        }

        private void ValidateAndBind()
        {
            _bindError = ValidateBindings();
            if (!string.IsNullOrEmpty(_bindError))
            {
                DestroyModels();
                return;
            }

            var shouldInstantiate = Application.isPlaying || _allowEditModeModelBind;
            if (shouldInstantiate) BindModels();
            else DestroyModels();
        }

        private string ValidateBindings()
        {
            if (frequencyGate == null) return "Missing HertzFrequencyGate.";
            if (leftDefinition == null || rightDefinition == null) return "Missing left or right HertzWeaponDefinition.";
            if (leftAttach == null || rightAttach == null) return "Missing left or right attachment transform.";
            if (leftActivate.action == null || rightActivate.action == null) return "Missing left or right InputAction.";
            if (leftDefinition.Role != HertzWeaponDefinition.WeaponRole.LeftPistol)
                return "Left slot must be LeftPistol role.";
            if (rightDefinition.Role != HertzWeaponDefinition.WeaponRole.RightPistol)
                return "Right slot must be RightPistol role.";
            if (leftDefinition.Role == rightDefinition.Role) return "Duplicate pistol roles are not allowed.";
            if (!string.IsNullOrEmpty(leftDefinition.WeaponId) &&
                leftDefinition.WeaponId == rightDefinition.WeaponId)
                return "Left and right cannot share the same weaponId.";
            if (leftDefinition.ModelPrefab == null) return "Left definition missing modelPrefab.";
            if (rightDefinition.ModelPrefab == null) return "Right definition missing modelPrefab.";
            var leftMissing = DescribeMissingAnchors(
                leftDefinition.ModelPrefab, leftDefinition.GripAnchor, leftDefinition.MuzzleAnchor);
            if (leftMissing != null)
                return "Left model missing required anchors: " + leftMissing +
                       ". Grip aligns the hand; Muzzle is flash/tracer origin. Fix via Studio anchor select or managed wrapper.";
            var rightMissing = DescribeMissingAnchors(
                rightDefinition.ModelPrefab, rightDefinition.GripAnchor, rightDefinition.MuzzleAnchor);
            if (rightMissing != null)
                return "Right model missing required anchors: " + rightMissing +
                       ". Grip aligns the hand; Muzzle is flash/tracer origin. Fix via Studio anchor select or managed wrapper.";
            return null;
        }

        private static string DescribeMissingAnchors(GameObject prefab, string grip, string muzzle)
        {
            var missing = new System.Collections.Generic.List<string>(2);
            if (!PrefabHasAnchor(prefab, grip)) missing.Add(string.IsNullOrEmpty(grip) ? "Grip" : grip);
            if (!PrefabHasAnchor(prefab, muzzle)) missing.Add(string.IsNullOrEmpty(muzzle) ? "Muzzle" : muzzle);
            return missing.Count == 0 ? null : string.Join(", ", missing);
        }

        private static bool PrefabHasAnchor(GameObject prefab, string anchorName)
        {
            if (prefab == null || string.IsNullOrEmpty(anchorName)) return false;
            if (string.Equals(prefab.name, anchorName, StringComparison.Ordinal)) return true;
            return FindNamed(prefab.transform, anchorName) != null;
        }

        private void BindModels()
        {
            DestroyModels();
            _leftModel = AttachModel(leftDefinition, leftAttach, out _leftMuzzle, out _leftRecoilPivot, out _leftRecoilRestLocal);
            _rightModel = AttachModel(rightDefinition, rightAttach, out _rightMuzzle, out _rightRecoilPivot, out _rightRecoilRestLocal);
            if (_leftModel == null || _rightModel == null || _leftMuzzle == null || _rightMuzzle == null)
            {
                _bindError = "Failed to attach models or resolve muzzle anchors.";
                DestroyModels();
            }
        }

        private static GameObject AttachModel(
            HertzWeaponDefinition def,
            Transform attach,
            out Transform muzzle,
            out Transform recoilPivot,
            out Vector3 recoilRestLocal)
        {
            muzzle = null;
            recoilPivot = null;
            recoilRestLocal = Vector3.zero;
            if (def == null || def.ModelPrefab == null || attach == null) return null;

            var instance = Instantiate(def.ModelPrefab, attach, false);
            instance.name = def.ModelPrefab.name + "_Runtime";
            var grip = FindNamed(instance.transform, def.GripAnchor);
            if (grip == null) grip = instance.transform;
            // Align grip to attach without moving the tracked attach transform.
            var gripToRoot = instance.transform.position - grip.position;
            instance.transform.position = attach.position + gripToRoot;
            instance.transform.rotation = attach.rotation;
            instance.transform.SetParent(attach, true);

            muzzle = FindNamed(instance.transform, def.MuzzleAnchor);
            recoilPivot = FindNamed(instance.transform, "RecoilPivot");
            if (recoilPivot == null) recoilPivot = instance.transform;
            recoilRestLocal = recoilPivot.localPosition;
            return instance;
        }

        private static Transform FindNamed(Transform root, string name)
        {
            if (root == null || string.IsNullOrEmpty(name)) return null;
            if (string.Equals(root.name, name, StringComparison.Ordinal)) return root;
            for (var i = 0; i < root.childCount; i++)
            {
                var found = FindNamed(root.GetChild(i), name);
                if (found != null) return found;
            }

            return null;
        }

        private void DestroyModels()
        {
            // DestroyImmediate so Play Mode rebind does not leave deferred duplicates for a frame.
            // Only destroy this component's instances — never strip another runtime's models from a shared attach.
            if (_leftModel != null)
            {
                DestroyImmediate(_leftModel);
                _leftModel = null;
            }

            if (_rightModel != null)
            {
                DestroyImmediate(_rightModel);
                _rightModel = null;
            }

            _leftMuzzle = null;
            _rightMuzzle = null;
            _leftRecoilPivot = null;
            _rightRecoilPivot = null;
        }

        /// <summary>
        /// Remove orphan *_Runtime children under this runtime's attaches (idempotent rebind / scene cleanup).
        /// </summary>
        public void StripOwnedOrphanRuntimeClones()
        {
            StripOrphansUnder(leftAttach, _leftModel);
            StripOrphansUnder(rightAttach, _rightModel);
        }

        private static void StripOrphansUnder(Transform attach, GameObject keep)
        {
            if (attach == null) return;
            for (var i = attach.childCount - 1; i >= 0; i--)
            {
                var child = attach.GetChild(i);
                if (child == null || !child.name.EndsWith("_Runtime", StringComparison.Ordinal)) continue;
                if (keep != null && child.gameObject == keep) continue;
                DestroyImmediate(child.gameObject);
            }
        }

        private void Subscribe()
        {
            if (_subscribed) return;
            var left = leftActivate.action;
            var right = rightActivate.action;
            if (left != null)
            {
                left.performed += OnLeftActivate;
                if (!left.enabled) left.Enable();
            }

            if (right != null)
            {
                right.performed += OnRightActivate;
                if (!right.enabled) right.Enable();
            }

            _subscribed = true;
        }

        private void Unsubscribe()
        {
            if (!_subscribed) return;
            var left = leftActivate.action;
            var right = rightActivate.action;
            if (left != null) left.performed -= OnLeftActivate;
            if (right != null) right.performed -= OnRightActivate;
            _subscribed = false;
        }

        private void OnLeftActivate(InputAction.CallbackContext ctx) => HandleActivate(WeaponSide.Left);

        private void OnRightActivate(InputAction.CallbackContext ctx) => HandleActivate(WeaponSide.Right);

        /// <summary>
        /// Manual activate helper for non-subscription bounded tests only.
        /// Must not be used to satisfy InputAction subscription proofs.
        /// </summary>
        public bool RaiseActivateFromInputBoundary(WeaponSide side) => HandleActivate(side);

        private bool HandleActivate(WeaponSide side)
        {
            if (side == WeaponSide.Left) _leftActivateCallbacks++;
            else _rightActivateCallbacks++;
            return TryFireSide(side);
        }

        /// <summary>
        /// Direct fire path for non-subscription proofs (damage/range/interval).
        /// Must not be used to prove input subscription integrity (does not count activate callbacks).
        /// </summary>
        public bool TryFireLeftForProof() => TryFireSide(WeaponSide.Left);

        public bool TryFireRightForProof() => TryFireSide(WeaponSide.Right);

        private bool TryFireSide(WeaponSide side)
        {
            if (!string.IsNullOrEmpty(_bindError)) return false;

            var def = side == WeaponSide.Left ? leftDefinition : rightDefinition;
            if (def == null || !def.Enabled) return false;
            if (def.FrequencyFlipRequired)
            {
                if (frequencyGate == null || !frequencyGate.IsFrequencyActive) return false;
            }

            ref var nextTime = ref (side == WeaponSide.Left ? ref _leftNextFireTime : ref _rightNextFireTime);
            var now = Time.time;
            if (now < nextTime) return false;
            nextTime = now + Mathf.Max(0.05f, def.FireIntervalSeconds);

            var muzzle = side == WeaponSide.Left ? _leftMuzzle : _rightMuzzle;
            if (muzzle == null) return false;

            var origin = muzzle.position;
            var forward = muzzle.forward;
            var range = Mathf.Max(1f, def.RangeMeters);
            var hitSomething = Physics.Raycast(
                origin,
                forward,
                out var hit,
                range,
                Physics.DefaultRaycastLayers,
                QueryTriggerInteraction.Ignore);

            var damageApplied = 0f;
            var hitPoint = origin + forward * range;
            if (hitSomething)
            {
                hitPoint = hit.point;
                var target = hit.collider.GetComponentInParent<HertzWeaponTestTarget>();
                if (target != null)
                {
                    damageApplied = def.Damage;
                    target.ApplyDamage(def.Damage);
                }
            }

            PresentGunfire(side, def, muzzle, origin, hitPoint, hitSomething, hit);
            ApplyVisualRecoil(side, def.Recoil);
            TryHaptics(side);

            if (side == WeaponSide.Left) _leftShotCount++;
            else _rightShotCount++;

            var shot = new HertzWeaponShotEvent(
                def.Role,
                def,
                origin,
                forward,
                hitSomething,
                hitPoint,
                damageApplied);
            EmitAcceptedShot(side, in shot);
            return true;
        }

        private void PresentGunfire(
            WeaponSide side,
            HertzWeaponDefinition def,
            Transform muzzle,
            Vector3 origin,
            Vector3 end,
            bool hitSomething,
            RaycastHit hit)
        {
            if (fireEffects == null) return;
            fireEffects.EnsurePools();
            var beforeSpawn = fireEffects.RuntimeSpawnCount;
            fireEffects.PlayMuzzle(muzzle);
            fireEffects.PlayTracer(origin, end);
            if (hitSomething) fireEffects.PlayImpact(hit.point, hit.normal);
            // Hot path must not grow the pool.
            if (fireEffects.RuntimeSpawnCount != beforeSpawn)
            {
                Debug.LogWarning("HertzWeaponFireEffects spawned during fire; pool warmup incomplete.");
            }

            if (side == WeaponSide.Left) _leftPresentationSequences++;
            else _rightPresentationSequences++;
        }

        private void EmitAcceptedShot(WeaponSide side, in HertzWeaponShotEvent shot)
        {
            if (side == WeaponSide.Left) _leftAcceptedShotSignals++;
            else _rightAcceptedShotSignals++;

            ShotAccepted?.Invoke(shot);
            ResolveAudioPresenter();
            if (_audioPresenter == null) return;

            _audioPresenter.PresentAcceptedShot(in shot);
            if (side == WeaponSide.Left) _leftPresenterDeliveries++;
            else _rightPresenterDeliveries++;
        }

        private void ApplyVisualRecoil(WeaponSide side, float amount)
        {
            var pivot = side == WeaponSide.Left ? _leftRecoilPivot : _rightRecoilPivot;
            if (pivot == null) return;
            var kick = Mathf.Max(0f, amount) * 0.05f;
            if (side == WeaponSide.Left)
            {
                _leftVisualRecoil += amount;
                pivot.localPosition = _leftRecoilRestLocal + new Vector3(0f, 0f, -kick);
            }
            else
            {
                _rightVisualRecoil += amount;
                pivot.localPosition = _rightRecoilRestLocal + new Vector3(0f, 0f, -kick);
            }
        }

        private static void RecoverRecoil(ref float accumulated, Transform pivot, Vector3 restLocal)
        {
            if (pivot == null) return;
            if (accumulated <= 0.0001f)
            {
                pivot.localPosition = restLocal;
                accumulated = 0f;
                return;
            }

            accumulated = Mathf.MoveTowards(accumulated, 0f, Time.deltaTime * 2.5f);
            var t = Mathf.Clamp01(accumulated);
            pivot.localPosition = restLocal + new Vector3(0f, 0f, -t * 0.05f);
        }

        private void TryHaptics(WeaponSide side)
        {
            if (!attemptControllerHaptics) return;
            var node = side == WeaponSide.Left ? XRNode.LeftHand : XRNode.RightHand;
            var device = InputDevices.GetDeviceAtXRNode(node);
            if (!device.isValid) return;
            if (!device.TryGetHapticCapabilities(out var caps) || !caps.supportsImpulse) return;
            device.SendHapticImpulse(0u, 0.25f, 0.04f);
        }

        public void ResetShotCounts()
        {
            _leftShotCount = 0;
            _rightShotCount = 0;
            _leftActivateCallbacks = 0;
            _rightActivateCallbacks = 0;
            _leftAcceptedShotSignals = 0;
            _rightAcceptedShotSignals = 0;
            _leftPresenterDeliveries = 0;
            _rightPresenterDeliveries = 0;
            _leftPresentationSequences = 0;
            _rightPresentationSequences = 0;
            _leftVisualRecoil = 0f;
            _rightVisualRecoil = 0f;
            _leftNextFireTime = 0f;
            _rightNextFireTime = 0f;
            if (fireEffects != null) fireEffects.ResetCounts();
            if (_leftRecoilPivot != null) _leftRecoilPivot.localPosition = _leftRecoilRestLocal;
            if (_rightRecoilPivot != null) _rightRecoilPivot.localPosition = _rightRecoilRestLocal;
        }

        public void RebindFromInspector()
        {
            ValidateAndBind();
        }

        /// <summary>
        /// Materialize left/right model instances the same way Play Mode OnEnable does.
        /// Safe to call repeatedly; previous *_Runtime clones are destroyed first.
        /// </summary>
        public void BindModelsAsInPlayMode()
        {
            _allowEditModeModelBind = true;
            ValidateAndBind();
            StripOwnedOrphanRuntimeClones();
        }

        public int CountAttachedRuntimeModels()
        {
            var n = 0;
            if (_leftModel != null) n++;
            if (_rightModel != null) n++;
            return n;
        }
    }
}
