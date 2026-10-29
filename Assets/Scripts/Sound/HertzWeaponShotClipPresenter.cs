using Hertz.Weapons;
using UnityEngine;

namespace Hertz.Sound
{
    /// <summary>
    /// W07 runtime gunshot presenter — plays assigned clip on accepted shots.
    /// Silent when clip unassigned. Comfort: capped volume, no stacking beyond one-shots.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class HertzWeaponShotClipPresenter : MonoBehaviour, IHertzWeaponShotAudioPresenter
    {
        [SerializeField] private AudioClip leftShotClip;
        [SerializeField] private AudioClip rightShotClip;
        [SerializeField] [Range(0f, 1f)] private float volume = 0.7f;
        [SerializeField] private float spatialBlend = 1f;
        [SerializeField] private float maxDistance = 25f;

        private AudioSource _left;
        private AudioSource _right;
        private int _presentCount;

        public int PresentCount => _presentCount;
        public AudioClip LeftShotClip => leftShotClip;
        public AudioClip RightShotClip => rightShotClip;

        public void Configure(AudioClip left, AudioClip right, float vol = 0.7f)
        {
            leftShotClip = left;
            rightShotClip = right;
            volume = Mathf.Clamp01(vol);
            EnsureSources();
        }

        private void Awake() => EnsureSources();

        private void EnsureSources()
        {
            if (_left == null) _left = CreateSource("LeftShotAudio");
            if (_right == null) _right = CreateSource("RightShotAudio");
        }

        private AudioSource CreateSource(string name)
        {
            var go = new GameObject(name);
            go.transform.SetParent(transform, false);
            var src = go.AddComponent<AudioSource>();
            src.playOnAwake = false;
            src.loop = false;
            src.spatialBlend = spatialBlend;
            src.maxDistance = maxDistance;
            src.rolloffMode = AudioRolloffMode.Linear;
            src.volume = volume;
            return src;
        }

        public void PresentAcceptedShot(in HertzWeaponShotEvent shotEvent)
        {
            EnsureSources();
            var isRight = shotEvent.Side == HertzWeaponDefinition.WeaponRole.RightPistol;
            var clip = isRight ? rightShotClip : leftShotClip;
            if (clip == null) return;
            var src = isRight ? _right : _left;
            src.transform.position = shotEvent.MuzzlePosition;
            src.spatialBlend = spatialBlend;
            src.maxDistance = maxDistance;
            src.volume = volume;
            // One-shot: does not stack a second looping channel.
            src.PlayOneShot(clip, volume);
            _presentCount++;
        }
    }
}
