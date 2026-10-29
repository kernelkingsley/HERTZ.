import { describe, it, expect } from "vitest";
import { resolveWeaponShotAudio } from "./weaponShotAudio.js";

describe("resolveWeaponShotAudio", () => {
  it("returns silent when no assignment", () => {
    const r = resolveWeaponShotAudio({ slots: [] }, "left_pistol");
    expect(r.assigned).toBe(false);
    expect(r.previewUrl).toBeNull();
    expect(r.label).toMatch(/Silent/i);
  });

  it("returns preview URL for assigned left shot", () => {
    const r = resolveWeaponShotAudio(
      {
        slots: [
          {
            category: "weapon",
            slotKey: "shot",
            targetId: "left_pistol",
            audioAssetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            audio: {
              id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              name: "kenney_shot",
              previewUrl: "/api/assets/previews/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.ogg",
            },
          },
        ],
      },
      "left_pistol",
    );
    expect(r.assigned).toBe(true);
    expect(r.previewUrl).toContain("/api/assets/previews/");
    expect(r.error).toBeNull();
  });

  it("reports missing assignment source", () => {
    const r = resolveWeaponShotAudio(
      {
        slots: [
          {
            category: "weapon",
            slotKey: "shot",
            targetId: "right_pistol",
            audioAssetId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            audio: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", missing: true },
          },
        ],
      },
      "right_pistol",
    );
    expect(r.assigned).toBe(true);
    expect(r.previewUrl).toBeNull();
    expect(r.error).toMatch(/missing/i);
  });
});
