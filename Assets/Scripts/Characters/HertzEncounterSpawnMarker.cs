using UnityEngine;

namespace Hertz.Characters
{
    /// <summary>
    /// Editor/runtime spawn marker authored by Hertz Studio encounter apply.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class HertzEncounterSpawnMarker : MonoBehaviour
    {
        [SerializeField] private string encounterId = "";
        [SerializeField] private string enemyProfileId = "";
        [SerializeField] private string enemyProfileUnityPath = "";
        [SerializeField] private HertzEnemyBehaviorProfile enemyProfile;
        [SerializeField] private float delaySeconds;
        [SerializeField] private int spawnIndex;

        public string EncounterId => encounterId;
        public string EnemyProfileId => enemyProfileId;
        public string EnemyProfileUnityPath => enemyProfileUnityPath;
        public HertzEnemyBehaviorProfile EnemyProfile => enemyProfile;
        public float DelaySeconds => delaySeconds;
        public int SpawnIndex => spawnIndex;

        public void Configure(
            string encounter,
            string profileId,
            string profileUnityPath,
            HertzEnemyBehaviorProfile profile,
            float delay,
            int index)
        {
            encounterId = encounter ?? "";
            enemyProfileId = profileId ?? "";
            enemyProfileUnityPath = profileUnityPath ?? "";
            enemyProfile = profile;
            delaySeconds = Mathf.Max(0f, delay);
            spawnIndex = Mathf.Max(0, index);
        }
    }
}
