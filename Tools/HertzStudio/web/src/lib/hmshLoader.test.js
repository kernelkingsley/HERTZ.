import { describe, expect, it } from "vitest";
import {
  encodeHmsh1ForTest,
  encodeHmsh2ForTest,
  parseHmshArrayBuffer,
} from "./hmshLoader.js";

function fakeTHREE() {
  class BufferAttribute {
    constructor(array, itemSize) {
      this.array = array;
      this.itemSize = itemSize;
    }
  }
  class BufferGeometry {
    constructor() {
      this.attributes = {};
      this.index = null;
      this.groups = [];
    }
    setAttribute(name, attr) {
      this.attributes[name] = attr;
    }
    setIndex(attr) {
      this.index = attr;
    }
    addGroup(start, count, materialIndex) {
      this.groups.push({ start, count, materialIndex });
    }
    computeVertexNormals() {}
    computeBoundingSphere() {
      this.boundingSphere = { radius: 1 };
    }
  }
  class Color {
    constructor(r, g, b) {
      this.r = r;
      this.g = g;
      this.b = b;
    }
  }
  class MeshStandardMaterial {
    constructor(opts) {
      Object.assign(this, opts);
    }
  }
  return {
    BufferAttribute,
    BufferGeometry,
    Color,
    MeshStandardMaterial,
    DoubleSide: 2,
  };
}

describe("hmshLoader", () => {
  it("loads one-submesh legacy hmsh1 geometry", () => {
    const THREE = fakeTHREE();
    const buf = encodeHmsh1ForTest({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
    });
    const parsed = parseHmshArrayBuffer(buf, THREE);
    expect(parsed.version).toBe(1);
    expect(parsed.geometry.groups).toHaveLength(1);
    expect(parsed.materials).toHaveLength(1);
    expect(parsed.geometry.index.array.length).toBe(3);
  });

  it("loads multiple submeshes with distinct material colors", () => {
    const THREE = fakeTHREE();
    const buf = encodeHmsh2ForTest({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      groups: [
        { start: 0, count: 3, materialIndex: 0 },
        { start: 3, count: 3, materialIndex: 1 },
      ],
      materials: [
        { r: 1, g: 0, b: 0, a: 1 },
        { r: 0, g: 0, b: 1, a: 1 },
      ],
    });
    const parsed = parseHmshArrayBuffer(buf, THREE);
    expect(parsed.version).toBe(2);
    expect(parsed.geometry.groups).toHaveLength(2);
    expect(parsed.materials).toHaveLength(2);
    expect(parsed.materialColors[0].r).toBeCloseTo(1);
    expect(parsed.materialColors[1].b).toBeCloseTo(1);
    expect(parsed.geometry.groups[1].materialIndex).toBe(1);
  });

  it("handles missing material slots by clamping materialIndex", () => {
    const THREE = fakeTHREE();
    const buf = encodeHmsh2ForTest({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      groups: [{ start: 0, count: 3, materialIndex: 9 }],
      materials: [{ r: 0.2, g: 0.3, b: 0.4, a: 1 }],
    });
    const parsed = parseHmshArrayBuffer(buf, THREE);
    expect(parsed.geometry.groups[0].materialIndex).toBe(0);
    expect(parsed.materials).toHaveLength(1);
  });

  it("rejects malformed group/index metadata", () => {
    const THREE = fakeTHREE();
    const buf = encodeHmsh2ForTest({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      groups: [{ start: 0, count: 99, materialIndex: 0 }],
      materials: [{ r: 1, g: 1, b: 1, a: 1 }],
    });
    expect(() => parseHmshArrayBuffer(buf, THREE)).toThrow(/out of bounds/);
  });

  it("rejects unsupported stale schema versions", () => {
    const THREE = fakeTHREE();
    const buf = encodeHmsh1ForTest({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
    });
    const view = new DataView(buf);
    view.setUint32(4, 99, true);
    expect(() => parseHmshArrayBuffer(buf, THREE)).toThrow(/unsupported hmsh version 99/);
  });
});
