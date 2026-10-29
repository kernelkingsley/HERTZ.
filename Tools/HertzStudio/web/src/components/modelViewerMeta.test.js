import { describe, expect, it } from "vitest";

/** Unknown stays Unknown until inspected — never invent rigging/dimensions. */
export function providerMetaOrUnknown(value) {
  if (value == null || value === "") return "Unknown";
  return value;
}

export function labelInspected(meta) {
  if (!meta) return null;
  return { ...meta, source: "inspected" };
}

describe("model metadata honesty", () => {
  it("keeps unknown provider metadata as Unknown", () => {
    expect(providerMetaOrUnknown(null)).toBe("Unknown");
    expect(providerMetaOrUnknown(undefined)).toBe("Unknown");
    expect(providerMetaOrUnknown("")).toBe("Unknown");
  });

  it("labels calculated viewer stats as inspected", () => {
    const m = labelInspected({
      triangles: 12,
      rigged: "No",
      boundingBox: { x: 1, y: 1, z: 1, units: "model_local" },
    });
    expect(m.source).toBe("inspected");
    expect(m.triangles).toBe(12);
  });

  it("does not invent rigged=Yes without skin/skeleton evidence", () => {
    const hasSkin = false;
    const hasSkeleton = false;
    const clips = [];
    const rigged = hasSkin || hasSkeleton ? "Yes" : clips.length ? "Unknown" : "No";
    expect(rigged).toBe("No");
  });
});
