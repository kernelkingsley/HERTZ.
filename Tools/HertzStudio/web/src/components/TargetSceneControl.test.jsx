import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../api.js";
import { StudioTargetSceneProvider } from "../context/StudioTargetSceneContext.jsx";
import TargetSceneControl from "./TargetSceneControl.jsx";

vi.mock("../api.js", () => ({ api: vi.fn() }));

const scenes = [
  {
    path: "Assets/Scenes/HertzWeaponTest.unity",
    name: "HertzWeaponTest",
    guid: "11111111111111111111111111111111",
    unityRevision: 8,
  },
  {
    path: "Assets/Scenes/SampleScene.unity",
    name: "SampleScene",
    guid: "22222222222222222222222222222222",
    unityRevision: 31,
  },
];

describe("TargetSceneControl", () => {
  beforeEach(() => {
    api.mockReset();
    api.mockImplementation(async (path, options = {}) => {
      if (path === "/api/unity/scenes") return { scenes, target: null };
      if (path === "/api/studio/target-scene" && options.method === "PUT") {
        const body = JSON.parse(options.body);
        return {
          target: {
            scenePath: body.scenePath,
            sceneGuid: body.sceneGuid,
            sceneName: "SampleScene",
            unityRevision: 31,
            available: true,
          },
        };
      }
      return {};
    });
  });

  it("persists one shared SampleScene path/GUID selection", async () => {
    render(
      <StudioTargetSceneProvider>
        <TargetSceneControl />
      </StudioTargetSceneProvider>,
    );
    const select = await screen.findByTestId("studio-target-scene-select");
    await waitFor(() => expect(select).toHaveValue(""));
    fireEvent.change(select, { target: { value: "22222222222222222222222222222222" } });
    await waitFor(() => expect(select).toHaveValue("22222222222222222222222222222222"));
    const put = api.mock.calls.find(
      ([path, options]) => path === "/api/studio/target-scene" && options?.method === "PUT",
    );
    expect(JSON.parse(put[1].body)).toEqual({
      scenePath: "Assets/Scenes/SampleScene.unity",
      sceneGuid: "22222222222222222222222222222222",
    });
    expect(screen.getByTestId("studio-target-scene-path")).toHaveTextContent(
      "Assets/Scenes/SampleScene.unity",
    );
  });
});