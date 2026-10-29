import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, cleanup, waitFor, act } from "@testing-library/react";
import { useCallback, useRef, useState } from "react";

/**
 * Integration regression for the ModelViewer ↔ Weapons readiness contract.
 * Uses the real ModelViewer module with stubbed Three/GLTFLoader — not a ModelViewer mock.
 */

const loadCounts = { three: 0, gltf: 0, dispose: 0 };
const readyEvents = [];

function createSceneGraph() {
  const children = [];
  const root = {
    name: "Root",
    isMesh: false,
    position: { sub() {} },
    traverse(fn) {
      fn(root);
      for (const c of children) c.traverse?.(fn) ?? fn(c);
    },
    children,
  };
  return root;
}

vi.mock("three", () => {
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) {
      this.x = x;
      this.y = y;
      this.z = z;
    }
    set(x, y, z) {
      this.x = x;
      this.y = y;
      this.z = z;
      return this;
    }
    sub() {
      return this;
    }
    clone() {
      return new Vector3(this.x, this.y, this.z);
    }
    copy() {
      return this;
    }
    add() {
      return this;
    }
    multiplyScalar() {
      return this;
    }
    lengthSq() {
      return 1;
    }
    normalize() {
      return this;
    }
    applyQuaternion() {
      return this;
    }
  }
  class Color {
    constructor() {}
  }
  class Object3D {
    constructor() {
      this.position = new Vector3();
      this.rotation = { set() {} };
      this.name = "";
      this.children = [];
      this.userData = {};
    }
    add(c) {
      this.children.push(c);
    }
    remove() {}
    traverse(fn) {
      fn(this);
    }
    lookAt() {}
  }
  class Group extends Object3D {}
  class Scene extends Object3D {
    constructor() {
      super();
      this.background = null;
    }
  }
  class PerspectiveCamera {
    constructor() {
      this.position = new Vector3();
    }
  }
  class WebGLRenderer {
    constructor() {
      this.domElement = document.createElement("canvas");
      this.outputColorSpace = null;
    }
    setPixelRatio() {}
    setSize() {}
    render() {}
    dispose() {
      loadCounts.dispose += 1;
    }
  }
  class HemisphereLight {}
  class DirectionalLight {
    constructor() {
      this.position = new Vector3();
    }
  }
  class GridHelper {
    constructor() {
      this.geometry = { dispose() {} };
      this.material = { dispose() {} };
    }
  }
  class Box3 {
    setFromObject() {
      return this;
    }
    getSize(v) {
      v.set(1, 1, 1);
    }
    getCenter(v) {
      v.set(0, 0, 0);
    }
  }
  class SphereGeometry {}
  class MeshBasicMaterial {}
  class Mesh extends Object3D {}
  class BufferGeometry {
    setFromPoints() {
      return this;
    }
    setAttribute() {
      return this;
    }
  }
  class BufferAttribute {}
  class LineBasicMaterial {}
  class Line extends Object3D {}
  class Quaternion {}
  return {
    Vector3,
    Color,
    Object3D,
    Group,
    Scene,
    PerspectiveCamera,
    WebGLRenderer,
    HemisphereLight,
    DirectionalLight,
    GridHelper,
    Box3,
    SphereGeometry,
    MeshBasicMaterial,
    Mesh,
    BufferGeometry,
    BufferAttribute,
    LineBasicMaterial,
    Line,
    Quaternion,
    SRGBColorSpace: "srgb",
  };
});

vi.mock("three/examples/jsm/controls/OrbitControls.js", () => ({
  OrbitControls: class {
    constructor() {
      this.target = { set() {} };
      this.enableDamping = true;
      this.enablePan = true;
      this.autoRotate = false;
    }
    update() {}
    dispose() {}
  },
}));

vi.mock("three/examples/jsm/loaders/GLTFLoader.js", () => ({
  GLTFLoader: class {
    constructor() {
      loadCounts.gltf += 1;
      this.manager = { setURLModifier() {} };
    }
    load(url, onLoad) {
      loadCounts.three += 1;
      queueMicrotask(() => {
        onLoad({
          scene: createSceneGraph(),
          animations: [],
        });
      });
    }
  },
}));

vi.mock("../lib/modelDepUrl.js", () => ({
  rewriteModelDependencyUrl: (u) => u,
}));

import ModelViewer from "./ModelViewer.jsx";

/** Mirrors Weapons.jsx: stable callback; ignore cleanup null. */
function WeaponsContractHarness({ url, assetId, onLoadStats }) {
  const [epoch, setEpoch] = useState(0);
  const viewerApiRef = useRef(null);
  const handleViewerReady = useCallback((api) => {
    readyEvents.push(api ? "ready" : "null");
    if (!api) return;
    setEpoch((n) => n + 1);
  }, []);

  onLoadStats?.({ epoch, readyEvents: [...readyEvents], loads: loadCounts.gltf });

  return (
    <div data-testid="harness" data-epoch={epoch} data-loads={loadCounts.gltf}>
      <ModelViewer url={url} assetId={assetId} viewerApiRef={viewerApiRef} onViewerReady={handleViewerReady} />
      <span data-testid="epoch">{epoch}</span>
      <span data-testid="loads">{loadCounts.gltf}</span>
      <span data-testid="ready-count">{readyEvents.filter((e) => e === "ready").length}</span>
    </div>
  );
}

describe("ModelViewer readiness contract (real viewer)", () => {
  beforeEach(() => {
    loadCounts.three = 0;
    loadCounts.gltf = 0;
    loadCounts.dispose = 0;
    readyEvents.length = 0;
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("one URL load produces one ready notification and epoch update does not reload", async () => {
    render(<WeaponsContractHarness url="/models/a.glb" assetId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
    await waitFor(() => {
      expect(Number(document.querySelector("[data-testid=ready-count]")?.textContent)).toBe(1);
    });
    const loadsAfterReady = loadCounts.gltf;
    expect(loadsAfterReady).toBe(1);
    expect(Number(document.querySelector("[data-testid=epoch]")?.textContent)).toBe(1);

    // Allow any accidental re-render/effect cycle to flush.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(loadCounts.gltf).toBe(1);
    expect(readyEvents.filter((e) => e === "ready")).toHaveLength(1);
  });

  it("cleanup null does not increment readiness epoch", async () => {
    const { unmount } = render(
      <WeaponsContractHarness url="/models/a.glb" assetId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />,
    );
    await waitFor(() => {
      expect(Number(document.querySelector("[data-testid=ready-count]")?.textContent)).toBe(1);
    });
    expect(Number(document.querySelector("[data-testid=epoch]")?.textContent)).toBe(1);
    unmount();
    expect(readyEvents.filter((e) => e === "null").length).toBeGreaterThanOrEqual(1);
    // Epoch state is gone with unmount; critical: null did not schedule another GLTF load.
    expect(loadCounts.gltf).toBe(1);
  });

  it("changing assetId performs one cleanup and one new load", async () => {
    const { rerender } = render(
      <WeaponsContractHarness url="/models/a.glb" assetId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />,
    );
    await waitFor(() => {
      expect(Number(document.querySelector("[data-testid=ready-count]")?.textContent)).toBe(1);
    });
    expect(loadCounts.gltf).toBe(1);

    rerender(<WeaponsContractHarness url="/models/b.glb" assetId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" />);
    await waitFor(() => {
      expect(Number(document.querySelector("[data-testid=ready-count]")?.textContent)).toBe(2);
    });
    expect(loadCounts.gltf).toBe(2);
    expect(loadCounts.dispose).toBeGreaterThanOrEqual(1);
    expect(readyEvents.filter((e) => e === "ready")).toHaveLength(2);
  });

  it("unstable parent callback identity does not reload when url/assetId are stable", async () => {
    function UnstableParent() {
      const [, setTick] = useState(0);
      const viewerApiRef = useRef(null);
      // Intentionally unstable — ModelViewer must not reload because of this.
      const onViewerReady = (api) => {
        readyEvents.push(api ? "ready" : "null");
        if (api) setTick((n) => n + 1);
      };
      return (
        <div>
          <ModelViewer
            url="/models/stable.glb"
            assetId="cccccccc-cccc-4ccc-8ccc-cccccccccccc"
            viewerApiRef={viewerApiRef}
            onViewerReady={onViewerReady}
          />
          <span data-testid="loads">{loadCounts.gltf}</span>
        </div>
      );
    }
    render(<UnstableParent />);
    await waitFor(() => {
      expect(readyEvents.filter((e) => e === "ready").length).toBeGreaterThanOrEqual(1);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(loadCounts.gltf).toBe(1);
    expect(readyEvents.filter((e) => e === "ready")).toHaveLength(1);
  });
});
