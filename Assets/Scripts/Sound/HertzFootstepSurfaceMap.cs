using System;
using UnityEngine;

namespace Hertz.Sound
{
    /// <summary>
    /// Explicit surfaceId → footstep clip. Material appearance must not rewrite these entries.
    /// </summary>
    [CreateAssetMenu(menuName = "HERTZ/Sound/Footstep Surface Map", fileName = "FootstepSurfaceMap")]
    public sealed class HertzFootstepSurfaceMap : ScriptableObject
    {
        [Serializable]
        public struct Entry
        {
            public string surfaceId;
            public string surfaceLabel;
            public AudioClip clip;
        }

        [SerializeField] private Entry[] entries = Array.Empty<Entry>();

        public Entry[] Entries => entries;

        public void SetEntries(Entry[] next)
        {
            entries = next ?? Array.Empty<Entry>();
        }

        public bool TryGetClip(string surfaceId, out AudioClip clip)
        {
            clip = null;
            if (string.IsNullOrEmpty(surfaceId) || entries == null) return false;
            for (var i = 0; i < entries.Length; i++)
            {
                if (string.Equals(entries[i].surfaceId, surfaceId, StringComparison.Ordinal))
                {
                    clip = entries[i].clip;
                    return clip != null;
                }
            }

            return false;
        }
    }

    /// <summary>
    /// Minimal runtime consumer: resolves footsteps by explicit surface id only.
    /// </summary>
    public sealed class HertzFootstepPlayer : MonoBehaviour
    {
        [SerializeField] private HertzFootstepSurfaceMap map;
        [SerializeField] private AudioSource source;
        [SerializeField] [Range(0f, 1f)] private float volume = 0.55f;

        public void Configure(HertzFootstepSurfaceMap surfaceMap, AudioSource audioSource)
        {
            map = surfaceMap;
            source = audioSource;
        }

        public bool PlayForSurface(string surfaceId)
        {
            if (map == null || source == null) return false;
            if (!map.TryGetClip(surfaceId, out var clip) || clip == null) return false;
            source.PlayOneShot(clip, volume);
            return true;
        }
    }
}
