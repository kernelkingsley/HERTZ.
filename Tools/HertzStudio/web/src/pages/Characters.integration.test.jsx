/**
 * W05 integration (partial): Characters page must point CharacterPreview at /model,
 * never /file (that caused model-dep/file 404).
 *
 * Still mocked: milestone status + CharacterPreview paint (WebGL). Real catalog→mesh
 * paint is covered by api/src/w05-w07-integration.test.mjs + Kingsley browser check.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Characters from "./Characters.jsx";

vi.mock("../api.js", () => ({
  api: vi.fn(),
}));

vi.mock("../lib/milestoneStatus.js", () => ({
  getMilestoneStatus: () => "Ready for Kingsley testing",
  statusBadgeVariant: () => "secondary",
}));

vi.mock("../components/CharacterPreview.jsx", () => ({
  default: (props) => (
    <div
      data-testid="character-preview"
      data-model-url={props.modelUrl || ""}
      data-model-asset-id={props.modelAssetId || ""}
    />
  ),
}));

import { api } from "../api.js";

const catalogMeshId = "ce7d1bb4-2ddd-4c9e-abde-049abd669b73";

describe("Characters preview URL integration", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    cleanup();
    api.mockReset();
    api.mockImplementation(async (path) => {
      if (path === "/api/characters") {
        return { models: [], profiles: [] };
      }
      if (String(path).startsWith("/api/characters/models/ready")) {
        return {
          models: [
            {
              id: catalogMeshId,
              displayName: "Futuristic racing car - Molnia",
              assetType: "model_3d",
              state: "unity_imported",
              stateLabel: "Unity imported",
              assignable: true,
              canAddToCatalog: true,
              canEnqueueImport: false,
            },
          ],
        };
      }
      if (String(path).startsWith("/api/characters/animations/ready")) {
        return { animations: [], slots: ["idle", "attack", "locomotion"] };
      }
      if (path === "/api/characters/animation-compatibility") {
        return {
          unityCompatibility: { status: "pending", source: null, reason: "pending" },
        };
      }
      return {};
    });
  });

  it("uses /api/assets/:id/model for preview (not /file → model-dep/file)", async () => {
    render(
      <MemoryRouter>
        <Characters />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("characters-page")).toBeInTheDocument());

    const select = screen.getByTestId("character-model-select");
    fireEvent.change(select, { target: { value: catalogMeshId } });

    await waitFor(() => {
      const preview = screen.getByTestId("character-preview");
      expect(preview.getAttribute("data-model-url")).toBe(`/api/assets/${catalogMeshId}/model`);
      expect(preview.getAttribute("data-model-url")).not.toMatch(/\/file$/);
      expect(preview.getAttribute("data-model-asset-id")).toBe(catalogMeshId);
    });
  });
});
