using UnityEngine;

namespace Hertz.Weapons
{
    /// <summary>
    /// Accepted-shot payload for optional Sound-section integration.
    /// Emitted only after a shot is accepted (frequency/definition/interval gates passed).
    /// </summary>
    public readonly struct HertzWeaponShotEvent
    {
        public readonly HertzWeaponDefinition.WeaponRole Side;
        public readonly HertzWeaponDefinition Definition;
        public readonly Vector3 MuzzlePosition;
        public readonly Vector3 MuzzleForward;
        public readonly bool Hit;
        public readonly Vector3 HitPoint;
        public readonly float DamageApplied;

        public HertzWeaponShotEvent(
            HertzWeaponDefinition.WeaponRole side,
            HertzWeaponDefinition definition,
            Vector3 muzzlePosition,
            Vector3 muzzleForward,
            bool hit,
            Vector3 hitPoint,
            float damageApplied)
        {
            Side = side;
            Definition = definition;
            MuzzlePosition = muzzlePosition;
            MuzzleForward = muzzleForward;
            Hit = hit;
            HitPoint = hitPoint;
            DamageApplied = damageApplied;
        }
    }

    /// <summary>
    /// Optional gunshot audio boundary. Sound milestone assigns implementation later.
    /// Unassigned / null must never break firing.
    /// </summary>
    public interface IHertzWeaponShotAudioPresenter
    {
        void PresentAcceptedShot(in HertzWeaponShotEvent shotEvent);
    }
}
