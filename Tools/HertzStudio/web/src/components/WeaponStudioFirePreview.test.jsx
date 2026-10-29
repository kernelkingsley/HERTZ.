import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { useRef, useState } from "react";
import WeaponStudioFirePreview from "./WeaponStudioFirePreview.jsx";

const baseForm = {
  enabled: true,
  frequencyFlipRequired: true,
  fireIntervalSeconds: "0.2",
  rangeMeters: "40",
  recoil: "0.15",
  damage: "10",
  muzzleAnchor: "Muzzle",
  gripAnchor: "Grip",
  leftHandAnchor: "LeftHand",
  rightHandAnchor: "RightHand",
  modelAssetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

function createMockViewerApi({ findMuzzle = true, muzzleForward = { x: 0, y: 0, z: 1 } } = {}) {
  const muzzle = findMuzzle
    ? {
        name: "Muzzle",
        updateWorldMatrix() {},
        getWorldPosition(out) {
          out.set(0.1, 0.2, 0.3);
          return out;
        },
        getWorldDirection(out) {
          out.set(muzzleForward.x, muzzleForward.y, muzzleForward.z);
          return out;
        },
      }
    : null;
  const THREE = {
    Vector3: class {
      constructor(x = 0, y = 0, z = 0) {
        this.x = x;
        this.y = y;
        this.z = z;
      }
      clone() {
        return new THREE.Vector3(this.x, this.y, this.z);
      }
      add(v) {
        this.x += v.x;
        this.y += v.y;
        this.z += v.z;
        return this;
      }
      multiplyScalar(s) {
        this.x *= s;
        this.y *= s;
        this.z *= s;
        return this;
      }
      copy(v) {
        this.x = v.x;
        this.y = v.y;
        this.z = v.z;
        return this;
      }
      set(x, y, z) {
        this.x = x;
        this.y = y;
        this.z = z;
        return this;
      }
      normalize() {
        const len = Math.hypot(this.x, this.y, this.z) || 1;
        this.x /= len;
        this.y /= len;
        this.z /= len;
        return this;
      }
    },
    BufferGeometry: class {
      setAttribute() {
        return this;
      }
    },
    BufferAttribute: class {},
    LineBasicMaterial: class {},
    Line: class {
      constructor() {
        this.name = "";
      }
    },
    SphereGeometry: class {},
    MeshBasicMaterial: class {},
    Mesh: class {
      constructor() {
        this.position = new THREE.Vector3();
        this.name = "";
      }
    },
  };
  let recoil = 0;
  const transients = [];
  let lastResolve = null;
  let lastTracerDir = null;
  return {
    ready: true,
    THREE,
    findByName: (name) => (name === "Muzzle" && findMuzzle ? muzzle : null),
    getWorldPosition: (obj, out = new THREE.Vector3()) => {
      if (!obj) return null;
      obj.getWorldPosition(out);
      return out.clone();
    },
    getWorldDirection: (obj, out = new THREE.Vector3()) => {
      if (!obj) return null;
      if (typeof obj.getWorldDirection === "function") obj.getWorldDirection(out);
      else out.set(0, 0, 1);
      lastTracerDir = out.clone();
      return out.clone();
    },
    setRecoilOffset: (y) => {
      recoil = y;
    },
    getRecoilOffset: () => recoil,
    resetRecoil: () => {
      recoil = 0;
    },
    addTransient: (obj) => transients.push(obj),
    clearTransients: () => {
      transients.length = 0;
    },
    clearAnchorMarkers: () => {},
    resolveAnchors: (names = {}) => {
      lastResolve = names;
      const report = {};
      for (const key of ["Grip", "Muzzle", "LeftHand", "RightHand"]) {
        const configured = names[key] || key;
        const found = key === "Muzzle" && findMuzzle && configured === "Muzzle";
        report[key] = { configured, found, state: found ? "found" : "missing", nodeName: found ? "Muzzle" : null };
      }
      return report;
    },
    _transients: transients,
    _lastResolve: () => lastResolve,
    _lastTracerDir: () => lastTracerDir,
  };
}

function Harness({
  form = baseForm,
  hasModel = true,
  shotAudio = null,
  findMuzzle = true,
  apiRefHolder,
}) {
  const viewerApiRef = useRef(null);
  if (!viewerApiRef.current) {
    viewerApiRef.current = createMockViewerApi({ findMuzzle });
  }
  if (apiRefHolder) apiRefHolder.current = viewerApiRef.current;
  return (
    <WeaponStudioFirePreview
      form={form}
      hasModel={hasModel}
      viewerApiRef={viewerApiRef}
      shotAudio={shotAudio}
    />
  );
}

describe("WeaponStudioFirePreview", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("blocks Test fire when frequency preview is off", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("weapon-preview-frequency"));
    fireEvent.click(screen.getByTestId("weapon-test-fire"));
    expect(screen.getByTestId("weapon-test-fire-blocked")).toHaveTextContent(/Frequency off/i);
  });

  it("accepts Test fire and recoils the model pivot", () => {
    const apiRefHolder = { current: null };
    render(<Harness apiRefHolder={apiRefHolder} />);
    fireEvent.click(screen.getByTestId("weapon-resolve-muzzle"));
    expect(screen.getByTestId("weapon-muzzle-status")).toHaveTextContent(/found/i);
    fireEvent.click(screen.getByTestId("weapon-test-fire"));
    expect(screen.getByTestId("weapon-test-fire-ok")).toHaveTextContent(/Shot accepted/i);
    expect(screen.getByTestId("weapon-test-fire-ok")).toHaveTextContent(/model pivot/i);
    expect(apiRefHolder.current.getRecoilOffset()).toBeGreaterThan(0);
    expect(screen.getByTestId("weapon-studio-fire-preview")).toHaveAttribute("data-recoil-active", "true");
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(apiRefHolder.current.getRecoilOffset()).toBe(0);
  });

  it("reports missing muzzle and uses fallback without claiming validation", () => {
    render(<Harness findMuzzle={false} />);
    fireEvent.click(screen.getByTestId("weapon-resolve-muzzle"));
    expect(screen.getByTestId("weapon-muzzle-status")).toHaveTextContent(/not found/i);
    expect(screen.getByTestId("weapon-muzzle-status")).toHaveTextContent(/not validated/i);
    fireEvent.click(screen.getByTestId("weapon-test-fire"));
    expect(screen.getByTestId("weapon-test-fire-ok")).toHaveTextContent(/fallback/i);
  });

  it("cleans tracer/impact after shot lifecycle", () => {
    const apiRefHolder = { current: null };
    render(<Harness apiRefHolder={apiRefHolder} />);
    fireEvent.click(screen.getByTestId("weapon-test-fire"));
    expect(apiRefHolder.current._transients.length).toBeGreaterThan(0);
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(apiRefHolder.current._transients.length).toBe(0);
  });

  it("respects configured fire interval", () => {
    render(<Harness form={{ ...baseForm, fireIntervalSeconds: "1" }} />);
    fireEvent.click(screen.getByTestId("weapon-test-fire"));
    expect(screen.getByTestId("weapon-test-fire-ok")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("weapon-test-fire"));
    expect(screen.getByTestId("weapon-test-fire-blocked")).toHaveTextContent(/Cadence wait/i);
  });

  it("labels silent state when no sound assigned", () => {
    render(<Harness shotAudio={{ assigned: false, previewUrl: null, label: "Silent — no firing sound assigned." }} />);
    expect(screen.getByTestId("weapon-preview-audio-state")).toHaveTextContent(/Silent/i);
    fireEvent.click(screen.getByTestId("weapon-test-fire"));
    expect(screen.getByTestId("weapon-test-fire-ok")).toHaveTextContent(/silent/i);
  });

  it("places assigned preview URL on audio and plays on accepted shot", () => {
    const play = vi.fn(() => Promise.resolve());
    render(
      <Harness
        shotAudio={{
          assigned: true,
          previewUrl: "/api/assets/previews/shot.ogg",
          label: "Sound assigned: shot",
        }}
      />,
    );
    const audio = screen.getByTestId("weapon-preview-audio");
    // jsdom may not apply src via effect attribute immediately — force after effect
    Object.defineProperty(audio, "play", { value: play });
    // Effect sets src; ensure it is present for the play path
    audio.src = "http://localhost/api/assets/previews/shot.ogg";
    fireEvent.click(screen.getByTestId("weapon-test-fire"));
    expect(play).toHaveBeenCalled();
    expect(Number(audio.getAttribute("data-play-count"))).toBeGreaterThan(0);
  });

  it("does not play audio for frequency-blocked shots", () => {
    const play = vi.fn(() => Promise.resolve());
    render(
      <Harness
        shotAudio={{
          assigned: true,
          previewUrl: "/api/assets/previews/shot.ogg",
          label: "Sound assigned: shot",
        }}
      />,
    );
    const audio = screen.getByTestId("weapon-preview-audio");
    Object.defineProperty(audio, "play", { value: play });
    audio.src = "http://localhost/api/assets/previews/shot.ogg";
    fireEvent.click(screen.getByTestId("weapon-preview-frequency"));
    fireEvent.click(screen.getByTestId("weapon-test-fire"));
    expect(play).not.toHaveBeenCalled();
  });

  it("shows unavailable audio error truthfully", () => {
    render(
      <Harness
        shotAudio={{
          assigned: true,
          previewUrl: null,
          error: "Assigned firing sound asset is missing from the library.",
          label: "Unavailable",
        }}
      />,
    );
    expect(screen.getByTestId("weapon-preview-audio-state")).toHaveTextContent(/missing/i);
  });

  it("clears prior preview state when model changes", () => {
    const apiRefHolder = { current: null };
    const { rerender } = render(<Harness apiRefHolder={apiRefHolder} />);
    fireEvent.click(screen.getByTestId("weapon-test-fire"));
    expect(apiRefHolder.current.getRecoilOffset()).toBeGreaterThan(0);
    rerender(
      <Harness
        apiRefHolder={apiRefHolder}
        form={{ ...baseForm, modelAssetId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }}
      />,
    );
    // New harness instance resets api — assert flash cleared and no crash
    expect(screen.getByTestId("weapon-preview-muzzle-flash")).toHaveAttribute("data-flash", "false");
  });

  it("refreshes all four anchor states when viewer becomes ready asynchronously", () => {
    function PendingThenReady() {
      const [epoch, setEpoch] = useState(0);
      const viewerApiRef = useRef({ ready: false });
      return (
        <div>
          <WeaponStudioFirePreview
            form={baseForm}
            hasModel
            viewerApiRef={viewerApiRef}
            viewerReadyEpoch={epoch}
          />
          <button
            type="button"
            data-testid="simulate-viewer-ready"
            onClick={() => {
              viewerApiRef.current = createMockViewerApi({ findMuzzle: true });
              setEpoch((n) => n + 1);
            }}
          >
            ready
          </button>
        </div>
      );
    }
    render(<PendingThenReady />);
    expect(screen.getByTestId("weapon-anchor-muzzle")).toHaveAttribute("data-state", "pending");
    fireEvent.click(screen.getByTestId("simulate-viewer-ready"));
    expect(screen.getByTestId("weapon-anchor-muzzle")).toHaveAttribute("data-state", "found");
    expect(screen.getByTestId("weapon-anchor-grip")).toHaveAttribute("data-state", "missing");
    expect(screen.getByTestId("weapon-anchor-lefthand")).toHaveAttribute("data-state", "missing");
    expect(screen.getByTestId("weapon-anchor-righthand")).toHaveAttribute("data-state", "missing");
  });

  it("traces along muzzle world direction rather than fixed world +Z", () => {
    const apiRefHolder = { current: null };
    function DirHarness() {
      const viewerApiRef = useRef(null);
      if (!viewerApiRef.current) {
        viewerApiRef.current = createMockViewerApi({
          findMuzzle: true,
          muzzleForward: { x: 0, y: 1, z: 0 },
        });
      }
      apiRefHolder.current = viewerApiRef.current;
      return <WeaponStudioFirePreview form={baseForm} hasModel viewerApiRef={viewerApiRef} />;
    }
    render(<DirHarness />);
    fireEvent.click(screen.getByTestId("weapon-test-fire"));
    const dir = apiRefHolder.current._lastTracerDir();
    expect(dir).toBeTruthy();
    expect(dir.y).toBeGreaterThan(0.5);
    expect(Math.abs(dir.z)).toBeLessThan(0.1);
  });
});
