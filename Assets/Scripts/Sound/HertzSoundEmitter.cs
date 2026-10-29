using UnityEngine;

namespace Hertz.Sound
{
    /// <summary>
    /// W07 positioned scene emitter — volume/loop/spatial/attenuation from Studio sync.
    /// </summary>
    [DisallowMultipleComponent]
    [RequireComponent(typeof(AudioSource))]
    public sealed class HertzSoundEmitter : MonoBehaviour
    {
        [SerializeField] private string emitterId;
        [SerializeField] private AudioClip clip;
        [SerializeField] [Range(0f, 1f)] private float volume = 0.7f;
        [SerializeField] private bool loop = true;
        [SerializeField] [Range(0f, 1f)] private float spatialBlend = 1f;
        [SerializeField] private float minDistance = 1f;
        [SerializeField] private float maxDistance = 25f;

        private AudioSource _source;

        public string EmitterId => emitterId;
        public AudioClip Clip => clip;
        public bool IsPlaying => _source != null && _source.isPlaying;

        public void Configure(
            string id,
            AudioClip audioClip,
            float vol,
            bool shouldLoop,
            float spatial,
            float minDist,
            float maxDist,
            Vector3 worldPosition)
        {
            emitterId = id;
            clip = audioClip;
            volume = Mathf.Clamp01(vol);
            loop = shouldLoop;
            spatialBlend = Mathf.Clamp01(spatial);
            minDistance = Mathf.Max(0.01f, minDist);
            maxDistance = Mathf.Max(minDistance, maxDist);
            transform.position = worldPosition;
            ApplyToSource();
        }

        private void Awake() => ApplyToSource();

        private void OnEnable()
        {
            ApplyToSource();
            if (loop && clip != null && _source != null && !_source.isPlaying)
            {
                _source.Play();
            }
        }

        private void OnDisable()
        {
            if (_source != null && _source.isPlaying) _source.Stop();
        }

        private void ApplyToSource()
        {
            if (_source == null) _source = GetComponent<AudioSource>();
            if (_source == null) return;
            _source.clip = clip;
            _source.volume = volume;
            _source.loop = loop;
            _source.spatialBlend = spatialBlend;
            _source.minDistance = minDistance;
            _source.maxDistance = maxDistance;
            _source.rolloffMode = AudioRolloffMode.Linear;
            _source.playOnAwake = false;
        }

        public void PlayOnce()
        {
            ApplyToSource();
            if (clip == null || _source == null) return;
            _source.PlayOneShot(clip, volume);
        }
    }
}
