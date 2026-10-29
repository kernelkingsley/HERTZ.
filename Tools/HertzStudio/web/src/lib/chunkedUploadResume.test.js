import { beforeEach, describe, expect, it } from "vitest";
import { clearResumeMeta, loadResumeMeta, saveResumeMeta } from "./chunkedUpload.js";

describe("chunked upload resume persistence", () => {
  beforeEach(() => {
    clearResumeMeta();
  });

  it("persists and clears non-secret resume metadata", () => {
    saveResumeMeta({
      uploadId: "u1",
      fileName: "big.glb",
      byteSize: 10,
      offset: 4,
      updatedAt: new Date().toISOString(),
    });
    const meta = loadResumeMeta();
    expect(meta.uploadId).toBe("u1");
    expect(meta.offset).toBe(4);
    expect(meta.fileName).toBe("big.glb");
    clearResumeMeta();
    expect(loadResumeMeta()).toBeNull();
  });
});
