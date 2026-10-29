using System;
using System.IO;
using System.Reflection;
using Hertz.Characters;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Hertz.EditorTools
{
    [InitializeOnLoad]
    internal static class HertzStudioAvatarProofCapture
    {
        private const string MenuPath = "HERTZ/Studio/Proofs/Avatar Full Body Capture";
        private const string PendingKey = "HERTZ.AvatarFullBodyProof.Pending";
        private const string ScenePath = "Assets/Scenes/HertzAvatarBodyTest.unity";
        private static int _playFrames;
        private static bool _capturing;

        [Serializable]
        private sealed class AvatarProofEvidence
        {
            public string capturedAtUtc;
            public string scenePath;
            public bool playMode;
            public bool headScaleIntact;
            public bool neckScaleIntact;
            public float leftHandToControllerMeters;
            public float rightHandToControllerMeters;
            public float hmdToAvatarEyeMeters;
            public Vector3 headLocalScale;
            public Vector3 neckLocalScale;
            public string note;
        }

        static HertzStudioAvatarProofCapture()
        {
            EditorApplication.playModeStateChanged -= OnPlayModeStateChanged;
            EditorApplication.playModeStateChanged += OnPlayModeStateChanged;
            EditorApplication.update -= OnEditorUpdate;
            EditorApplication.update += OnEditorUpdate;
        }

        [MenuItem(MenuPath)]
        private static void StartCapture()
        {
            if (EditorApplication.isPlayingOrWillChangePlaymode)
            {
                Debug.LogWarning("[HERTZ] Avatar proof capture is already entering or in Play Mode.");
                return;
            }

            DeletePriorPngBatch();
            EditorPrefs.SetBool(PendingKey, true);
            _playFrames = 0;
            EditorSceneManager.OpenScene(ScenePath, OpenSceneMode.Single);
            EditorApplication.isPlaying = true;
        }

        private static void OnPlayModeStateChanged(PlayModeStateChange state)
        {
            if (state == PlayModeStateChange.EnteredPlayMode && EditorPrefs.GetBool(PendingKey, false))
                _playFrames = 0;
        }

        private static void OnEditorUpdate()
        {
            if (!EditorPrefs.GetBool(PendingKey, false) || !EditorApplication.isPlaying || _capturing)
                return;

            _playFrames++;
            if (_playFrames < 20)
                return;

            _capturing = true;
            EditorPrefs.SetBool(PendingKey, false);
            try
            {
                CaptureInPlayMode();
                Debug.Log("[HERTZ] Avatar full-body proof capture complete.");
            }
            catch (Exception ex)
            {
                Debug.LogException(ex);
            }
            finally
            {
                _capturing = false;
                EditorApplication.isPlaying = false;
            }
        }

        private static void CaptureInPlayMode()
        {
            var avatar = UnityEngine.Object.FindFirstObjectByType<HertzXrTrackedBodyAvatar>();
            if (avatar == null)
                throw new InvalidOperationException("HertzXrTrackedBodyAvatar was not found in the proof scene.");

            avatar.EditorForceAlignNow();

            var headTarget = ReadTransform(avatar, "headCamera");
            var leftTarget = ReadTransform(avatar, "leftController");
            var rightTarget = ReadTransform(avatar, "rightController");
            var headCamera = headTarget != null ? headTarget.GetComponent<Camera>() : Camera.main;
            if (headCamera == null)
                throw new InvalidOperationException("Tracked head camera was not found.");

            var animator = avatar.GetComponent<Animator>();
            if (animator == null || !animator.isHuman)
                throw new InvalidOperationException("Avatar Animator is not Humanoid.");

            var originalHeadRotation = headTarget.rotation;
            try
            {
                // Temporary editor proof only (restored immediately): a slight look down is required to place hands
                // below eye height inside a normal HMD vertical field of view.
                headTarget.rotation = originalHeadRotation * Quaternion.Euler(18f, 0f, 0f);
                avatar.EditorForceAlignNow();
                var firstPersonBytes = RenderCamera(headCamera, 1280, 720);
                WritePngCopies("fp-arms-out.png", firstPersonBytes);
            }
            finally
            {
                headTarget.rotation = originalHeadRotation;
                avatar.EditorForceAlignNow();
            }

            var externalObject = new GameObject("HERTZ Avatar Proof Camera");
            try
            {
                var external = externalObject.AddComponent<Camera>();
                external.clearFlags = headCamera.clearFlags;
                external.backgroundColor = headCamera.backgroundColor;
                external.fieldOfView = 52f;
                external.nearClipPlane = 0.03f;
                external.farClipPlane = Mathf.Max(50f, headCamera.farClipPlane);
                external.cullingMask = -1;
                external.stereoTargetEye = StereoTargetEyeMask.None;

                var avatarRoot = avatar.transform;
                var focus = avatarRoot.position + Vector3.up * 1.0f;
                external.transform.position = avatarRoot.position
                                              + avatarRoot.forward * 1.9f
                                              + avatarRoot.right * 0.95f
                                              + Vector3.up * 1.35f;
                external.transform.rotation =
                    Quaternion.LookRotation(focus - external.transform.position, Vector3.up);

                avatar.EditorForceAlignNow();
                var externalBytes = RenderCamera(external, 1280, 720);
                WritePngCopies("third-arms-out.png", externalBytes);
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(externalObject);
            }

            WriteEvidence(avatar, animator, headTarget, leftTarget, rightTarget);
            AssetDatabase.Refresh(ImportAssetOptions.Default);
        }

        private static Transform ReadTransform(HertzXrTrackedBodyAvatar avatar, string fieldName)
        {
            var field = typeof(HertzXrTrackedBodyAvatar).GetField(
                fieldName,
                BindingFlags.Instance | BindingFlags.NonPublic);
            return field != null ? field.GetValue(avatar) as Transform : null;
        }

        private static byte[] RenderCamera(Camera camera, int width, int height)
        {
            var priorTarget = camera.targetTexture;
            var priorActive = RenderTexture.active;
            var priorStereo = camera.stereoTargetEye;
            var target = new RenderTexture(width, height, 24, RenderTextureFormat.ARGB32);
            var texture = new Texture2D(width, height, TextureFormat.RGB24, false);
            try
            {
                camera.stereoTargetEye = StereoTargetEyeMask.None;
                camera.targetTexture = target;
                RenderTexture.active = target;
                camera.Render();
                texture.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                texture.Apply(false, false);
                return texture.EncodeToPNG();
            }
            finally
            {
                camera.targetTexture = priorTarget;
                camera.stereoTargetEye = priorStereo;
                RenderTexture.active = priorActive;
                target.Release();
                UnityEngine.Object.DestroyImmediate(target);
                UnityEngine.Object.DestroyImmediate(texture);
            }
        }

        private static void WriteEvidence(
            HertzXrTrackedBodyAvatar avatar,
            Animator animator,
            Transform headTarget,
            Transform leftTarget,
            Transform rightTarget)
        {
            var head = animator.GetBoneTransform(HumanBodyBones.Head);
            var neck = animator.GetBoneTransform(HumanBodyBones.Neck);
            var leftHand = animator.GetBoneTransform(HumanBodyBones.LeftHand);
            var rightHand = animator.GetBoneTransform(HumanBodyBones.RightHand);
            var eyeOffsetField = typeof(HertzXrTrackedBodyAvatar).GetField(
                "eyeOffsetFromHeadBone",
                BindingFlags.Instance | BindingFlags.NonPublic);
            var eyeOffset = eyeOffsetField != null
                ? (Vector3)eyeOffsetField.GetValue(avatar)
                : new Vector3(0f, 0.02f, 0.08f);

            var evidence = new AvatarProofEvidence
            {
                capturedAtUtc = DateTime.UtcNow.ToString("O"),
                scenePath = SceneManager.GetActiveScene().path,
                playMode = Application.isPlaying,
                headScaleIntact = head != null && head.localScale.sqrMagnitude > 0.25f,
                neckScaleIntact = neck == null || neck.localScale.sqrMagnitude > 0.25f,
                leftHandToControllerMeters = leftHand != null && leftTarget != null
                    ? Vector3.Distance(leftHand.position, leftTarget.position)
                    : -1f,
                rightHandToControllerMeters = rightHand != null && rightTarget != null
                    ? Vector3.Distance(rightHand.position, rightTarget.position)
                    : -1f,
                hmdToAvatarEyeMeters = head != null && headTarget != null
                    ? Vector3.Distance(head.TransformPoint(eyeOffset), headTarget.position)
                    : -1f,
                headLocalScale = head != null ? head.localScale : Vector3.zero,
                neckLocalScale = neck != null ? neck.localScale : Vector3.one,
                note = "Static editor proof uses the scene's simulated controller transforms; headset fit remains a physical-device check."
            };

            var json = JsonUtility.ToJson(evidence, true);
            foreach (var directory in ProofDirectories())
            {
                Directory.CreateDirectory(directory);
                File.WriteAllText(Path.Combine(directory, "avatar-proof.json"), json);
            }
        }

        private static void WritePngCopies(string fileName, byte[] png)
        {
            foreach (var directory in ProofDirectories())
            {
                Directory.CreateDirectory(directory);
                File.WriteAllBytes(Path.Combine(directory, fileName), png);
            }
        }

        private static void DeletePriorPngBatch()
        {
            foreach (var directory in ProofDirectories())
            {
                if (!Directory.Exists(directory))
                    continue;
                foreach (var path in Directory.GetFiles(directory, "*.png", SearchOption.TopDirectoryOnly))
                    File.Delete(path);
            }
        }

        private static string[] ProofDirectories()
        {
            var projectRoot = Directory.GetParent(Application.dataPath).FullName;
            return new[]
            {
                Path.Combine(projectRoot, "Assets", "HertzStudio", "Characters", "KingsleyAvatar", "Previews"),
                Path.Combine(projectRoot, "Tools", "HertzStudio", "data", "avatar-previews"),
                Path.Combine(projectRoot, "Tools", "HertzStudio", "web", "public", "avatar-previews")
            };
        }
    }
}




