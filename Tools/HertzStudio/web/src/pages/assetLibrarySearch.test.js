import { describe, expect, it } from "vitest";
import {
  buildAssetQuery,
  changePage,
  clearAllFilters,
  createEmptyFilters,
  hasActiveFilters,
  resolveListState,
  submitSearch,
} from "./assetLibrarySearch.js";

describe("assetLibrarySearch helpers", () => {
  it("buildAssetQuery omits empty filters and includes page", () => {
    const qs = buildAssetQuery({
      q: "tree",
      type: "model_3d",
      provider: "",
      pack: "",
      license: "CC0",
      state: "",
      page: 2,
    });
    const params = new URLSearchParams(qs);
    expect(params.get("q")).toBe("tree");
    expect(params.get("type")).toBe("model_3d");
    expect(params.get("license")).toBe("CC0");
    expect(params.get("provider")).toBeNull();
    expect(params.get("page")).toBe("2");
    expect(params.get("pageSize")).toBe("24");
  });

  it("submitSearch resets page to 1 while keeping other draft values", () => {
    const applied = submitSearch({
      ...createEmptyFilters(),
      q: "rock",
      type: "texture",
      provider: "kenney",
      page: 4,
    });
    expect(applied.q).toBe("rock");
    expect(applied.type).toBe("texture");
    expect(applied.provider).toBe("kenney");
    expect(applied.page).toBe(1);
  });

  it("clearAllFilters returns empty defaults", () => {
    expect(clearAllFilters()).toEqual(createEmptyFilters());
    expect(hasActiveFilters(clearAllFilters())).toBe(false);
  });

  it("changePage preserves filters", () => {
    const next = changePage({ q: "a", type: "ui", provider: "", pack: "", license: "", state: "", page: 1 }, 3);
    expect(next.q).toBe("a");
    expect(next.type).toBe("ui");
    expect(next.page).toBe(3);
  });

  it("resolveListState: empty library even with leftover filters when storage is 0", () => {
    expect(
      resolveListState({
        data: { total: 0, assets: [], storageUsedBytes: 0 },
        applied: { ...createEmptyFilters(), type: "audio", provider: "kenney" },
      }),
    ).toBe("empty_library");
  });

  it("resolveListState: no_matches when storage has data but filters miss", () => {
    expect(
      resolveListState({
        data: { total: 0, assets: [], storageUsedBytes: 1200 },
        applied: { ...createEmptyFilters(), q: "zzz" },
      }),
    ).toBe("no_matches");
  });

  it("resolveListState: results when assets present", () => {
    expect(
      resolveListState({
        data: { total: 1, assets: [{ id: "1" }], storageUsedBytes: 10 },
        applied: createEmptyFilters(),
      }),
    ).toBe("results");
  });

  it("hasActiveFilters detects combined filters", () => {
    expect(hasActiveFilters({ ...createEmptyFilters(), type: "ui", license: "CC0" })).toBe(true);
  });
});
