using UnityEngine;

namespace Hertz.Weapons
{
    /// <summary>
    /// W04 dual-pistol tuning asset. Catalog imports must not auto-equip new types;
    /// frequency flip remains the fire gate (enforced by gameplay consumers).
    /// Stable identity is <see cref="WeaponId"/> (Studio catalog id).
    /// </summary>
    [CreateAssetMenu(fileName = "HertzWeapon", menuName = "HERTZ/Weapon Definition", order = 10)]
    public sealed class HertzWeaponDefinition : ScriptableObject
    {
        public enum WeaponRole
        {
            LeftPistol = 0,
            RightPistol = 1,
        }

        [SerializeField] private string weaponId = "";
        [SerializeField] private string displayName = "Pistol";
        [SerializeField] private WeaponRole role = WeaponRole.LeftPistol;
        [SerializeField] private bool enabled = true;
        [SerializeField] private bool frequencyFlipRequired = true;
        [SerializeField] private GameObject modelPrefab;
        [SerializeField] private float damage = 10f;
        [SerializeField] private float fireIntervalSeconds = 0.2f;
        [SerializeField] private float rangeMeters = 40f;
        [SerializeField] private float recoil = 0.15f;
        [SerializeField] private string leftHandAnchor = "LeftHand";
        [SerializeField] private string rightHandAnchor = "RightHand";
        [SerializeField] private string gripAnchor = "Grip";
        [SerializeField] private string muzzleAnchor = "Muzzle";
        [SerializeField] private int studioVersion = 1;
        [SerializeField] private string studioPayloadHash = "";

        public string WeaponId => weaponId;
        public string DisplayName => displayName;
        public WeaponRole Role => role;
        public bool Enabled => enabled;
        public bool FrequencyFlipRequired => frequencyFlipRequired;
        public GameObject ModelPrefab => modelPrefab;
        public float Damage => damage;
        public float FireIntervalSeconds => fireIntervalSeconds;
        public float RangeMeters => rangeMeters;
        public float Recoil => recoil;
        public string LeftHandAnchor => leftHandAnchor;
        public string RightHandAnchor => rightHandAnchor;
        public string GripAnchor => gripAnchor;
        public string MuzzleAnchor => muzzleAnchor;
        public int StudioVersion => studioVersion;
        public string StudioPayloadHash => studioPayloadHash;

        /// <summary>
        /// Apply Studio sync fields. Does not silently coerce invalid tuning — returns false.
        /// </summary>
        public bool TryApplyStudioFields(
            string id,
            string name,
            WeaponRole weaponRole,
            bool isEnabled,
            bool requireFrequencyFlip,
            GameObject prefab,
            float dmg,
            float fireInterval,
            float range,
            float recoilAmount,
            string leftAnchor,
            string rightAnchor,
            string grip,
            string muzzle,
            int version,
            string payloadHash,
            out string error)
        {
            error = null;
            if (string.IsNullOrWhiteSpace(id))
            {
                error = "weaponId required.";
                return false;
            }

            if (!IsFiniteInRange(dmg, 0f, 1000f) ||
                !IsFiniteInRange(fireInterval, 0.05f, 10f) ||
                !IsFiniteInRange(range, 1f, 500f) ||
                !IsFiniteInRange(recoilAmount, 0f, 5f))
            {
                error = "Invalid tuning range (finite values required; no silent coerce).";
                return false;
            }

            if (!ValidAnchor(leftAnchor) || !ValidAnchor(rightAnchor) || !ValidAnchor(grip) || !ValidAnchor(muzzle))
            {
                error = "Anchor names must be 1..64 characters.";
                return false;
            }

            weaponId = id.Trim();
            displayName = string.IsNullOrWhiteSpace(name) ? "Pistol" : name.Trim();
            role = weaponRole;
            enabled = isEnabled;
            frequencyFlipRequired = requireFrequencyFlip;
            modelPrefab = prefab;
            damage = dmg;
            fireIntervalSeconds = fireInterval;
            rangeMeters = range;
            recoil = recoilAmount;
            leftHandAnchor = leftAnchor.Trim();
            rightHandAnchor = rightAnchor.Trim();
            gripAnchor = grip.Trim();
            muzzleAnchor = muzzle.Trim();
            studioVersion = version;
            studioPayloadHash = payloadHash ?? "";
            return true;
        }

        private static bool IsFiniteInRange(float v, float min, float max)
        {
            return !float.IsNaN(v) && !float.IsInfinity(v) && v >= min && v <= max;
        }

        private static bool ValidAnchor(string value)
        {
            return !string.IsNullOrWhiteSpace(value) && value.Trim().Length <= 64;
        }
    }
}
