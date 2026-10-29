/**
 * Component regression: Reset must use current slot + assignment (not load-time closure).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, act } from "@testing-library/react";

const clipActions = [];

vi.mock("three", () => {
  class Object3D {
    constructor() {
      this.position = { set() {}, sub() {} };
      this.isSkinnedMesh = false;
    }
    traverse() {}
  }
  class Vector3 {
    set() {
      return this;
    }
  }
  class Box3 {
    setFromObject() {
      return this;
    }
    getSize(v) {
      v.x = 1;
      v.y = 1;
      v.z = 1;
    }
    getCenter(v) {
      v.x = 0;
      v.y = 0;
      v.z = 0;
    }
  }
  class Color {}
  class AnimationMixer {
    constructor() {
      this._clip = null;
    }
    clipAction(clip) {
      const action = {
        clip,
        reset: vi.fn(function reset() {
          return this;
        }),
        setLoop: vi.fn(function setLoop() {
          return this;
        }),
        play: vi.fn(),
        stop: vi.fn(),
        paused: false,
      };
      clipActions.push(action);
      this._clip = clip;
      return action;
    }
    update() {}
    stopAllAction() {}
  }
  class WebGLRenderer {
    constructor() {
      this.domElement = document.createElement("canvas");
      this.outputColorSpace = null;
    }
    setPixelRatio() {}
    setSize() {}
    dispose() {}
    render() {}
  }
  class Scene {
    constructor() {
      this.background = null;
    }
    add() {}
  }
  class PerspectiveCamera {
    constructor() {
      this.position = { set() {} };
    }
  }
  class HemisphereLight {}
  class DirectionalLight {
    constructor() {
      this.position = { set() {} };
    }
  }
  class GridHelper {
    constructor() {
      this.geometry = { dispose() {} };
      this.material = { dispose() {} };
    }
  }
  return {
    WebGLRenderer,
    Scene,
    PerspectiveCamera,
    HemisphereLight,
    DirectionalLight,
    GridHelper,
    Color,
    Box3,
    Vector3,
    Object3D,
    AnimationMixer,
    SRGBColorSpace: "srgb",
    LoopRepeat: 2201,
    Clock: class {
      getDelta() {
        return 0.016;
      }
    },
  };
});

vi.mock("three/examples/jsm/controls/OrbitControls.js", () => ({
  OrbitControls: class {
    constructor() {
      this.target = { set() {} };
      this.enableDamping = true;
    }
    update() {}
    dispose() {}
  },
}));

vi.mock("three/examples/jsm/loaders/GLTFLoader.js", () => ({
  GLTFLoader: class {
    constructor() {
      this.manager = { setURLModifier() {} };
    }
    load(_url, onLoad) {
      const root = {
        position: { sub() {} },
        traverse() {},
      };
      onLoad({
        scene: root,
        animations: [{ name: "Idle" }, { name: "Attack" }, { name: "Wave" }],
      });
    }
  },
}));

import CharacterPreview from "./CharacterPreview.jsx";

describe("CharacterPreview Reset current slot/assignment", () => {
  afterEach(() => {
    cleanup();
    clipActions.length = 0;
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    clipActions.length = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  });

  it("Reset keeps attack after slot switch; unmatched assignment plays nothing", async () => {
    const assignments = {
      idle: { assetId: "a", displayName: "Idle", assetType: "model_3d" },
      attack: { assetId: "b", displayName: "Attack", assetType: "model_3d" },
      locomotion: null,
    };
    let slot = "idle";
    let onSlotChange = (s) => {
      slot = s;
    };

    const { rerender } = render(
      <CharacterPreview
        modelUrl="/api/assets/x/model"
        modelAssetId="x"
        previewSlot={slot}
        slotAssignments={assignments}
        onSlotChange={(s) => {
          onSlotChange(s);
          rerender(
            <CharacterPreview
              modelUrl="/api/assets/x/model"
              modelAssetId="x"
              previewSlot={s}
              slotAssignments={assignments}
              onSlotChange={onSlotChange}
            />,
          );
        }}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("character-preview-playing")).toHaveTextContent(/Idle/i));

    fireEvent.click(screen.getByTestId("character-preview-slot-attack"));
    await waitFor(() => expect(screen.getByTestId("character-preview-playing")).toHaveTextContent(/Attack/i));

    fireEvent.click(screen.getByTestId("character-preview-reset"));
    await waitFor(() => expect(screen.getByTestId("character-preview-playing")).toHaveTextContent(/Attack/i));

    const nextAssignments = {
      ...assignments,
      attack: { assetId: "c", displayName: "Punch", assetType: "model_3d", fileFormat: "glb" },
    };
    await act(async () => {
      rerender(
        <CharacterPreview
          modelUrl="/api/assets/x/model"
          modelAssetId="x"
          previewSlot="attack"
          slotAssignments={nextAssignments}
          onSlotChange={() => {}}
        />,
      );
    });

    fireEvent.click(screen.getByTestId("character-preview-reset"));
    await waitFor(() =>
      expect(screen.getByTestId("character-preview-playing")).toHaveTextContent(/Nothing/i),
    );
    expect(screen.getByTestId("character-preview-hint")).toHaveAttribute(
      "data-playback",
      "unavailable_no_match",
    );
  });
});
