import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Sound from "./Sound.jsx";

vi.mock("../api.js", () => ({
  api: vi.fn(),
}));

vi.mock("../lib/milestoneStatus.js", () => ({
  getMilestoneStatus: () => "In progress",
  statusBadgeVariant: () => "secondary",
}));

vi.mock("../components/AudioPreview.jsx", () => ({
  default: () => <div data-testid="audio-preview">preview</div>,
}));

import { api } from "../api.js";

const board = {
  slots: [],
  emitters: [],
  footstepMappings: [],
  sync: { state: "not_synced" },
  rules: { materialAppearanceDoesNotChangeFootsteps: true },
};

describe("Sound UI", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    cleanup();
    api.mockReset();
    api.mockImplementation(async (path, opts = {}) => {
      if (path === "/api/sound") return board;
      if (String(path).startsWith("/api/sound/library")) {
        return {
          assets: [
            {
              id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              displayName: "Kenney Impact",
              name: "impact",
              provider: "kenney",
              fileFormat: "wav",
              license: "CC0",
              preview: { kind: "audio", url: "/api/assets/previews/a" },
            },
          ],
        };
      }
      if (path === "/api/sound/slots" && opts.method === "POST") {
        return { id: "slot-1", category: "weapon", slotKey: "shot", audioAssetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
      }
      if (path === "/api/sound/sync") return { ok: true, requestId: "req-1" };
      return {};
    });
  });

  it("shows milestone badge, library, slots, emitters, footsteps", async () => {
    render(
      <MemoryRouter>
        <Sound />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("sound-page")).toBeInTheDocument());
    expect(screen.getByTestId("sound-milestone-badge")).toHaveTextContent(/in progress/i);
    expect(screen.getByTestId("sound-library-list")).toBeInTheDocument();
    expect(screen.getByTestId("sound-slots")).toBeInTheDocument();
    expect(screen.getByTestId("sound-emitters")).toBeInTheDocument();
    expect(screen.getByTestId("sound-footsteps")).toBeInTheDocument();
    expect(screen.getByTestId("sound-sync")).toBeInTheDocument();
  });

  it("selects a Kenney clip and can request Unity sync", async () => {
    render(
      <MemoryRouter>
        <Sound />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("sound-lib-item-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("sound-lib-item-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
    await waitFor(() => expect(screen.getByTestId("sound-audition")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("sound-sync"));
    await waitFor(() => expect(screen.getByTestId("sound-message")).toHaveTextContent(/sync queued/i));
  });
});
