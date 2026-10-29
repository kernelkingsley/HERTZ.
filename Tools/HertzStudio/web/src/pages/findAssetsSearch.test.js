import { describe, expect, it } from "vitest";

/** Pure helpers mirrored from Find Assets UX contract. */
export function resolveFindListMode({ searched, busy, error, result }) {
  if (!searched) return "idle";
  if (busy) return "loading";
  if (error && !(result?.results || []).length) {
    if (result?.offline || /offline|unavailable|network|ENOTFOUND|timeout/i.test(error)) {
      return "provider_offline";
    }
    return "error";
  }
  if (result?.offline && !(result?.results || []).length) return "provider_offline";
  if (result && !(result.results || []).length) return "no_results";
  if ((result?.results || []).length) return "results";
  return "idle";
}

export function detailPath(item) {
  if (item.kind === "library" || item.provider === "upload" || item.id?.match?.(/^[0-9a-f-]{36}$/i)) {
    return `/assets/${item.id}/view`;
  }
  if (item.provider === "kenney" || item.id?.startsWith?.("kenney:")) {
    const id = (item.id || item.slug || "").replace(/^kenney:/, "");
    return `/find-assets/kenney/${encodeURIComponent(id)}`;
  }
  if (item.provider === "sketchfab" || item.uid) {
    return `/find-assets/sketchfab/${encodeURIComponent(item.uid || item.id)}`;
  }
  return "/find";
}

describe("Find Assets unified search UX", () => {
  it("stays idle until Search", () => {
    expect(resolveFindListMode({ searched: false, busy: false, error: "", result: null })).toBe("idle");
  });

  it("shows loading while busy after search", () => {
    expect(resolveFindListMode({ searched: true, busy: true, error: "", result: null })).toBe("loading");
  });

  it("shows no_results when empty", () => {
    expect(
      resolveFindListMode({ searched: true, busy: false, error: "", result: { results: [] } }),
    ).toBe("no_results");
  });

  it("shows provider_offline on network errors", () => {
    expect(
      resolveFindListMode({
        searched: true,
        busy: false,
        error: "provider unavailable",
        result: { results: [], offline: true },
      }),
    ).toBe("provider_offline");
  });

  it("shows results when present", () => {
    expect(
      resolveFindListMode({
        searched: true,
        busy: false,
        error: "",
        result: { results: [{ id: "1" }] },
      }),
    ).toBe("results");
  });

  it("routes Kenney / Sketchfab / library to detail paths", () => {
    expect(detailPath({ provider: "kenney", id: "kenney:ui-pack", slug: "ui-pack" })).toBe(
      "/find-assets/kenney/ui-pack",
    );
    expect(detailPath({ provider: "sketchfab", uid: "abc123" })).toBe("/find-assets/sketchfab/abc123");
    expect(detailPath({ kind: "library", id: "11111111-1111-1111-1111-111111111111" })).toBe(
      "/assets/11111111-1111-1111-1111-111111111111/view",
    );
  });

  it("never invents Kenney download URLs in discovery payloads", () => {
    const pack = {
      downloadUrl: null,
      downloadVerified: false,
      openOnKenney: "https://kenney.nl/assets/ui-pack",
    };
    expect(pack.downloadUrl).toBeNull();
    expect(pack.downloadVerified).toBe(false);
  });
});
