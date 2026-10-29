import { describe, expect, it } from "vitest";
import { rewriteModelDependencyUrl } from "./modelDepUrl.js";

const id = "59813a75-319f-4ff1-9d8a-59fc9e8e4356";

describe("rewriteModelDependencyUrl", () => {
  it("rewrites resolved scene.bin under asset id to model-dep", () => {
    const resolved = `http://127.0.0.1:8787/api/assets/${id}/scene.bin`;
    expect(rewriteModelDependencyUrl(resolved, id)).toBe(
      `/api/assets/${id}/model-dep/${encodeURIComponent("scene.bin")}`,
    );
  });

  it("preserves nested texture relative paths (not basename-only)", () => {
    const resolved = `http://127.0.0.1:8787/api/assets/${id}/textures/Mat_Robot_baseColor.png`;
    expect(rewriteModelDependencyUrl(resolved, id)).toBe(
      `/api/assets/${id}/model-dep/${encodeURIComponent("textures/Mat_Robot_baseColor.png")}`,
    );
  });

  it("leaves the primary model URL alone", () => {
    const model = `/api/assets/${id}/model`;
    expect(rewriteModelDependencyUrl(model, id)).toBe(model);
  });

  it("does not rewrite /file primary URL into model-dep/file (Characters preview bug)", () => {
    const fileUrl = `http://127.0.0.1:8787/api/assets/${id}/file`;
    expect(rewriteModelDependencyUrl(fileUrl, id)).toBe(fileUrl);
    expect(rewriteModelDependencyUrl(`/api/assets/${id}/file`, id)).toBe(`/api/assets/${id}/file`);
  });

  it("does not rewrite external https URLs", () => {
    expect(rewriteModelDependencyUrl("https://cdn.example/x.bin", id)).toBe("https://cdn.example/x.bin");
  });
});
