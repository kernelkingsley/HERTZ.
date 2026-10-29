import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Milestones from "./Milestones.jsx";

vi.mock("../api.js", () => ({
  api: vi.fn(),
}));

vi.mock("../lib/milestoneStatus.js", () => ({
  listMilestones: () => [
    {
      id: "W05",
      title: "Characters & Enemies",
      status: "Ready for Kingsley testing",
      gates: {
        tasksComplete: true,
        automatedVerification: true,
        manualVerification: true,
        codexReview: true,
        kingsleyTesting: false,
      },
    },
    {
      id: "W03",
      title: "Level editor",
      status: "Completed",
      gates: {
        tasksComplete: true,
        automatedVerification: true,
        manualVerification: true,
        codexReview: true,
        kingsleyTesting: true,
      },
    },
  ],
  summarizeMilestoneProgress: () => ({
    percentComplete: 14,
    completed: 2,
    total: 14,
    counts: { Completed: 2, "Ready for Kingsley testing": 1 },
  }),
  statusBadgeVariant: () => "secondary",
}));

import { api } from "../api.js";

describe("Milestones detail view", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    cleanup();
    api.mockReset();
    api.mockImplementation(async (path) => {
      if (path === "/api/milestones/W05/details") {
        return {
          id: "W05",
          title: "Characters & Enemies",
          status: "Ready for Kingsley testing",
          statusNote: "Models vs profiles",
          placeholder: false,
          features: ["Transform-seek hold wait→fire"],
          files: ["Assets/Scripts/Characters/HertzEnemyAgent.cs"],
          assets: ["HertzCharacterTest.unity"],
          behavioralChanges: ["Hold enemies wait then fire"],
          proofs: [
            {
              file: "w05-character-behavior-proof.json",
              present: true,
              ok: true,
              passed: 18,
              total: 18,
            },
          ],
          proofSummary: { present: 1, ok: 1, total: 1 },
        };
      }
      return {};
    });
  });

  it("opens detail panel with features files assets and proofs for W05", async () => {
    render(
      <MemoryRouter>
        <Milestones />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("milestone-row-W05"));
    await waitFor(() => expect(screen.getByTestId("milestone-detail-panel")).toBeInTheDocument());
    expect(screen.getByTestId("milestone-detail-features")).toHaveTextContent(/hold wait/i);
    expect(screen.getByTestId("milestone-detail-files")).toHaveTextContent(/HertzEnemyAgent/);
    expect(screen.getByTestId("milestone-detail-assets")).toHaveTextContent(/HertzCharacterTest/);
    expect(screen.getByTestId("milestone-detail-behavior")).toHaveTextContent(/wait then fire/i);
    expect(screen.getByTestId("milestone-proof-w05-character-behavior-proof.json")).toHaveTextContent(
      /pass 18\/18/,
    );
  });
});
