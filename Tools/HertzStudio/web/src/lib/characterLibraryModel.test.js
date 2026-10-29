import { describe, it, expect } from "vitest";
import {
  isUnityImportedLibraryModel,
  normalizeCharacterLibraryModel,
} from "./characterLibraryModel.js";

describe("characterLibraryModel", () => {
  it("treats Unity imported + missing canAddToCatalog as addable", () => {
    const stale = {
      id: "armored-cat",
      displayName: "Armored cat",
      state: "unity_imported",
      stateLabel: "Unity imported",
      assignable: true,
      // intentionally omit canAddToCatalog / canEnqueueImport / canRetryImport
    };
    expect(isUnityImportedLibraryModel(stale)).toBe(true);
    const n = normalizeCharacterLibraryModel(stale);
    expect(n.canAddToCatalog).toBe(true);
    expect(n.assignable).toBe(true);
    expect(n.canEnqueueImport).toBe(false);
  });

  it("derives from unity.readiness ready when assignable omitted", () => {
    const n = normalizeCharacterLibraryModel({
      id: "zombie-dog",
      displayName: "Zombie Dog",
      state: "preview_ready",
      stateLabel: "Preview ready",
      unity: { readiness: "ready" },
    });
    expect(n.canAddToCatalog).toBe(true);
    expect(n.assignable).toBe(true);
  });

  it("keeps preview-ready without Unity readiness non-addable and importable", () => {
    const n = normalizeCharacterLibraryModel({
      id: "preview-only",
      displayName: "Preview Only",
      state: "preview_ready",
      stateLabel: "Preview ready",
      assignable: false,
    });
    expect(n.canAddToCatalog).toBe(false);
    expect(n.canEnqueueImport).toBe(true);
  });

  it("failed rows get retry when enqueue is safe", () => {
    const n = normalizeCharacterLibraryModel({
      id: "failed",
      state: "failed",
      stateLabel: "Failed",
      assignable: false,
      lastError: "bridge timeout",
    });
    expect(n.canAddToCatalog).toBe(false);
    expect(n.canRetryImport).toBe(true);
    expect(n.canEnqueueImport).toBe(true);
    expect(n.lastError).toMatch(/timeout/i);
  });

  it("respects explicit canAddToCatalog false even if label says imported", () => {
    const n = normalizeCharacterLibraryModel({
      id: "blocked",
      state: "unity_imported",
      stateLabel: "Unity imported",
      assignable: true,
      canAddToCatalog: false,
      blockReason: "Catalog add blocked by policy",
    });
    expect(n.canAddToCatalog).toBe(false);
  });
});
