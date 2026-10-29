using UnityEngine;

namespace Hertz.Characters
{
    /// <summary>
    /// First-person arms-only rig (non-Humanoid) that follows the tracked HMD and controllers.
    /// The viewpoint stays the tracked HMD â€” this component never moves the XR camera.
    /// Restores bind pose each frame, then UpperArmâ†’Elbowâ†’Hand two-bone IK to controllers.
    /// Sketchfab .L/.R names on this asset are mirrored vs the viewer â€” sides are assigned
    /// by world position relative to the HMD, not by the bone name suffix.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class HertzXrFpsArmRig : MonoBehaviour
    {
        public const float HandComfortMinFromTorsoMeters = 0.45f;
        public const float HandComfortMaxFromTorsoMeters = 0.60f;
        public const float DefaultTargetArmLengthMeters = 0.65f;

        [SerializeField] private Transform headCamera;
        [SerializeField] private Transform leftController;
        [SerializeField] private Transform rightController;

        [Header("Bones (auto-bound by viewer side)")]
        [SerializeField] private Transform leftUpperArm;
        [SerializeField] private Transform leftElbow;
        [SerializeField] private Transform leftForearm;
        [SerializeField] private Transform leftHand;
        [SerializeField] private Transform rightUpperArm;
        [SerializeField] private Transform rightElbow;
        [SerializeField] private Transform rightForearm;
        [SerializeField] private Transform rightHand;

        [Tooltip("Local offset from the HMD to the shoulder mid-point (meters). Low in the view so holding controllers out shows shoulderâ†’hand length.")]
        [SerializeField] private Vector3 rootLocalOffsetFromCamera = new Vector3(0f, -0.25f, -0.10f);

        [Tooltip("Extra Euler after aligning hand axes to the controller. Keep near zero so an upright controller keeps the hand vertical.")]
        [SerializeField] private Vector3 leftHandRotationOffsetEuler = Vector3.zero;

        [SerializeField] private Vector3 rightHandRotationOffsetEuler = Vector3.zero;

        [Tooltip("If true, pulls very-close hands out to ~0.45 m. Leave false so tracked motion is 1:1.")]
        [SerializeField] private bool enforceHandComfortFloor;

        [SerializeField] private float handMinDistanceFromTorso = HandComfortMinFromTorsoMeters;

        [Tooltip("Uniform-scale the imported model so rest shoulderâ†’hand length matches this (meters). Fixes cm-scale GLBs.")]
        [SerializeField] private bool normalizeArmLength = true;

        [SerializeField] private float targetArmLengthMeters = DefaultTargetArmLengthMeters;
        [SerializeField] private float minCameraNearClip = 0.05f;
        [SerializeField] private bool parentToCamera = true;
        [SerializeField] private GameObject[] disableWhenActive;

        private float _leftUpperLen = -1f;
        private float _leftLowerLen = -1f;
        private float _rightUpperLen = -1f;
        private float _rightLowerLen = -1f;
        private bool _loggedMissing;
        private bool _scaled;
        private bool _bindCached;
        private Vector3 _baseScale = Vector3.one;
        private Quaternion _leftHandAlign = Quaternion.identity;
        private Quaternion _rightHandAlign = Quaternion.identity;
        private Camera _headCameraComponent;

        private Transform _leftShoulder;
        private Transform _rightShoulder;
        private Transform[] _bindBones;
        private Quaternion[] _bindLocalRotations;
        private Vector3[] _bindLocalPositions;

        private void Awake()
        {
            _baseScale = transform.localScale;
            ResolveBones();
            NormalizeModelScale();
            CacheRestLengths();
            CacheBindPose();
            CacheHandAlign();
            EnsureCameraNearClip();

            if (disableWhenActive == null)
                return;

            for (var i = 0; i < disableWhenActive.Length; i++)
            {
                if (disableWhenActive[i] != null)
                    disableWhenActive[i].SetActive(false);
            }
        }

        private void OnEnable()
        {
            ResolveBones();
            NormalizeModelScale();
            CacheRestLengths();
            CacheBindPose();
            CacheHandAlign();
            Application.onBeforeRender += DriveArms;
        }

        private void OnDisable()
        {
            Application.onBeforeRender -= DriveArms;
        }

        private void LateUpdate()
        {
            DriveArms();
        }

        /// <summary>Editor/play proof helper: run one align+IK pass immediately.</summary>
        public void DriveOnceForProof()
        {
            ResolveBones();
            NormalizeModelScale();
            if (!_bindCached)
                CacheBindPose();
            CacheRestLengths();
            CacheHandAlign();
            DriveArms();
        }

        private void DriveArms()
        {
            if (headCamera == null)
            {
                LogMissingOnce();
                return;
            }

            AlignRootToCamera();
            RestoreBindPose();
            SolveArm(
                leftUpperArm,
                leftElbow,
                leftForearm,
                leftHand,
                leftController,
                _leftHandAlign,
                leftHandRotationOffsetEuler,
                -1f,
                ref _leftUpperLen,
                ref _leftLowerLen);
            SolveArm(
                rightUpperArm,
                rightElbow,
                rightForearm,
                rightHand,
                rightController,
                _rightHandAlign,
                rightHandRotationOffsetEuler,
                1f,
                ref _rightUpperLen,
                ref _rightLowerLen);
        }

        private void AlignRootToCamera()
        {
            var root = transform;
            if (_baseScale.sqrMagnitude < 1e-8f)
                _baseScale = root.localScale;

            float probeUpper, probeLower;
            MeasureSide(leftUpperArm, leftElbow, leftHand, out probeUpper, out probeLower);
            if (probeUpper + probeLower > 1.5f)
            {
                _scaled = false;
                NormalizeModelScale();
            }

            if (_baseScale.sqrMagnitude < 1e-8f || _baseScale.x > 0.5f)
                _baseScale = root.localScale.x > 0.5f ? Vector3.one * 0.01f : root.localScale;

            if (parentToCamera && root.parent != headCamera)
                root.SetParent(headCamera, false);

            if (parentToCamera)
            {
                root.localScale = _baseScale;
                root.localRotation = Quaternion.identity;
                root.localPosition = Vector3.zero;
            }
            else
            {
                root.localScale = _baseScale;
                root.rotation = headCamera.rotation;
                root.position = headCamera.position;
            }

            if (leftUpperArm != null && rightUpperArm != null)
            {
                var mid = 0.5f * (leftUpperArm.position + rightUpperArm.position);
                var desired = headCamera.TransformPoint(rootLocalOffsetFromCamera);
                root.position += desired - mid;
            }
            else if (parentToCamera)
            {
                root.localPosition = rootLocalOffsetFromCamera;
            }
            else
            {
                root.position = headCamera.TransformPoint(rootLocalOffsetFromCamera);
            }
        }

        private void NormalizeModelScale()
        {
            if (_scaled || !normalizeArmLength)
                return;

            ResolveBones();
            float upper;
            float lower;
            MeasureSide(leftUpperArm, leftElbow, leftHand, out upper, out lower);
            if (upper < 0.01f || lower < 0.01f)
                MeasureSide(rightUpperArm, rightElbow, rightHand, out upper, out lower);
            if (upper < 0.01f || lower < 0.01f)
                return;

            var current = upper + lower;
            var target = Mathf.Clamp(targetArmLengthMeters, 0.35f, 0.90f);
            if (current < 0.05f)
                return;

            if (current <= 1.5f)
            {
                _baseScale = transform.localScale;
                _scaled = true;
                return;
            }

            var factor = target / current;
            transform.localScale = transform.localScale * factor;
            _baseScale = transform.localScale;
            _scaled = true;
            _leftUpperLen = -1f;
            _leftLowerLen = -1f;
            _rightUpperLen = -1f;
            _rightLowerLen = -1f;
            _bindCached = false;
        }

        private void SolveArm(
            Transform upper,
            Transform elbow,
            Transform forearm,
            Transform hand,
            Transform controller,
            Quaternion handAlign,
            Vector3 handRotOffsetEuler,
            float elbowOutSign,
            ref float upperLen,
            ref float lowerLen)
        {
            if (upper == null || elbow == null || hand == null || controller == null)
                return;

            if (upperLen < 0.01f || lowerLen < 0.01f)
                MeasureSide(upper, elbow, hand, out upperLen, out lowerLen);
            if (upperLen < 0.01f || lowerLen < 0.01f)
                return;

            var targetPos = enforceHandComfortFloor
                ? EnforceMinHandDistanceFromTorso(controller.position)
                : controller.position;

            var rootPos = upper.position;
            var toTarget = targetPos - rootPos;
            var dist = toTarget.magnitude;
            var maxReach = upperLen + lowerLen - 0.001f;
            var minReach = Mathf.Abs(upperLen - lowerLen) + 0.001f;
            if (dist < minReach)
                dist = minReach;
            if (dist > maxReach)
            {
                toTarget = toTarget.normalized * maxReach;
                dist = maxReach;
                targetPos = rootPos + toTarget;
            }

            var pole = rootPos + Vector3.down;
            if (headCamera != null)
            {
                pole = rootPos
                    + headCamera.up * -0.35f
                    + headCamera.right * (0.18f * elbowOutSign)
                    + headCamera.forward * -0.05f;
            }

            var cosAngle = (upperLen * upperLen + dist * dist - lowerLen * lowerLen) / (2f * upperLen * dist);
            cosAngle = Mathf.Clamp(cosAngle, -1f, 1f);
            var upperAngle = Mathf.Acos(cosAngle);

            var dir = toTarget / dist;
            var bendAxis = Vector3.Cross(dir, (pole - rootPos).normalized);
            if (bendAxis.sqrMagnitude < 1e-6f)
                bendAxis = Vector3.Cross(dir, headCamera != null ? headCamera.up : Vector3.up);
            if (bendAxis.sqrMagnitude < 1e-6f)
                bendAxis = Vector3.right;
            bendAxis.Normalize();

            var upperDir = Quaternion.AngleAxis(-upperAngle * Mathf.Rad2Deg, bendAxis) * dir;
            var elbowPos = rootPos + upperDir * upperLen;

            AimBone(upper, elbow, elbowPos);
            AimBone(elbow, hand, targetPos);
            // Straighten the mid forearm bone so the lower arm reads as one clean segment.
            if (forearm != null)
                AimBone(forearm, hand, targetPos);

            // Fingers â†’ controller.forward, upright â†’ controller.up.
            hand.rotation = controller.rotation * handAlign * Quaternion.Euler(handRotOffsetEuler);
        }

        private static void AimBone(Transform bone, Transform tip, Vector3 worldTarget)
        {
            if (bone == null || tip == null)
                return;

            var from = tip.position - bone.position;
            var to = worldTarget - bone.position;
            if (from.sqrMagnitude < 1e-8f || to.sqrMagnitude < 1e-8f)
                return;

            bone.rotation = Quaternion.FromToRotation(from, to) * bone.rotation;
        }

        private Vector3 EnforceMinHandDistanceFromTorso(Vector3 handPos)
        {
            var minDist = Mathf.Clamp(
                handMinDistanceFromTorso,
                HandComfortMinFromTorsoMeters,
                HandComfortMaxFromTorsoMeters);
            if (minDist < 0.01f || headCamera == null)
                return handPos;

            var torso = headCamera.position - headCamera.up * 0.28f;
            var fromTorso = handPos - torso;
            var flat = fromTorso;
            flat.y = 0f;
            if (flat.sqrMagnitude < 0.0001f)
            {
                var forward = headCamera.forward;
                forward.y = 0f;
                if (forward.sqrMagnitude < 0.0001f)
                    forward = Vector3.forward;
                flat = forward.normalized * minDist;
                return torso + flat + Vector3.up * fromTorso.y;
            }

            var flatDist = flat.magnitude;
            if (flatDist >= minDist)
                return handPos;

            flat *= minDist / flatDist;
            return torso + flat + Vector3.up * fromTorso.y;
        }

        private void ResolveBones()
        {
            // This Sketchfab rig labels .L/.R opposite the viewer once parented to the HMD
            // (Upper Arm.L sits on camera-right). Assign by world side, not name suffix.
            var shoulderA = FindDeep("Shoulder.L_44");
            var shoulderB = FindDeep("Shoulder.R_20");
            var upperA = FindDeep("Upper Arm.L_43");
            var upperB = FindDeep("Upper Arm.R_19");
            var elbowA = FindDeep("Elbow.L_42");
            var elbowB = FindDeep("Elbow.R_18");
            var forearmA = FindDeep("Forearm.L_41");
            var forearmB = FindDeep("Forearm.R_17");
            var handA = FindDeep("Hand.L_40");
            var handB = FindDeep("Hand.R_16");

            if (upperA == null || upperB == null || headCamera == null)
            {
                leftUpperArm = upperB != null ? upperB : upperA;
                leftElbow = elbowB != null ? elbowB : elbowA;
                leftForearm = forearmB != null ? forearmB : forearmA;
                leftHand = handB != null ? handB : handA;
                rightUpperArm = upperA != null ? upperA : upperB;
                rightElbow = elbowA != null ? elbowA : elbowB;
                rightForearm = forearmA != null ? forearmA : forearmB;
                rightHand = handA != null ? handA : handB;
                _leftShoulder = shoulderB != null ? shoulderB : shoulderA;
                _rightShoulder = shoulderA != null ? shoulderA : shoulderB;
                return;
            }

            var camRight = headCamera.right;
            var mid = 0.5f * (upperA.position + upperB.position);
            var aOnRight = Vector3.Dot(upperA.position - mid, camRight) >= 0f;

            if (aOnRight)
            {
                leftUpperArm = upperB;
                leftElbow = elbowB;
                leftForearm = forearmB;
                leftHand = handB;
                _leftShoulder = shoulderB;
                rightUpperArm = upperA;
                rightElbow = elbowA;
                rightForearm = forearmA;
                rightHand = handA;
                _rightShoulder = shoulderA;
            }
            else
            {
                leftUpperArm = upperA;
                leftElbow = elbowA;
                leftForearm = forearmA;
                leftHand = handA;
                _leftShoulder = shoulderA;
                rightUpperArm = upperB;
                rightElbow = elbowB;
                rightForearm = forearmB;
                rightHand = handB;
                _rightShoulder = shoulderB;
            }
        }

        private void CacheBindPose()
        {
            if (_bindCached)
                return;

            _bindBones = new[]
            {
                _leftShoulder, leftUpperArm, leftElbow, leftForearm, leftHand,
                _rightShoulder, rightUpperArm, rightElbow, rightForearm, rightHand,
                FindDeep("Root_45")
            };
            _bindLocalRotations = new Quaternion[_bindBones.Length];
            _bindLocalPositions = new Vector3[_bindBones.Length];
            for (var i = 0; i < _bindBones.Length; i++)
            {
                var bone = _bindBones[i];
                if (bone == null)
                    continue;
                _bindLocalRotations[i] = bone.localRotation;
                _bindLocalPositions[i] = bone.localPosition;
            }

            _bindCached = true;
        }

        private void RestoreBindPose()
        {
            if (!_bindCached)
                CacheBindPose();
            if (_bindBones == null || _bindLocalRotations == null)
                return;

            for (var i = 0; i < _bindBones.Length; i++)
            {
                var bone = _bindBones[i];
                if (bone == null)
                    continue;
                bone.localRotation = _bindLocalRotations[i];
                bone.localPosition = _bindLocalPositions[i];
            }
        }

        /// <summary>
        /// Maps this rig's axes (local up = fingers, local forward = down) onto the controller
        /// so fingers → controller.forward and upright → controller.up. Same align on both
        /// sides — the asset's L/R bones are already mirrored.
        /// </summary>
        private void CacheHandAlign()
        {
            // align * up = forward; align * forward = -up
            _leftHandAlign = Quaternion.LookRotation(-Vector3.up, Vector3.forward);
            _rightHandAlign = _leftHandAlign;
        }

        private Transform FindDeep(string exactName)
        {
            var all = GetComponentsInChildren<Transform>(true);
            for (var i = 0; i < all.Length; i++)
            {
                if (all[i] != null && all[i].name == exactName)
                    return all[i];
            }

            var renderers = GetComponentsInChildren<SkinnedMeshRenderer>(true);
            for (var r = 0; r < renderers.Length; r++)
            {
                var bones = renderers[r] != null ? renderers[r].bones : null;
                if (bones == null)
                    continue;
                for (var i = 0; i < bones.Length; i++)
                {
                    if (bones[i] != null && bones[i].name == exactName)
                        return bones[i];
                }
            }

            return null;
        }

        private void CacheRestLengths()
        {
            MeasureSide(leftUpperArm, leftElbow, leftHand, out _leftUpperLen, out _leftLowerLen);
            MeasureSide(rightUpperArm, rightElbow, rightHand, out _rightUpperLen, out _rightLowerLen);
        }

        private static void MeasureSide(Transform upper, Transform elbow, Transform hand, out float upperLen, out float lowerLen)
        {
            upperLen = -1f;
            lowerLen = -1f;
            if (upper == null || elbow == null || hand == null)
                return;

            upperLen = Vector3.Distance(upper.position, elbow.position);
            lowerLen = Vector3.Distance(elbow.position, hand.position);
        }

        private void EnsureCameraNearClip()
        {
            if (headCamera == null)
                return;

            _headCameraComponent = headCamera.GetComponent<Camera>();
            if (_headCameraComponent == null)
                return;

            if (_headCameraComponent.nearClipPlane < minCameraNearClip)
                _headCameraComponent.nearClipPlane = minCameraNearClip;
        }

        private void LogMissingOnce()
        {
            if (_loggedMissing)
                return;
            _loggedMissing = true;
            Debug.LogWarning("[HertzXrFpsArmRig] Missing headCamera on " + name, this);
        }

#if UNITY_EDITOR
        private void OnValidate()
        {
            handMinDistanceFromTorso = Mathf.Clamp(
                handMinDistanceFromTorso,
                HandComfortMinFromTorsoMeters,
                HandComfortMaxFromTorsoMeters);
            targetArmLengthMeters = Mathf.Clamp(targetArmLengthMeters, 0.35f, 0.90f);
        }
#endif
    }
}

