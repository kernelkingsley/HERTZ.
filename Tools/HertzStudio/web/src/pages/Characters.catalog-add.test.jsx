/**
 * W05 catalog add workflow: library → draft → Save → catalog entry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Characters from "./Characters.jsx";

vi.mock("../api.js", () => ({
  api: vi.fn(),
}));

vi.mock("../lib/milestoneStatus.js", () => ({
  getMilestoneStatus: () => "In progress",
  statusBadgeVariant: () => "secondary",
}));

vi.mock("../components/CharacterPreview.jsx", () => ({
  default: () => <div data-testid="character-preview" />,
}));

import { api } from "../api.js";

const importedId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const previewId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const failedId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

let catalogModels = [];
let storeModels = [];

function libraryEntry(partial) {
  return {
    displayName: partial.displayName,
    assetType: "model_3d",
    stateLabel: partial.stateLabel || partial.state,
    assignable: Boolean(partial.assignable),
    canAddToCatalog: Boolean(partial.canAddToCatalog ?? partial.assignable),
    canEnqueueImport: Boolean(partial.canEnqueueImport),
    canRetryImport: Boolean(partial.canRetryImport),
    importInFlight: Boolean(partial.importInFlight),
    blockReason: partial.blockReason || null,
    lastError: partial.lastError || null,
    ...partial,
  };
}

describe("Characters catalog add from Asset Library", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    cleanup();
    storeModels = [];
    catalogModels = [
      libraryEntry({
        id: importedId,
        displayName: "Ready Mesh",
        state: "unity_imported",
        stateLabel: "Unity imported",
        assignable: true,
        canAddToCatalog: true,
        canEnqueueImport: false,
      }),
      libraryEntry({
        id: previewId,
        displayName: "Preview Only",
        state: "preview_ready",
        stateLabel: "Preview ready",
        assignable: false,
        canAddToCatalog: false,
        canEnqueueImport: true,
        blockReason: "Preview ready in browser only — Import to Unity before assigning.",
      }),
      libraryEntry({
        id: failedId,
        displayName: "Failed Mesh",
        state: "failed",
        stateLabel: "Failed",
        assignable: false,
        canAddToCatalog: false,
        canEnqueueImport: true,
        canRetryImport: true,
        lastError: "Unity import timed out",
        blockReason: "Unity import timed out",
      }),
    ];
    api.mockReset();
    api.mockImplementation(async (path, opts = {}) => {
      if (path === "/api/characters") {
        return { models: storeModels, profiles: [] };
      }
      if (String(path).startsWith("/api/characters/models/ready")) {
        return { models: catalogModels };
      }
      if (String(path).startsWith("/api/characters/animations/ready")) {
        return { animations: [], slots: ["idle", "attack", "locomotion"] };
      }
      if (path === "/api/characters/animation-compatibility") {
        return { unityCompatibility: { status: "pending", source: null } };
      }
      if (opts.method === "POST" && path === "/api/characters/models") {
        const body = JSON.parse(opts.body || "{}");
        if (body.replaceTrackedXrRig === true) {
          const err = new Error("replaceTrackedXrRig is forbidden");
          err.data = { code: "invalid_character_safety" };
          throw err;
        }
        const created = {
          id: body.id || `catalog-${storeModels.length + 1}`,
          displayName: body.displayName,
          kind: body.kind,
          enabled: true,
          modelAssetId: body.modelAssetId,
          scale: body.scale ?? 1,
          version: 1,
          animations: body.animations || { idle: null, attack: null, locomotion: null },
          unitySync: { state: "disconnected" },
        };
        if (body.id) {
          storeModels = storeModels.map((m) => (m.id === body.id ? created : m));
        } else {
          storeModels = [...storeModels, created];
        }
        return created;
      }
      if (opts.method === "DELETE" && String(path).startsWith("/api/characters/models/")) {
        const id = String(path).split("/").pop();
        storeModels = storeModels.filter((m) => m.id !== id);
        return { ok: true };
      }
      if (opts.method === "POST" && String(path).includes("/import-unity")) {
        const id = String(path).split("/")[3];
        catalogModels = catalogModels.map((m) =>
          m.id === id
            ? libraryEntry({
                ...m,
                state: "pending_unity",
                stateLabel: "Pending Unity",
                assignable: false,
                canAddToCatalog: false,
                canEnqueueImport: false,
                importInFlight: true,
                blockReason: "Unity import in progress — wait for connector/Unity to finish.",
              })
            : m,
        );
        return { status: 202, job: { status: "pending_unity", assetId: id }, connectorOnline: true };
      }
      return {};
    });
  });

  function renderPage() {
    return render(
      <MemoryRouter>
        <Characters />
      </MemoryRouter>,
    );
  }

  it("imported row shows Add as character and Add as enemy visual", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId(`character-model-add-character-${importedId}`)).toBeInTheDocument());
    expect(screen.getByTestId(`character-model-add-enemy-${importedId}`)).toBeInTheDocument();
    expect(screen.getByTestId(`character-model-import-${previewId}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`character-model-add-character-${previewId}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`character-model-retry-import-${failedId}`)).toBeInTheDocument();
    expect(screen.getByTestId(`character-model-error-${failedId}`)).toHaveTextContent(/timed out/i);
  });

  it("Unity imported + missing canAddToCatalog still enables Add actions", async () => {
    // Exact Kingsley browser skew: label Unity imported / assignable, new action flags absent.
    catalogModels = [
      {
        id: importedId,
        displayName: "Armored cat",
        assetType: "model_3d",
        state: "unity_imported",
        stateLabel: "Unity imported",
        assignable: true,
        unity: { readiness: "ready" },
      },
    ];
    renderPage();
    await waitFor(() => expect(screen.getByTestId(`character-model-add-character-${importedId}`)).toBeInTheDocument());
    expect(screen.getByTestId(`character-model-add-enemy-${importedId}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`character-model-add-disabled-${importedId}`)).not.toBeInTheDocument();
    expect(screen.getByTestId("character-preview-panel")).toBeInTheDocument();
    expect(screen.getByTestId("character-preview-workflow-note")).toHaveTextContent(/does not rig a static mesh/i);
    expect(screen.getByTestId("character-preview")).toBeInTheDocument();
  });

  it("Add as enemy populates unsaved draft with asset id and enemy kind", async () => {
    renderPage();
    await waitFor(() => screen.getByTestId(`character-model-add-enemy-${importedId}`));
    fireEvent.click(screen.getByTestId(`character-model-add-enemy-${importedId}`));
    await waitFor(() => expect(screen.getByTestId("character-model-unsaved")).toBeInTheDocument());
    expect(screen.getByTestId("character-kind")).toHaveValue("enemy_visual");
    expect(screen.getByTestId("character-model-select")).toHaveValue(importedId);
    expect(screen.getByTestId("character-name")).toHaveValue("Ready Mesh");
  });

  it("Add as character populates player_character kind", async () => {
    renderPage();
    await waitFor(() => screen.getByTestId(`character-model-add-character-${importedId}`));
    fireEvent.click(screen.getByTestId(`character-model-add-character-${importedId}`));
    await waitFor(() => expect(screen.getByTestId("character-kind")).toHaveValue("player_character"));
    expect(screen.getByTestId("character-model-select")).toHaveValue(importedId);
  });

  it("Save creates one catalog entry and selects it", async () => {
    renderPage();
    await waitFor(() => screen.getByTestId(`character-model-add-enemy-${importedId}`));
    fireEvent.click(screen.getByTestId(`character-model-add-enemy-${importedId}`));
    await waitFor(() => screen.getByTestId("character-model-unsaved"));
    fireEvent.click(screen.getByTestId("character-model-save"));
    await waitFor(() => expect(storeModels).toHaveLength(1));
    expect(storeModels[0].modelAssetId).toBe(importedId);
    expect(storeModels[0].kind).toBe("enemy_visual");
    await waitFor(() => expect(screen.getByTestId("character-model-row-enemy_visual")).toBeInTheDocument());
    expect(screen.queryByTestId("character-model-unsaved")).not.toBeInTheDocument();
  });

  it("rapid double Save does not create duplicates", async () => {
    renderPage();
    await waitFor(() => screen.getByTestId(`character-model-add-enemy-${importedId}`));
    fireEvent.click(screen.getByTestId(`character-model-add-enemy-${importedId}`));
    await waitFor(() => screen.getByTestId("character-model-save"));
    const save = screen.getByTestId("character-model-save");
    fireEvent.click(save);
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() => expect(storeModels).toHaveLength(1));
    const posts = api.mock.calls.filter(([p, o]) => p === "/api/characters/models" && o?.method === "POST");
    expect(posts.length).toBe(1);
  });

  it("preview-ready shows Import and cannot add yet", async () => {
    renderPage();
    await waitFor(() => screen.getByTestId(`character-model-import-${previewId}`));
    expect(screen.getByTestId(`character-model-add-disabled-${previewId}`)).toBeDisabled();
  });

  it("import queues and refreshes row to importing state", async () => {
    renderPage();
    await waitFor(() => screen.getByTestId(`character-model-import-${previewId}`));
    fireEvent.click(screen.getByTestId(`character-model-import-${previewId}`));
    await waitFor(() => expect(screen.getByTestId(`character-model-library-row-${previewId}`)).toHaveAttribute("data-state", "pending_unity"));
    expect(screen.getByTestId(`character-model-importing-${previewId}`)).toBeInTheDocument();
  });

  it("successful import refresh enables add actions", async () => {
    let readyFetches = 0;
    api.mockImplementation(async (path, opts = {}) => {
      if (path === "/api/characters") return { models: storeModels, profiles: [] };
      if (String(path).startsWith("/api/characters/models/ready")) {
        readyFetches += 1;
        if (readyFetches >= 2) {
          return {
            models: [
              libraryEntry({
                id: previewId,
                displayName: "Preview Only",
                state: "unity_imported",
                stateLabel: "Unity imported",
                assignable: true,
                canAddToCatalog: true,
                canEnqueueImport: false,
                importInFlight: false,
              }),
              ...catalogModels.filter((m) => m.id !== previewId),
            ],
          };
        }
        return { models: catalogModels };
      }
      if (String(path).startsWith("/api/characters/animations/ready")) {
        return { animations: [], slots: ["idle", "attack", "locomotion"] };
      }
      if (path === "/api/characters/animation-compatibility") {
        return { unityCompatibility: { status: "pending", source: null } };
      }
      if (opts.method === "POST" && String(path).includes("/import-unity")) {
        return { status: 202, job: { status: "pending_unity", assetId: previewId }, connectorOnline: true };
      }
      return {};
    });
    renderPage();
    await waitFor(() => screen.getByTestId(`character-model-import-${previewId}`));
    fireEvent.click(screen.getByTestId(`character-model-import-${previewId}`));
    await waitFor(() => expect(screen.getByTestId(`character-model-add-character-${previewId}`)).toBeInTheDocument());
    expect(screen.getByTestId(`character-model-add-enemy-${previewId}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`character-model-import-${previewId}`)).not.toBeInTheDocument();
  });

  it("remove catalog entry keeps Asset Library model listed", async () => {
    storeModels = [
      {
        id: "catalog-1",
        displayName: "Ready Mesh",
        kind: "enemy_visual",
        modelAssetId: importedId,
        unitySync: { state: "disconnected" },
      },
    ];
    renderPage();
    await waitFor(() => screen.getByTestId("character-model-row-enemy_visual"));
    fireEvent.click(screen.getByTestId("character-model-row-enemy_visual"));
    fireEvent.click(screen.getByTestId("character-model-remove"));
    await waitFor(() => expect(storeModels).toHaveLength(0));
    expect(screen.getByTestId(`character-model-library-row-${importedId}`)).toBeInTheDocument();
    expect(screen.getByTestId(`character-model-add-enemy-${importedId}`)).toBeInTheDocument();
  });
});
