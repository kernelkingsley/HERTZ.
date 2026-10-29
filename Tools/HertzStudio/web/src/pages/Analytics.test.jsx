import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Analytics from "./Analytics.jsx";

vi.mock("../api.js", () => ({
  api: vi.fn(),
}));

vi.mock("../lib/milestoneStatus.js", () => ({
  getMilestoneStatus: () => "In progress",
  statusBadgeVariant: () => "secondary",
}));

import { api } from "../api.js";

describe("Analytics UI", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    cleanup();
    api.mockReset();
    api.mockImplementation(async (path) => {
      if (String(path).startsWith("/api/analytics/summary")) {
        return {
          sampleCounts: { sessions: 1, incompleteSessions: 0 },
          combat: { shots: 2, hits: 1, accuracy: 0.5, enemyDefeats: 1, frequencyFlips: 1 },
          frameTime: { avgMs: 11.1, sampleCount: 1 },
          weaponUsage: [{ weaponId: "left", weaponRole: "left_pistol", shots: 2, hits: 1 }],
        };
      }
      if (String(path).startsWith("/api/analytics/sessions")) {
        return {
          sessions: [
            {
              sessionId: "sess-aaaaaaaaaaaa",
              buildId: "build-test",
              durationMs: 5000,
              completed: true,
              incomplete: false,
              shots: 2,
              accuracy: 0.5,
              enemyDefeats: 1,
            },
          ],
        };
      }
      if (path === "/api/analytics/schema") {
        return { questTransferNote: "Device collection unverified." };
      }
      if (path === "/api/analytics/quest-transfer") {
        return { steps: ["Prefer PC VR capture during W06."] };
      }
      return {};
    });
  });

  it("shows milestone badge, summary cards, sessions, and quest guide", async () => {
    render(
      <MemoryRouter>
        <Analytics />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("analytics-page")).toBeInTheDocument());
    expect(screen.getByTestId("analytics-milestone-badge")).toHaveTextContent(/in progress/i);
    expect(screen.getByTestId("analytics-summary-cards")).toBeInTheDocument();
    expect(screen.getByTestId("analytics-sessions-table")).toHaveTextContent(/sess-aaaaaaa/);
    expect(screen.getByTestId("analytics-quest-guide")).toHaveTextContent(/PC VR/i);
    expect(screen.getByTestId("analytics-import-file")).toBeInTheDocument();
    expect(screen.getByTestId("analytics-export-csv")).toBeInTheDocument();
  });
});
