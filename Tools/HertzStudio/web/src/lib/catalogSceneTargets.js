/** Dedicated Unity test scenes for Characters / Weapons — never SampleScene. */
export const HERTZ_CHARACTER_TEST_SCENE = "Assets/Scenes/HertzCharacterTest.unity";
export const HERTZ_WEAPON_TEST_SCENE = "Assets/Scenes/HertzWeaponTest.unity";

export function isDedicatedTestScene(scenePath, kind) {
  const p = String(scenePath || "").replace(/\\/g, "/");
  if (kind === "character") return p === HERTZ_CHARACTER_TEST_SCENE;
  if (kind === "weapon") return p === HERTZ_WEAPON_TEST_SCENE;
  return p === HERTZ_CHARACTER_TEST_SCENE || p === HERTZ_WEAPON_TEST_SCENE;
}

/**
 * Resolve deploy target from mode + picker. Deploy defaults to empty (must choose).
 * @returns {{ scenePath: string, mode: "test"|"deploy", locked: boolean }}
 */
export function resolveCatalogSceneTarget({ mode, deployScenePath, kind }) {
  if (mode === "test") {
    return {
      mode: "test",
      locked: true,
      scenePath: kind === "weapon" ? HERTZ_WEAPON_TEST_SCENE : HERTZ_CHARACTER_TEST_SCENE,
    };
  }
  return {
    mode: "deploy",
    locked: false,
    scenePath: String(deployScenePath || ""),
  };
}
