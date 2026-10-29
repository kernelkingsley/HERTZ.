/**
 * Resolve the Sound-section weapon shot assignment for a pistol role.
 * Reuses the authoritative W07 sound board — does not invent a second store.
 */
export function resolveWeaponShotAudio(soundBoard, role = "left_pistol") {
  const targetId = role === "right_pistol" ? "right_pistol" : "left_pistol";
  const slots = soundBoard?.slots || [];
  const slot = slots.find(
    (s) => s.category === "weapon" && s.slotKey === "shot" && (s.targetId || null) === targetId,
  );
  if (!slot || !slot.audioAssetId) {
    return {
      assigned: false,
      previewUrl: null,
      audioAssetId: null,
      error: null,
      label: "Silent — no firing sound assigned.",
      targetId,
    };
  }
  const audio = slot.audio || null;
  if (audio?.missing) {
    return {
      assigned: true,
      previewUrl: null,
      audioAssetId: slot.audioAssetId,
      error: "Assigned firing sound asset is missing from the library.",
      label: "Unavailable — assigned audio missing",
      targetId,
    };
  }
  if (audio?.unsupported) {
    return {
      assigned: true,
      previewUrl: null,
      audioAssetId: slot.audioAssetId,
      error: "Assigned firing sound is unsupported for Studio preview.",
      label: "Unavailable — unsupported audio",
      targetId,
    };
  }
  const previewUrl = audio?.previewUrl || null;
  if (!previewUrl) {
    return {
      assigned: true,
      previewUrl: null,
      audioAssetId: slot.audioAssetId,
      error: "Assigned firing sound has no playable Studio preview URL.",
      label: "Unavailable — no preview URL",
      targetId,
    };
  }
  return {
    assigned: true,
    previewUrl,
    audioAssetId: slot.audioAssetId,
    error: null,
    label: `Sound assigned: ${audio?.name || slot.audioAssetId} (browser cue only)`,
    name: audio?.name || null,
    targetId,
  };
}
