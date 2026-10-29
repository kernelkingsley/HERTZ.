import { describe, expect, it } from "vitest";
import { LIBRARY_DRAG_MIME, libraryDragPayload } from "./chunkedUpload.js";

describe("chunked upload drag payload", () => {
  it("emits typed W03-ready drag MIME payload", () => {
    const payload = JSON.parse(
      libraryDragPayload({
        id: "asset-1",
        assetType: "model_3d",
        displayName: "Cube",
        provider: "upload",
        state: "preview_ready",
        preview: { url: "/api/assets/previews/x.glb" },
      }),
    );
    expect(LIBRARY_DRAG_MIME).toBe("application/x-hertz-asset");
    expect(payload.schema).toBe("hertz.studio.asset/v1");
    expect(payload.id).toBe("asset-1");
    expect(payload.assetType).toBe("model_3d");
    expect(payload.previewUrl).toContain("/api/assets/previews/");
  });
});
