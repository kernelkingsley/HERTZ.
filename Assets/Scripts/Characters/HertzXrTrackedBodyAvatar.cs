using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Serialization;

namespace Hertz.Characters
{
    /// <summary>
    /// Drives a Humanoid full-body avatar from the existing XR camera and controllers.
    /// XR tracking remains authoritative; this component never moves the XR rig.
    /// </summary>
    [DisallowMultipleComponent]
    [RequireComponent(typeof(Animator))]
    public sealed class HertzXrTrackedBodyAvatar : MonoBehaviour
    {
        [SerializeField] private Animator animator;
        [SerializeField] private Transform headCamera;
        [SerializeField] private Transform leftController;
        [SerializeField] private Transform rightController;
        [SerializeField] private Vector3 eyeOffsetFromHeadBone = new Vector3(0f, 0.02f, 0.08f);
        [Tooltip("Positive distance places the avatar face behind the tracked HMD.")]
        [SerializeField] private float bodyBehindCameraMeters = 0.08f;
        [Tooltip("Small vertical offset that places the avatar eye point below the HMD.")]
        [SerializeField] private float bodyBelowCameraMeters = 0.02f;
        [FormerlySerializedAs("handMinDistanceFromCamera")]
        [SerializeField, HideInInspector] private float handMinDistanceFromTorso = 0.45f;
        [SerializeField] private Vector3 headRotationOffsetEuler;
        [Tooltip("Fine adjustment after automatic hand-axis calibration.")]
        [SerializeField] private Vector3 leftHandRotationOffsetEuler;
        [Tooltip("Fine adjustment after automatic hand-axis calibration.")]
        [SerializeField] private Vector3 rightHandRotationOffsetEuler;
        [SerializeField, Range(0f, 1f)] private float handIkWeight = 1f;
        [SerializeField] private float bodyYawFollowDegreesPerSecond = 360f;
        [SerializeField] private bool hideHeadRenderers = true;
        [SerializeField] private bool driveHeadLook = true;
        [SerializeField] private int firstPersonHiddenLayer = 30;

        [Header("Arm bend")]
        [SerializeField] private float elbowOutwardMeters = 0.22f;
        [SerializeField] private float elbowDownMeters = 0.18f;
        [SerializeField] private float elbowBackMeters = 0.04f;

        [Header("Head look")]
        [SerializeField] private float maxLookDownDegrees = 28f;
        [SerializeField] private float maxLookUpDegrees = 40f;
        [SerializeField] private float hideUpperChestPitchDegrees = 22f;
        [SerializeField] private float minCameraNearClip = 0.05f;

        [Header("Scale")]
        [SerializeField] private bool matchHeightToHmd = true;
        [SerializeField] private float heightScaleMultiplier = 1f;
        [SerializeField] private float minHeightScale = 0.7f;
        [SerializeField] private float maxHeightScale = 1.35f;
        [SerializeField] private GameObject[] disableWhenActive;

        private Transform _headBone;
        private Transform _neckBone;
        private Transform _chestBone;
        private Transform _leftUpperArm;
        private Transform _rightUpperArm;
        private Transform _leftLowerArm;
        private Transform _rightLowerArm;
        private Transform _leftHandBone;
        private Transform _rightHandBone;
        private Transform _leftMiddleFinger;
        private Transform _rightMiddleFinger;
        private Transform _leftIndexFinger;
        private Transform _rightIndexFinger;
        private Transform _leftLittleFinger;
        private Transform _rightLittleFinger;

        private Transform[] _bindBones;
        private Quaternion[] _bindLocalRotations;
        private Vector3[] _bindLocalPositions;
        private bool _bindPoseCached;
        private Vector3 _baseScale = Vector3.one;
        private float _restHeadHeightLocal = -1f;
        private Quaternion _leftControllerToHand = Quaternion.identity;
        private Quaternion _rightControllerToHand = Quaternion.identity;
        private bool _loggedMissing;

        private Camera _headCameraComponent;
        private int _originalCameraCullingMask;
        private bool _cameraMaskCaptured;
        private GameObject[] _firstPersonHiddenObjects;
        private int[] _firstPersonOriginalLayers;
        private bool[] _disabledVisualOriginalStates;
        private Renderer[] _upperChestRenderers;
        private bool[] _upperChestWasEnabled;
        private bool _upperChestHidden;

        private void Awake()
        {
            if (animator == null)
                animator = GetComponent<Animator>();
            _baseScale = transform.localScale;
            if (animator != null)
            {
                animator.runtimeAnimatorController = null;
                animator.enabled = false;
            }
            CacheBones();
            CacheBindPose();
            CacheRestHeadHeight();
            CacheHandAxisCalibration();
            CacheUpperChestRenderers();
            CacheDisabledVisualStates();
            EnsureCameraNearClip();
        }

        private void OnEnable()
        {
            CacheBones();
            DisableTrackedVisuals();
            ConfigureFirstPersonVisibility();
            Application.onBeforeRender += UpdateAvatarPose;
        }

        private void OnDisable()
        {
            Application.onBeforeRender -= UpdateAvatarPose;
            RestoreUpperChestVisibility();
            RestoreFirstPersonVisibility();
            RestoreTrackedVisuals();
        }

        private void OnDestroy()
        {
            RestoreFirstPersonVisibility();
            RestoreTrackedVisuals();
        }

        private void LateUpdate()
        {
            UpdateAvatarPose();
        }

        private void UpdateAvatarPose()
        {
            if (animator == null || !animator.isHuman || headCamera == null)
            {
                LogMissingOnce();
                return;
            }
            RestoreBindPose();
            AlignBodyAndHeadToHmd();
            SolveTrackedArms();
        }

        private void AlignBodyAndHeadToHmd()
        {
            if (_headBone == null)
                CacheBones();
            if (_headBone == null)
                return;

            var root = transform;
            var flatForward = headCamera.forward;
            flatForward.y = 0f;
            if (flatForward.sqrMagnitude < 0.0001f)
                flatForward = root.forward;
            flatForward.Normalize();

            var targetYaw = Quaternion.LookRotation(flatForward, Vector3.up);
            var step = bodyYawFollowDegreesPerSecond * Time.deltaTime;
            root.rotation = step <= 0f || float.IsNaN(step)
                ? targetYaw
                : Quaternion.RotateTowards(root.rotation, targetYaw, step);

            if (_restHeadHeightLocal < 0.05f)
                CacheRestHeadHeight();

            var scale = 1f;
            if (matchHeightToHmd && _restHeadHeightLocal > 0.05f)
            {
                var eyeHeight = Mathf.Max(0.5f, headCamera.position.y - ResolveFloorY(root));
                scale = eyeHeight / _restHeadHeightLocal;
                scale *= Mathf.Clamp(heightScaleMultiplier, 0.5f, 1.25f);
            }
            scale = Mathf.Clamp(scale, minHeightScale, maxHeightScale);
            root.localScale = _baseScale * scale;

            var desiredEye = headCamera.position
                             - flatForward * Mathf.Clamp(bodyBehindCameraMeters, 0f, 0.20f)
                             - Vector3.up * Mathf.Clamp(bodyBelowCameraMeters, 0f, 0.12f);
            root.position += desiredEye - _headBone.TransformPoint(eyeOffsetFromHeadBone);

            if (driveHeadLook)
            {
                var desired = headCamera.rotation * Quaternion.Euler(headRotationOffsetEuler);
                _headBone.rotation = ClampHeadPitch(desired, root.rotation);
            }
            UpdateUpperChestVisibilityForPitch(headCamera);
        }

        private void SolveTrackedArms()
        {
            var weight = Mathf.Clamp01(handIkWeight);
            if (weight <= 0f)
                return;
            SolveArm(_leftUpperArm, _leftLowerArm, _leftHandBone, leftController,
                _leftControllerToHand, leftHandRotationOffsetEuler, -1f, weight);
            SolveArm(_rightUpperArm, _rightLowerArm, _rightHandBone, rightController,
                _rightControllerToHand, rightHandRotationOffsetEuler, 1f, weight);
        }

        private void SolveArm(
            Transform upperArm,
            Transform lowerArm,
            Transform hand,
            Transform target,
            Quaternion controllerToHand,
            Vector3 fineRotationEuler,
            float side,
            float weight)
        {
            if (upperArm == null || lowerArm == null || hand == null || target == null)
                return;

            var originalUpper = upperArm.rotation;
            var originalLower = lowerArm.rotation;
            var originalHand = hand.rotation;
            var shoulder = upperArm.position;
            var upperLength = Vector3.Distance(shoulder, lowerArm.position);
            var lowerLength = Vector3.Distance(lowerArm.position, hand.position);
            if (upperLength < 0.001f || lowerLength < 0.001f)
                return;

            var toTarget = target.position - shoulder;
            var targetDistance = toTarget.magnitude;
            if (targetDistance < 0.001f)
                return;

            var targetDirection = toTarget / targetDistance;
            var maxReach = Mathf.Max(0.002f, upperLength + lowerLength - 0.002f);
            var minReach = Mathf.Abs(upperLength - lowerLength) + 0.002f;
            var solvedDistance = Mathf.Clamp(targetDistance, minReach, maxReach);
            var solvedHandPosition = shoulder + targetDirection * solvedDistance;

            var bodyRight = headCamera != null ? headCamera.right : transform.right;
            var bodyForward = headCamera != null ? headCamera.forward : transform.forward;
            bodyRight.y = 0f;
            bodyForward.y = 0f;
            if (bodyRight.sqrMagnitude < 0.0001f)
                bodyRight = transform.right;
            if (bodyForward.sqrMagnitude < 0.0001f)
                bodyForward = transform.forward;
            bodyRight.Normalize();
            bodyForward.Normalize();

            var poleDirection = bodyRight * side * elbowOutwardMeters
                                - Vector3.up * elbowDownMeters
                                - bodyForward * elbowBackMeters;
            var bendDirection = poleDirection
                                - targetDirection * Vector3.Dot(poleDirection, targetDirection);
            if (bendDirection.sqrMagnitude < 0.0001f)
                bendDirection = Vector3.Cross(targetDirection, Vector3.up) * side;
            if (bendDirection.sqrMagnitude < 0.0001f)
                bendDirection = bodyRight * side;
            bendDirection.Normalize();

            var along = (upperLength * upperLength + solvedDistance * solvedDistance
                         - lowerLength * lowerLength) / (2f * solvedDistance);
            along = Mathf.Clamp(along, 0f, upperLength);
            var height = Mathf.Sqrt(Mathf.Max(0f, upperLength * upperLength - along * along));
            var elbowPosition = shoulder + targetDirection * along + bendDirection * height;

            AimBoneAt(upperArm, lowerArm.position, elbowPosition);
            AimBoneAt(lowerArm, hand.position, solvedHandPosition);
            hand.rotation = target.rotation
                            * Quaternion.Euler(fineRotationEuler)
                            * controllerToHand;

            if (weight < 0.999f)
            {
                upperArm.rotation = Quaternion.Slerp(originalUpper, upperArm.rotation, weight);
                lowerArm.rotation = Quaternion.Slerp(originalLower, lowerArm.rotation, weight);
                hand.rotation = Quaternion.Slerp(originalHand, hand.rotation, weight);
            }
        }

        private static void AimBoneAt(Transform bone, Vector3 currentTip, Vector3 desiredTip)
        {
            var from = currentTip - bone.position;
            var to = desiredTip - bone.position;
            if (from.sqrMagnitude < 0.000001f || to.sqrMagnitude < 0.000001f)
                return;
            bone.rotation = Quaternion.FromToRotation(from, to) * bone.rotation;
        }

        private void CacheHandAxisCalibration()
        {
            TryBuildControllerToHand(_leftHandBone, _leftMiddleFinger,
                _leftIndexFinger, _leftLittleFinger, out _leftControllerToHand);
            TryBuildControllerToHand(_rightHandBone, _rightMiddleFinger,
                _rightIndexFinger, _rightLittleFinger, out _rightControllerToHand);
        }

        private bool TryBuildControllerToHand(
            Transform hand,
            Transform middleFinger,
            Transform indexFinger,
            Transform littleFinger,
            out Quaternion controllerToHand)
        {
            controllerToHand = Quaternion.identity;
            if (hand == null || middleFinger == null || indexFinger == null || littleFinger == null)
                return false;

            var fingerForward = middleFinger.position - hand.position;
            var acrossPalm = indexFinger.position - littleFinger.position;
            if (fingerForward.sqrMagnitude < 0.000001f || acrossPalm.sqrMagnitude < 0.000001f)
                return false;

            var handUp = Vector3.Cross(fingerForward, acrossPalm);
            if (handUp.sqrMagnitude < 0.000001f)
                return false;
            if (Vector3.Dot(handUp, transform.up) < 0f)
                handUp = -handUp;

            var handBasis = Quaternion.LookRotation(fingerForward.normalized, handUp.normalized);
            controllerToHand = Quaternion.Inverse(handBasis) * hand.rotation;
            return true;
        }

        private Quaternion ClampHeadPitch(Quaternion desiredWorld, Quaternion bodyWorld)
        {
            var local = Quaternion.Inverse(bodyWorld) * desiredWorld;
            var euler = local.eulerAngles;
            var pitch = euler.x > 180f ? euler.x - 360f : euler.x;
            pitch = Mathf.Clamp(pitch,
                -Mathf.Max(0f, maxLookUpDegrees),
                Mathf.Max(0f, maxLookDownDegrees));
            return bodyWorld * Quaternion.Euler(pitch, euler.y, euler.z);
        }

        private static float ResolveFloorY(Transform root)
        {
            var floorY = root.parent != null ? root.parent.position.y : 0f;
            var xrRoot = root.parent != null ? root.parent.parent : null;
            return xrRoot != null ? xrRoot.position.y : floorY;
        }

        private void CacheBones()
        {
            if (animator == null || !animator.isHuman)
            {
                _headBone = null;
                _neckBone = null;
                _chestBone = null;
                _leftUpperArm = null;
                _rightUpperArm = null;
                _leftLowerArm = null;
                _rightLowerArm = null;
                _leftHandBone = null;
                _rightHandBone = null;
                return;
            }

            _headBone = animator.GetBoneTransform(HumanBodyBones.Head);
            _neckBone = animator.GetBoneTransform(HumanBodyBones.Neck);
            _chestBone = animator.GetBoneTransform(HumanBodyBones.Chest);
            if (_chestBone == null)
                _chestBone = animator.GetBoneTransform(HumanBodyBones.Spine);
            _leftUpperArm = animator.GetBoneTransform(HumanBodyBones.LeftUpperArm);
            _rightUpperArm = animator.GetBoneTransform(HumanBodyBones.RightUpperArm);
            _leftLowerArm = animator.GetBoneTransform(HumanBodyBones.LeftLowerArm);
            _rightLowerArm = animator.GetBoneTransform(HumanBodyBones.RightLowerArm);
            _leftHandBone = animator.GetBoneTransform(HumanBodyBones.LeftHand);
            _rightHandBone = animator.GetBoneTransform(HumanBodyBones.RightHand);
            _leftMiddleFinger = animator.GetBoneTransform(HumanBodyBones.LeftMiddleProximal);
            _rightMiddleFinger = animator.GetBoneTransform(HumanBodyBones.RightMiddleProximal);
            _leftIndexFinger = animator.GetBoneTransform(HumanBodyBones.LeftIndexProximal);
            _rightIndexFinger = animator.GetBoneTransform(HumanBodyBones.RightIndexProximal);
            _leftLittleFinger = animator.GetBoneTransform(HumanBodyBones.LeftLittleProximal);
            _rightLittleFinger = animator.GetBoneTransform(HumanBodyBones.RightLittleProximal);
        }

        private void CacheBindPose()
        {
            _bindPoseCached = false;
            if (animator == null)
                return;

            var bones = new List<Transform>(64);
            if (animator.isHuman)
            {
                for (var i = 0; i < (int)HumanBodyBones.LastBone; i++)
                {
                    var bone = animator.GetBoneTransform((HumanBodyBones)i);
                    if (bone != null && !bones.Contains(bone))
                        bones.Add(bone);
                }
            }
            if (bones.Count == 0)
            {
                var all = GetComponentsInChildren<Transform>(true);
                for (var i = 0; i < all.Length; i++)
                {
                    if (all[i] != null && all[i] != transform)
                        bones.Add(all[i]);
                }
            }

            _bindBones = bones.ToArray();
            _bindLocalRotations = new Quaternion[_bindBones.Length];
            _bindLocalPositions = new Vector3[_bindBones.Length];
            for (var i = 0; i < _bindBones.Length; i++)
            {
                _bindLocalRotations[i] = _bindBones[i].localRotation;
                _bindLocalPositions[i] = _bindBones[i].localPosition;
            }
            _bindPoseCached = _bindBones.Length > 0;
        }

        private void RestoreBindPose()
        {
            if (!_bindPoseCached || _bindBones == null)
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

        private void CacheRestHeadHeight()
        {
            if (_headBone == null)
            {
                _restHeadHeightLocal = -1f;
                return;
            }
            var eye = _headBone.TransformPoint(eyeOffsetFromHeadBone);
            var scaleY = Mathf.Abs(transform.lossyScale.y);
            if (scaleY < 0.0001f)
                scaleY = 1f;
            _restHeadHeightLocal = (eye.y - transform.position.y) / scaleY;
            if (_restHeadHeightLocal < 0.5f)
                _restHeadHeightLocal = 1.6f;
        }

        private void EnsureCameraNearClip()
        {
            if (headCamera == null)
                return;
            _headCameraComponent = headCamera.GetComponent<Camera>();
            if (_headCameraComponent != null && _headCameraComponent.nearClipPlane < minCameraNearClip)
                _headCameraComponent.nearClipPlane = minCameraNearClip;
        }

        private void ConfigureFirstPersonVisibility()
        {
            RestoreFirstPersonVisibility();
            if (!hideHeadRenderers || headCamera == null
                || firstPersonHiddenLayer < 0 || firstPersonHiddenLayer > 31)
                return;

            _headCameraComponent = headCamera.GetComponent<Camera>();
            if (_headCameraComponent == null)
                return;

            var objects = new List<GameObject>(8);
            var layers = new List<int>(8);
            var renderers = GetComponentsInChildren<Renderer>(true);
            for (var i = 0; i < renderers.Length; i++)
            {
                var rendererObject = renderers[i] != null ? renderers[i].gameObject : null;
                if (rendererObject == null || !IsSeparateHeadObject(rendererObject.name)
                    || objects.Contains(rendererObject))
                    continue;
                objects.Add(rendererObject);
                layers.Add(rendererObject.layer);
                rendererObject.layer = firstPersonHiddenLayer;
            }

            _firstPersonHiddenObjects = objects.ToArray();
            _firstPersonOriginalLayers = layers.ToArray();
            _originalCameraCullingMask = _headCameraComponent.cullingMask;
            _cameraMaskCaptured = true;
            _headCameraComponent.cullingMask &= ~(1 << firstPersonHiddenLayer);
        }

        private static bool IsSeparateHeadObject(string objectName)
        {
            return objectName.IndexOf("hair", StringComparison.OrdinalIgnoreCase) >= 0
                   || objectName.IndexOf("face", StringComparison.OrdinalIgnoreCase) >= 0
                   || objectName.IndexOf("head", StringComparison.OrdinalIgnoreCase) >= 0
                   || objectName.IndexOf("neck", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private void RestoreFirstPersonVisibility()
        {
            if (_firstPersonHiddenObjects != null && _firstPersonOriginalLayers != null)
            {
                var count = Mathf.Min(_firstPersonHiddenObjects.Length, _firstPersonOriginalLayers.Length);
                for (var i = 0; i < count; i++)
                {
                    if (_firstPersonHiddenObjects[i] != null)
                        _firstPersonHiddenObjects[i].layer = _firstPersonOriginalLayers[i];
                }
            }
            if (_cameraMaskCaptured && _headCameraComponent != null)
                _headCameraComponent.cullingMask = _originalCameraCullingMask;
            _cameraMaskCaptured = false;
            _firstPersonHiddenObjects = null;
            _firstPersonOriginalLayers = null;
        }

        private void CacheDisabledVisualStates()
        {
            if (disableWhenActive == null)
                return;
            _disabledVisualOriginalStates = new bool[disableWhenActive.Length];
            for (var i = 0; i < disableWhenActive.Length; i++)
                _disabledVisualOriginalStates[i] =
                    disableWhenActive[i] != null && disableWhenActive[i].activeSelf;
        }

        private void DisableTrackedVisuals()
        {
            if (disableWhenActive == null)
                return;
            for (var i = 0; i < disableWhenActive.Length; i++)
            {
                if (disableWhenActive[i] != null)
                    disableWhenActive[i].SetActive(false);
            }
        }

        private void RestoreTrackedVisuals()
        {
            if (disableWhenActive == null || _disabledVisualOriginalStates == null)
                return;
            var count = Mathf.Min(disableWhenActive.Length, _disabledVisualOriginalStates.Length);
            for (var i = 0; i < count; i++)
            {
                if (disableWhenActive[i] != null)
                    disableWhenActive[i].SetActive(_disabledVisualOriginalStates[i]);
            }
        }

        private void CacheUpperChestRenderers()
        {
            var found = new List<Renderer>(4);
            var renderers = GetComponentsInChildren<Renderer>(true);
            for (var i = 0; i < renderers.Length; i++)
            {
                var renderer = renderers[i];
                if (renderer == null)
                    continue;
                var objectName = renderer.gameObject.name;
                if (objectName.IndexOf("collar", StringComparison.OrdinalIgnoreCase) >= 0
                    || objectName.IndexOf("hood", StringComparison.OrdinalIgnoreCase) >= 0
                    || objectName.IndexOf("cape", StringComparison.OrdinalIgnoreCase) >= 0)
                    found.Add(renderer);
            }
            _upperChestRenderers = found.ToArray();
            _upperChestWasEnabled = new bool[_upperChestRenderers.Length];
            for (var i = 0; i < _upperChestRenderers.Length; i++)
                _upperChestWasEnabled[i] =
                    _upperChestRenderers[i] != null && _upperChestRenderers[i].enabled;
        }

        private void UpdateUpperChestVisibilityForPitch(Transform cameraTransform)
        {
            if (_upperChestRenderers == null || _upperChestRenderers.Length == 0)
                return;
            var lookingDown =
                cameraTransform.forward.y < -Mathf.Sin(hideUpperChestPitchDegrees * Mathf.Deg2Rad);
            if (lookingDown == _upperChestHidden)
                return;
            _upperChestHidden = lookingDown;
            for (var i = 0; i < _upperChestRenderers.Length; i++)
            {
                if (_upperChestRenderers[i] != null)
                    _upperChestRenderers[i].enabled =
                        lookingDown ? false : _upperChestWasEnabled[i];
            }
        }

        private void RestoreUpperChestVisibility()
        {
            if (_upperChestRenderers == null)
                return;
            for (var i = 0; i < _upperChestRenderers.Length; i++)
            {
                if (_upperChestRenderers[i] != null)
                    _upperChestRenderers[i].enabled =
                        _upperChestWasEnabled != null
                        && i < _upperChestWasEnabled.Length
                        && _upperChestWasEnabled[i];
            }
            _upperChestHidden = false;
        }

        private void LogMissingOnce()
        {
            if (_loggedMissing)
                return;
            _loggedMissing = true;
            Debug.LogWarning(
                "[HERTZ] HertzXrTrackedBodyAvatar needs a Humanoid Animator plus the XR head camera and controller transforms.",
                this);
        }

#if UNITY_EDITOR
        private void OnValidate()
        {
            if (animator == null)
                animator = GetComponent<Animator>();
            bodyBehindCameraMeters = Mathf.Clamp(bodyBehindCameraMeters, 0f, 0.20f);
            bodyBelowCameraMeters = Mathf.Clamp(bodyBelowCameraMeters, 0f, 0.12f);
            handIkWeight = Mathf.Clamp01(handIkWeight);
            elbowOutwardMeters = Mathf.Clamp(elbowOutwardMeters, 0.02f, 0.60f);
            elbowDownMeters = Mathf.Clamp(elbowDownMeters, 0f, 0.60f);
            elbowBackMeters = Mathf.Clamp(elbowBackMeters, -0.20f, 0.30f);
            minCameraNearClip = Mathf.Clamp(minCameraNearClip, 0.03f, 0.15f);
            minHeightScale = Mathf.Max(0.1f, minHeightScale);
            maxHeightScale = Mathf.Max(minHeightScale, maxHeightScale);
        }

        public void EditorAssignTargets(
            Transform camera,
            Transform left,
            Transform right,
            GameObject[] disableVisuals)
        {
            headCamera = camera;
            leftController = left;
            rightController = right;
            disableWhenActive = disableVisuals;
        }

        public void EditorForceAlignNow()
        {
            UpdateAvatarPose();
        }
#endif
    }
}
