import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import AssetLibrary from "./AssetLibrary.jsx";

const apiMock = vi.fn();
const apiFormMock = vi.fn();

vi.mock("../api.js", () => ({
  api: (...args) => apiMock(...args),
  apiForm: (...args) => apiFormMock(...args),
}));

function emptyCatalog(overrides = {}) {
  return {
    total: 0,
    page: 1,
    pageSize: 24,
    pageCount: 1,
    storageUsedBytes: 0,
    storageQuotaBytes: 512 * 1024 * 1024,
    assets: [],
    ...overrides,
  };
}

function populatedCatalog() {
  return {
    total: 2,
    page: 1,
    pageSize: 24,
    pageCount: 1,
    storageUsedBytes: 4096,
    storageQuotaBytes: 512 * 1024 * 1024,
    assets: [
      {
        id: "a1",
        displayName: "Sprite A",
        assetType: "sprite",
        provider: "kenney",
        license: "CC0",
        state: "preview_ready",
        stateLabel: "Preview ready",
        byteSize: 100,
        contentHash: "abc123def456",
        preview: null,
        unity: { readiness: "pending" },
      },
      {
        id: "a2",
        displayName: "Tone B",
        assetType: "audio",
        provider: "upload",
        license: "uploaded",
        state: "preview_ready",
        stateLabel: "Preview ready",
        byteSize: 200,
        contentHash: "fff111aaa222",
        preview: { kind: "audio" },
        unity: { readiness: "pending" },
      },
    ],
  };
}

function renderLibrary() {
  return render(
    <MemoryRouter>
      <AssetLibrary />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiMock.mockReset();
  apiFormMock.mockReset();
  apiMock.mockImplementation(async (path) => {
    if (path.startsWith("/api/assets/kenney/info")) {
      return { categories: ["2D", "3D", "UI", "Audio", "Pixel", "Textures"], note: "CC0" };
    }
    if (path.startsWith("/api/assets?")) {
      return emptyCatalog();
    }
    return {};
  });
});

afterEach(() => {
  cleanup();
});

describe("AssetLibrary UI", () => {
  it("shows empty library state with Upload, Kenney, and Sketchfab actions when storage is 0", async () => {
    renderLibrary();
    const empty = await screen.findByTestId("empty-library-state");
    expect(empty).toHaveTextContent(/No assets in this library yet/i);
    expect(within(empty).getByTestId("empty-upload")).toBeInTheDocument();
    expect(within(empty).getByTestId("empty-kenney")).toBeInTheDocument();
    expect(within(empty).getByTestId("empty-sketchfab")).toHaveAttribute("href", "/find");
    expect(screen.getByTestId("library-scope-note")).toHaveTextContent(/already imported/i);
    expect(screen.getByTestId("library-scope-note")).toHaveTextContent(/Sketchfab/i);
  });

  it("does not fetch when filters change until Search is pressed; successful search shows results", async () => {
    const user = userEvent.setup();
    let lastAssetsQuery = "";
    apiMock.mockImplementation(async (path) => {
      if (path.startsWith("/api/assets/kenney/info")) {
        return { categories: ["2D"], note: "CC0" };
      }
      if (path.startsWith("/api/assets?")) {
        lastAssetsQuery = path;
        const params = new URLSearchParams(path.split("?")[1] || "");
        if (params.get("q") === "Sprite" && params.get("provider") === "kenney") {
          return populatedCatalog();
        }
        return emptyCatalog({ storageUsedBytes: 4096, total: 0 });
      }
      return {};
    });

    renderLibrary();
    await screen.findByTestId("asset-library-search-form");
    const initialCalls = apiMock.mock.calls.filter(([p]) => String(p).startsWith("/api/assets?")).length;

    await user.type(screen.getByLabelText(/^Keywords$/i), "Sprite");
    await user.selectOptions(screen.getByLabelText(/^Provider$/i), "kenney");
    expect(screen.getByTestId("filters-dirty-hint")).toBeInTheDocument();

    const afterEditCalls = apiMock.mock.calls.filter(([p]) => String(p).startsWith("/api/assets?")).length;
    expect(afterEditCalls).toBe(initialCalls);

    await user.click(screen.getByTestId("search-button"));
    await waitFor(() => {
      expect(lastAssetsQuery).toMatch(/q=Sprite/);
      expect(lastAssetsQuery).toMatch(/provider=kenney/);
    });
    expect(await screen.findByTestId("asset-grid")).toBeInTheDocument();
    expect(screen.getByText("Sprite A")).toBeInTheDocument();
  });

  it("combined filters are submitted together and reset page to 1", async () => {
    const user = userEvent.setup();
    const queries = [];
    apiMock.mockImplementation(async (path) => {
      if (path.startsWith("/api/assets/kenney/info")) return { categories: [], note: "" };
      if (path.startsWith("/api/assets?")) {
        queries.push(path);
        return populatedCatalog();
      }
      return {};
    });

    renderLibrary();
    await screen.findByTestId("search-button");
    await user.type(screen.getByLabelText(/^Keywords$/i), "Tone");
    await user.selectOptions(screen.getByLabelText(/^Type$/i), "audio");
    await user.selectOptions(screen.getByLabelText(/^License$/i), "uploaded");
    await user.selectOptions(screen.getByLabelText(/^Import state$/i), "preview_ready");
    await user.click(screen.getByTestId("search-button"));

    await waitFor(() => {
      const last = queries[queries.length - 1];
      const params = new URLSearchParams(last.split("?")[1]);
      expect(params.get("q")).toBe("Tone");
      expect(params.get("type")).toBe("audio");
      expect(params.get("license")).toBe("uploaded");
      expect(params.get("state")).toBe("preview_ready");
      expect(params.get("page")).toBe("1");
    });
  });

  it("shows no-matches state and Clear filters when library has bytes but filters miss", async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation(async (path) => {
      if (path.startsWith("/api/assets/kenney/info")) return { categories: [], note: "" };
      if (path.startsWith("/api/assets?")) {
        const params = new URLSearchParams(path.split("?")[1] || "");
        if (params.get("q") === "nomatch") {
          return emptyCatalog({ storageUsedBytes: 9000, total: 0 });
        }
        return populatedCatalog();
      }
      return {};
    });

    renderLibrary();
    await screen.findByTestId("asset-grid");
    await user.type(screen.getByLabelText(/^Keywords$/i), "nomatch");
    await user.click(screen.getByTestId("search-button"));

    const noMatch = await screen.findByTestId("no-matches-state");
    expect(noMatch).toHaveTextContent(/No assets match these filters/i);
    await user.click(within(noMatch).getByTestId("no-matches-clear"));
    await waitFor(() => {
      expect(screen.queryByTestId("no-matches-state")).not.toBeInTheDocument();
    });
    expect(await screen.findByTestId("asset-grid")).toBeInTheDocument();
  });

  it("Enter in the keywords field submits the search", async () => {
    const user = userEvent.setup();
    const queries = [];
    apiMock.mockImplementation(async (path) => {
      if (path.startsWith("/api/assets/kenney/info")) return { categories: [], note: "" };
      if (path.startsWith("/api/assets?")) {
        queries.push(path);
        const params = new URLSearchParams(path.split("?")[1] || "");
        if (params.get("q") === "enter-go") return populatedCatalog();
        return emptyCatalog({ storageUsedBytes: 1 });
      }
      return {};
    });

    renderLibrary();
    await screen.findByTestId("asset-library-search-form");
    const input = screen.getByLabelText(/^Keywords$/i);
    await user.clear(input);
    await user.type(input, "enter-go{Enter}");
    await waitFor(() => {
      const last = queries[queries.length - 1];
      expect(last).toMatch(/q=enter-go/);
    });
    expect(await screen.findByTestId("asset-grid")).toBeInTheDocument();
  });

  it("Clear all filters resets draft fields and reloads unfiltered list", async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation(async (path) => {
      if (path.startsWith("/api/assets/kenney/info")) return { categories: [], note: "" };
      if (path.startsWith("/api/assets?")) {
        const params = new URLSearchParams(path.split("?")[1] || "");
        if (params.get("type") === "ui") {
          return emptyCatalog({ storageUsedBytes: 5000, total: 0 });
        }
        return populatedCatalog();
      }
      return {};
    });

    renderLibrary();
    await screen.findByTestId("asset-grid");
    await user.selectOptions(screen.getByLabelText(/^Type$/i), "ui");
    await user.click(screen.getByTestId("search-button"));
    await screen.findByTestId("no-matches-state");

    await user.click(screen.getByTestId("clear-filters-button"));
    expect(screen.getByLabelText(/^Type$/i)).toHaveValue("");
    expect(await screen.findByTestId("asset-grid")).toBeInTheDocument();
  });
});
