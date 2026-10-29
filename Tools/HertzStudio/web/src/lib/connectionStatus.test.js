import { describe, expect, it } from "vitest";
import { CONNECTION_KIND, resolveConnectionStatus } from "./connectionStatus.js";

describe("connectionStatus", () => {
  it("distinguishes API / connector / Unity offline", () => {
    expect(resolveConnectionStatus({ apiReachable: false }).primary.kind).toBe(CONNECTION_KIND.API_OFFLINE);
    expect(
      resolveConnectionStatus({ apiReachable: true, connectorOnline: false }).primary.kind,
    ).toBe(CONNECTION_KIND.CONNECTOR_OFFLINE);
    expect(
      resolveConnectionStatus({
        apiReachable: true,
        connectorOnline: true,
        unityConnected: false,
      }).primary.kind,
    ).toBe(CONNECTION_KIND.UNITY_OFFLINE);
  });

  it("blocks Apply on scene mismatch and stale revision", () => {
    const mismatch = resolveConnectionStatus({
      apiReachable: true,
      connectorOnline: true,
      unityConnected: true,
      draftScenePath: "Assets/Scenes/A.unity",
      activeScenePath: "Assets/Scenes/B.unity",
    });
    expect(mismatch.blocksApply).toBe(true);
    expect(mismatch.states.some((s) => s.kind === CONNECTION_KIND.SCENE_MISMATCH)).toBe(true);

    const stale = resolveConnectionStatus({
      apiReachable: true,
      connectorOnline: true,
      unityConnected: true,
      draftScenePath: "Assets/Scenes/A.unity",
      activeScenePath: "Assets/Scenes/A.unity",
      draftBaseRevision: 10,
      unityRevision: 12,
    });
    expect(stale.blocksApply).toBe(true);
    expect(stale.states.some((s) => s.kind === CONNECTION_KIND.STALE_REVISION)).toBe(true);
  });

  it("allows draft edits while Unity offline", () => {
    const s = resolveConnectionStatus({
      apiReachable: true,
      connectorOnline: true,
      unityConnected: false,
    });
    expect(s.allowsDraftEdit).toBe(true);
    expect(s.blocksApply).toBe(true);
  });
});
