import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import CatalogSceneDeployPanel from "./CatalogSceneDeployPanel.jsx";

vi.mock("../api.js", () => ({
  api: vi.fn(),
}));

const targetSceneState = vi.hoisted(() => ({
  scenes: [],
  targetScene: null,
  error: "",
  refresh: async () => ({ scenes: [] }),
}));

vi.mock("../context/StudioTargetSceneContext.jsx", () => ({
  useStudioTargetScene: () => targetSceneState,
}));

import { api } from "../api.js";

const SAMPLE_SCENE = {
  path: "Assets/Scenes/SampleScene.unity",
  name: "SampleScene",
  guid: "33333333333333333333333333333333",
  unityRevision: 46,
};

function renderPanel(props) {
  return render(
    <MemoryRouter>
      <CatalogSceneDeployPanel {...props} />
    </MemoryRouter>,
  );
}

describe("CatalogSceneDeployPanel shared target contract", () => {
  beforeEach(() => {
    targetSceneState.scenes = [SAMPLE_SCENE];
    targetSceneState.targetScene = {
      scenePath: SAMPLE_SCENE.path,
      sceneGuid: SAMPLE_SCENE.guid,
      unityRevision: SAMPLE_SCENE.unityRevision,
      available: true,
    };
    targetSceneState.error = "";
    targetSceneState.refresh = vi.fn(async () => ({
      scenes: targetSceneState.scenes,
      target: targetSceneState.targetScene,
    }));
    api.mockReset();
    api.mockResolvedValue({ requestId: "deploy-1", job: { id: "job-1" } });
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("uses the same shared SampleScene target for character Test and Deploy modes", () => {
    renderPanel({ kind: "character", characterId: "character-1", characterVersion: 4 });

    expect(screen.getByTestId("catalog-scene-shared-target")).toHaveTextContent(SAMPLE_SCENE.path);
    expect(screen.getByTestId("catalog-scene-shared-target")).toHaveTextContent("revision 46");
    expect(screen.queryByTestId("catalog-scene-select")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("catalog-scene-mode-deploy"));
    expect(screen.getByTestId("catalog-scene-shared-target")).toHaveTextContent(SAMPLE_SCENE.path);
    expect(screen.getByTestId("catalog-scene-policy")).toHaveTextContent(/one shared Target scene/i);
  });

  it("queues a managed weapon deploy with the shared path, GUID, and revision", async () => {
    renderPanel({ kind: "weapon", weaponId: "weapon-1", weaponVersion: 7 });
    fireEvent.click(screen.getByTestId("catalog-scene-place"));

    await waitFor(() => {
      const call = api.mock.calls.find(([path]) => path === "/api/weapons/weapon-1/deploy-to-scene");
      expect(call).toBeTruthy();
      expect(JSON.parse(call[1].body)).toMatchObject({
        scenePath: SAMPLE_SCENE.path,
        sceneGuid: SAMPLE_SCENE.guid,
        expectedUnityRevision: 46,
        expectedVersion: 7,
        confirmSave: true,
      });
    });
  });

  it("queues managed character roots with the selected compatible behavior profile", async () => {
    renderPanel({
      kind: "character",
      characterId: "character-1",
      characterVersion: 9,
      characterProfiles: [
        { id: "profile-other", modelId: "character-2", displayName: "Wrong model" },
        { id: "profile-1", modelId: "character-1", displayName: "Patrol profile" },
      ],
    });

    expect(screen.queryByText("Wrong model")).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId("catalog-character-profile"), { target: { value: "profile-1" } });
    fireEvent.change(screen.getByTestId("catalog-place-quantity"), { target: { value: "3" } });
    fireEvent.click(screen.getByTestId("catalog-scene-place"));

    await waitFor(() => {
      const call = api.mock.calls.find(
        ([path]) => path === "/api/characters/models/character-1/deploy-to-scene",
      );
      expect(call).toBeTruthy();
      expect(JSON.parse(call[1].body)).toMatchObject({
        profileId: "profile-1",
        quantity: 3,
        scenePath: SAMPLE_SCENE.path,
        sceneGuid: SAMPLE_SCENE.guid,
        expectedUnityRevision: 46,
        expectedVersion: 9,
        confirmSave: true,
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      });
    });
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining(SAMPLE_SCENE.path));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("3 managed character instances"));
  });

  it("blocks deployment when the shared target is unavailable", () => {
    targetSceneState.targetScene = {
      scenePath: SAMPLE_SCENE.path,
      sceneGuid: SAMPLE_SCENE.guid,
      unityRevision: 46,
      available: false,
    };

    renderPanel({ kind: "character", characterId: "character-1", characterVersion: 1 });

    expect(screen.getByTestId("catalog-scene-place")).toBeDisabled();
    expect(screen.getByTestId("catalog-scene-shared-target")).toHaveTextContent("Not selected");
    expect(screen.getByTestId("catalog-scene-need-mesh")).toHaveTextContent(/choose an available shared Target scene/i);
  });
});
