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

import { api } from "../api.js";

const modelId = "11111111-1111-4111-8111-111111111111";
const profileId = "22222222-2222-4222-8222-222222222222";

function renderPage() {
  cleanup();
  return render(
    <MemoryRouter>
      <Characters />
    </MemoryRouter>,
  );
}

describe("Characters UI", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    cleanup();
    api.mockReset();
    api.mockImplementation(async (path, opts = {}) => {
      if (path === "/api/characters") {
        return {
          models: [
            {
              id: modelId,
              displayName: "Spirit Mesh",
              kind: "enemy_visual",
              enabled: true,
              scale: 1,
              unitySync: { state: "disconnected" },
            },
          ],
          profiles: [
            {
              id: profileId,
              displayName: "Hold Spirit",
              enabled: true,
              modelId,
              behavior: { mode: "hold_position", waitReactionDelaySeconds: 0.4 },
              unitySync: { state: "disconnected" },
            },
          ],
        };
      }
      if (String(path).startsWith("/api/characters/models/ready")) {
        return {
          models: [
            {
              id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              displayName: "Ready Mesh",
              state: "unity_imported",
              stateLabel: "Unity imported",
              assignable: true,
              canAddToCatalog: true,
              canEnqueueImport: false,
            },
            {
              id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
              displayName: "Preview Only",
              state: "preview_ready",
              stateLabel: "Preview ready",
              assignable: false,
              canAddToCatalog: false,
              canEnqueueImport: true,
              blockReason: "Preview ready in browser only — Import to Unity before assigning.",
            },
          ],
        };
      }
      if (path === "/api/characters/animation-compatibility") {
        return { unityCompatibility: { status: "pending", source: null } };
      }
      if (String(path).startsWith("/api/characters/animations/ready")) {
        return {
          animations: [
            { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", displayName: "Idle Clip", assetType: "animation" },
          ],
          slots: ["idle", "attack", "locomotion"],
        };
      }
      if (opts.method === "POST" && path === "/api/characters/models") {
        return {
          id: modelId,
          displayName: "Spirit Mesh",
          kind: "enemy_visual",
          enabled: true,
          scale: 1,
          version: 1,
          unitySync: { state: "disconnected" },
        };
      }
      if (opts.method === "POST" && path === "/api/characters/profiles") {
        return {
          id: profileId,
          displayName: "Hold Spirit",
          enabled: true,
          modelId,
          version: 1,
          behavior: { mode: "rush", waitReactionDelaySeconds: 1.2 },
          unitySync: { state: "disconnected" },
        };
      }
      return {};
    });
  });

  it("shows milestone badge, XR safety note, and model/profile tabs", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("characters-page")).toBeInTheDocument());
    expect(screen.getByTestId("characters-milestone-badge")).toHaveTextContent(/in progress/i);
    expect(screen.getByTestId("character-xr-safety-note")).toHaveTextContent(/never replace/i);
    expect(screen.getByTestId("character-model-row-enemy_visual")).toBeInTheDocument();
    expect(screen.getByTestId("character-animation-slots")).toBeInTheDocument();
    expect(screen.getByTestId("character-anim-idle")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /behavior profiles/i }));
    await waitFor(() => expect(screen.getByTestId("enemy-profile-row")).toBeInTheDocument());
  });

  it("edits wait delay and mode on behavior profile", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("characters-page")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /behavior profiles/i }));
    fireEvent.click(screen.getByTestId("enemy-profile-row"));
    await waitFor(() => expect(screen.getByTestId("profile-name")).toHaveValue("Hold Spirit"));
    fireEvent.change(screen.getByTestId("profile-mode"), { target: { value: "rush" } });
    fireEvent.change(screen.getByTestId("profile-waitReactionDelaySeconds"), { target: { value: "1.2" } });
    fireEvent.click(screen.getByTestId("profile-save"));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/characters/profiles",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });
});
