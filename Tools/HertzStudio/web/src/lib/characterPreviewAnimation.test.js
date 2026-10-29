import { describe, expect, it } from "vitest";
import {
  findExactEmbeddedClip,
  isUnityOnlyAnimationAsset,
  normalizeAnimIdentity,
  resolvePreviewPlayback,
} from "./characterPreviewAnimation.js";

describe("characterPreviewAnimation", () => {
  it("normalizes identity to basename without extension", () => {
    expect(normalizeAnimIdentity("Assets/Anims/Idle.anim")).toBe("idle");
    expect(normalizeAnimIdentity("Idle.FBX")).toBe("idle");
    expect(normalizeAnimIdentity("  Walk  ")).toBe("walk");
  });

  it("exact embedded match only — never first-clip fallback", () => {
    const clips = [{ name: "Wave" }, { name: "Idle" }, { name: "Run" }];
    expect(findExactEmbeddedClip(clips, { displayName: "Idle" })?.name).toBe("Idle");
    expect(findExactEmbeddedClip(clips, { displayName: "Idle.anim" })?.name).toBe("Idle");
    expect(findExactEmbeddedClip(clips, { unityPath: "Assets/X/Run.anim" })?.name).toBe("Run");
    // Substring must not match Attack→Attack_Heavy via includes; exact only
    expect(findExactEmbeddedClip(clips, { displayName: "Att" })).toBeNull();
    // No match → null (not clips[0] Wave)
    expect(findExactEmbeddedClip(clips, { displayName: "Jump" })).toBeNull();
    expect(findExactEmbeddedClip(clips, null)).toBeNull();
  });

  it("detects Unity-only animation assets", () => {
    expect(isUnityOnlyAnimationAsset({ assetType: "animation", fileFormat: "anim" })).toBe(true);
    expect(
      isUnityOnlyAnimationAsset({
        assetType: "animation",
        unityPath: "Assets/HertzStudio/Imported/a/Idle.anim",
      }),
    ).toBe(true);
    expect(
      isUnityOnlyAnimationAsset({
        assetType: "model_3d",
        fileFormat: "glb",
        displayName: "Idle",
        embeddedClipName: "Idle",
      }),
    ).toBe(false);
  });

  it("plays only when exact embedded match exists", () => {
    const r = resolvePreviewPlayback({
      slot: "idle",
      assignment: { assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", displayName: "Idle", assetType: "model_3d" },
      embeddedClipNames: ["Wave", "Idle", "Run"],
    });
    expect(r.browserPlayback).toBe("exact_embedded");
    expect(r.playingClipName).toBe("Idle");
    expect(r.canPlayInBrowser).toBe(true);
    expect(r.assignedLabel).toBe("Idle");
  });

  it("never claims first clip when assignment does not match", () => {
    const r = resolvePreviewPlayback({
      slot: "attack",
      assignment: {
        assetId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        displayName: "Punch",
        assetType: "model_3d",
        fileFormat: "glb",
      },
      embeddedClipNames: ["Wave", "Idle", "Run"],
    });
    expect(r.browserPlayback).toBe("unavailable_no_match");
    expect(r.playingClipName).toBeNull();
    expect(r.canPlayInBrowser).toBe(false);
    expect(r.message).toMatch(/does not exactly match/i);
  });

  it("marks Unity-only assignment as browser unavailable", () => {
    const r = resolvePreviewPlayback({
      slot: "locomotion",
      assignment: {
        assetId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        displayName: "Walk",
        assetType: "animation",
        fileFormat: "anim",
        unityPath: "Assets/HertzStudio/Imported/c/Walk.anim",
      },
      embeddedClipNames: ["Wave", "Idle"],
    });
    expect(r.browserPlayback).toBe("unavailable_unity_only");
    expect(r.playingClipName).toBeNull();
    expect(r.message).toMatch(/Assigned in Unity; browser preview unavailable/i);
  });

  it("does not fabricate compatibility without Unity evidence", () => {
    const r = resolvePreviewPlayback({
      slot: "idle",
      assignment: {
        assetId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        displayName: "Idle",
        assetType: "animation",
        fileFormat: "anim",
      },
      embeddedClipNames: [],
      unityCompatibility: { status: "compatible", source: "filename_guess" },
    });
    expect(r.compatibilityStatus).toBe("pending");
    expect(r.compatibilitySource).toBe("filename_guess");
  });

  it("accepts Unity evidence only from authoritative sources", () => {
    const r = resolvePreviewPlayback({
      slot: "idle",
      assignment: {
        assetId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        displayName: "Idle",
        assetType: "animation",
        fileFormat: "anim",
      },
      embeddedClipNames: [],
      unityCompatibility: {
        status: "compatible",
        source: "unity_bridge",
        reason: "Humanoid avatar matched",
      },
    });
    expect(r.compatibilityStatus).toBe("unity_verified");
    expect(r.compatibilitySource).toBe("unity_bridge");
  });

  it("slot switching updates assigned vs playing state", () => {
    const assignmentIdle = {
      assetId: "11111111-1111-4111-8111-111111111111",
      displayName: "Idle",
      assetType: "model_3d",
    };
    const assignmentAttack = {
      assetId: "22222222-2222-4222-8222-222222222222",
      displayName: "Attack",
      assetType: "animation",
      fileFormat: "anim",
    };
    const idle = resolvePreviewPlayback({
      slot: "idle",
      assignment: assignmentIdle,
      embeddedClipNames: ["Idle", "Wave"],
    });
    const attack = resolvePreviewPlayback({
      slot: "attack",
      assignment: assignmentAttack,
      embeddedClipNames: ["Idle", "Wave"],
    });
    expect(idle.playingClipName).toBe("Idle");
    expect(attack.playingClipName).toBeNull();
    expect(attack.browserPlayback).toBe("unavailable_unity_only");
    expect(idle.slot).toBe("idle");
    expect(attack.slot).toBe("attack");
  });
});
