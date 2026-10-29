import { describe, expect, it } from "vitest";
import {
  draftMatchesActiveScene,
  findObjectIndexById,
  getApplyBlockReason,
  sceneDisplayName,
  selectNewestDraftForActiveScene,
  shouldShowDraftSceneSelector,
  uniqueScenePaths,
} from "./levelEditorDraftSelection.js";

const SAMPLE = "Assets/Scenes/SampleScene.unity";
const HERTZ = "Assets/Scenes/HertzStudioTest.unity";

describe("levelEditorDraftSelection", () => {
  it("picks the newest draft matching Unity’s active scene", () => {
    const drafts = [
      { id: "old-hertz", scenePath: HERTZ, updatedAt: "2026-10-23T10:00:00.000Z" },
      { id: "new-sample", scenePath: SAMPLE, updatedAt: "2026-10-23T22:00:00.000Z" },
      { id: "mid-hertz", scenePath: HERTZ, updatedAt: "2026-10-23T18:00:00.000Z" },
    ];
    expect(selectNewestDraftForActiveScene(drafts, HERTZ)?.id).toBe("mid-hertz");
    expect(selectNewestDraftForActiveScene(drafts, SAMPLE)?.id).toBe("new-sample");
  });

  it("never silently selects a draft from another scene", () => {
    const drafts = [
      { id: "only-other", scenePath: HERTZ, updatedAt: "2026-10-23T22:00:00.000Z" },
    ];
    expect(selectNewestDraftForActiveScene(drafts, SAMPLE)).toBeNull();
    expect(selectNewestDraftForActiveScene(drafts, null)).toBeNull();
    expect(selectNewestDraftForActiveScene([], SAMPLE)).toBeNull();
  });

  it("exposes an explicit no-matching-draft state when active scene has no drafts", () => {
    const drafts = [{ id: "a", scenePath: HERTZ, updatedAt: "2026-10-23T22:00:00.000Z" }];
    const selected = selectNewestDraftForActiveScene(drafts, SAMPLE);
    expect(selected).toBeNull();
    expect(draftMatchesActiveScene(selected, SAMPLE)).toBe(false);
  });

  it("shows a scene/draft selector when multiple scenes or multiple matching drafts exist", () => {
    expect(
      shouldShowDraftSceneSelector(
        [
          { id: "1", scenePath: SAMPLE, updatedAt: "2026-10-23T10:00:00.000Z" },
          { id: "2", scenePath: HERTZ, updatedAt: "2026-10-23T11:00:00.000Z" },
        ],
        SAMPLE,
      ),
    ).toBe(true);
    expect(
      shouldShowDraftSceneSelector(
        [
          { id: "1", scenePath: SAMPLE, updatedAt: "2026-10-23T10:00:00.000Z" },
          { id: "2", scenePath: SAMPLE, updatedAt: "2026-10-23T11:00:00.000Z" },
        ],
        SAMPLE,
      ),
    ).toBe(true);
    expect(
      shouldShowDraftSceneSelector([{ id: "1", scenePath: SAMPLE, updatedAt: "2026-10-23T10:00:00.000Z" }], SAMPLE),
    ).toBe(false);
    expect(uniqueScenePaths([{ scenePath: SAMPLE }, { scenePath: HERTZ }, { scenePath: SAMPLE }])).toEqual([
      HERTZ,
      SAMPLE,
    ]);
  });

  it("disables Apply for scene mismatch", () => {
    const reason = getApplyBlockReason({
      draft: { scenePath: HERTZ, status: "ready", baseUnityRevision: 10 },
      activeScenePath: SAMPLE,
      unityConnected: true,
      unityRevision: 10,
    });
    expect(reason).toMatch(/differs from Unity/i);
  });

  it("disables Apply when Unity is disconnected", () => {
    const reason = getApplyBlockReason({
      draft: { scenePath: SAMPLE, status: "ready", baseUnityRevision: 10 },
      activeScenePath: SAMPLE,
      unityConnected: false,
      unityRevision: 10,
    });
    expect(reason).toMatch(/disconnected/i);
  });

  it("disables Apply for stale, conflicted, and applying states", () => {
    expect(
      getApplyBlockReason({
        draft: { scenePath: SAMPLE, status: "ready", baseUnityRevision: 9 },
        activeScenePath: SAMPLE,
        unityConnected: true,
        unityRevision: 12,
      }),
    ).toMatch(/stale/i);
    expect(
      getApplyBlockReason({
        draft: { scenePath: SAMPLE, status: "conflict", baseUnityRevision: 12 },
        activeScenePath: SAMPLE,
        unityConnected: true,
        unityRevision: 12,
      }),
    ).toMatch(/conflict/i);
    expect(
      getApplyBlockReason({
        draft: { scenePath: SAMPLE, status: "applying", baseUnityRevision: 12 },
        activeScenePath: SAMPLE,
        unityConnected: true,
        unityRevision: 12,
      }),
    ).toMatch(/in progress/i);
    expect(
      getApplyBlockReason({
        draft: { scenePath: SAMPLE, status: "pending_unity", baseUnityRevision: 12 },
        activeScenePath: SAMPLE,
        unityConnected: true,
        unityRevision: 12,
      }),
    ).toMatch(/in progress/i);
  });

  it("allows Apply when draft matches, Unity is connected, and base is current", () => {
    expect(
      getApplyBlockReason({
        draft: { scenePath: SAMPLE, status: "ready", baseUnityRevision: 12 },
        activeScenePath: SAMPLE,
        unityConnected: true,
        unityRevision: 12,
      }),
    ).toBeNull();
  });

  it("formats scene display names and finds objects by id", () => {
    expect(sceneDisplayName(SAMPLE)).toBe("SampleScene");
    expect(findObjectIndexById([{ objectId: "a" }, { objectId: "b" }], "b")).toBe(1);
    expect(findObjectIndexById([{ objectId: "a" }], "missing")).toBe(-1);
  });
});
