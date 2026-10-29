import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { rewriteModelDependencyUrl } from "../lib/modelDepUrl.js";
import { loadStudioModel } from "../lib/loadStudioModel.js";

/**
 * Lazy Three.js model viewer (GLB/GLTF/FBX) — only loaded on details routes.
 * Disposes geometry, materials, textures, controls, renderer, and object URLs on unmount.
 *
 * Optional `viewerApiRef` exposes a small preview/effects interface for weapon Studio fire
 * without duplicating the loading stack. Source model is never mutated permanently.
 *
 * `onViewerReady` is held in a ref so parent callback identity cannot retrigger the load effect.
 * Load/dispose runs only when `url`, `assetId`, or `format` changes.
 */
export default function ModelViewer({
  url,
  assetId,
  format = null,
  fileName = null,
  viewerApiRef = null,
  onViewerReady = null,
}) {
  const mountRef = useRef(null);
  const apiRef = useRef(null);
  const viewerApiRefHold = useRef(viewerApiRef);
  const onViewerReadyRef = useRef(onViewerReady);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(0);
  const [meta, setMeta] = useState(null);
  const [autorotate, setAutorotate] = useState(false);

  viewerApiRefHold.current = viewerApiRef;
  onViewerReadyRef.current = onViewerReady;

  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    const mount = mountRef.current;
    const apiSlot = viewerApiRefHold.current;
    if (!mount || !url) {
      if (apiSlot) apiSlot.current = null;
      return undefined;
    }

    (async () => {
      try {
        const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
        const loaded = await loadStudioModel({
          url,
          assetId,
          format,
          fileName,
          onProgress: (pct) => setLoading(pct),
          urlModifier: assetId
            ? (requestUrl) => rewriteModelDependencyUrl(requestUrl, assetId, window.location.origin)
            : null,
        });
        if (cancelled) {
          disposeObject(loaded.root, loaded.THREE);
          return;
        }
        const THREE = loaded.THREE;

        const width = mount.clientWidth || 640;
        const height = Math.max(320, Math.round(width * 0.62));
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
        // Bound render resolution so search/dashboard routes never pay this cost (viewer is details-only).
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
        renderer.setSize(Math.min(width, 1280), Math.min(height, 800));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        mount.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x12151b);
        const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 2000);
        camera.position.set(2, 1.5, 2.5);

        const hemi = new THREE.HemisphereLight(0xffffff, 0x334455, 1.1);
        scene.add(hemi);
        const dir = new THREE.DirectionalLight(0xffffff, 0.85);
        dir.position.set(3, 5, 2);
        scene.add(dir);

        const grid = new THREE.GridHelper(4, 16, 0x3a4250, 0x242a33);
        scene.add(grid);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.enablePan = true;
        controls.target.set(0, 0.5, 0);

        const root = loaded.root;
        // Preview pivot isolates recoil from orbit framing / source transforms.
        const previewPivot = new THREE.Group();
        previewPivot.name = "HertzStudioPreviewPivot";
        previewPivot.add(root);
        scene.add(previewPivot);

        const box = new THREE.Box3().setFromObject(root);
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);
        root.position.sub(center);

        let triangles = 0;
        let vertices = 0;
        let meshes = 0;
        let materials = new Set();
        let textures = 0;
        let hasSkin = false;
        let hasSkeleton = false;
        root.traverse((obj) => {
          if (obj.isSkinnedMesh) hasSkin = true;
          if (obj.isBone || obj.isSkeleton) hasSkeleton = true;
          if (obj.isMesh) {
            meshes += 1;
            const geo = obj.geometry;
            if (geo?.attributes?.position) vertices += geo.attributes.position.count;
            if (geo?.index) triangles += geo.index.count / 3;
            else if (geo?.attributes?.position) triangles += geo.attributes.position.count / 3;
            if (obj.material) {
              const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
              mats.forEach((m) => {
                materials.add(m.uuid);
                Object.values(m).forEach((v) => {
                  if (v && v.isTexture) textures += 1;
                });
              });
            }
          }
        });

        const clips = (loaded.animations || []).map((c) => ({
          name: c.name || "clip",
          duration: c.duration,
        }));

        setMeta({
          source: "inspected",
          boundingBox: {
            x: Number(size.x.toFixed(4)),
            y: Number(size.y.toFixed(4)),
            z: Number(size.z.toFixed(4)),
            units: "model_local",
          },
          vertices,
          triangles: Math.round(triangles),
          meshes,
          materials: materials.size,
          textures,
          animations: clips,
          hasAnimations: clips.length > 0,
          rigged: hasSkin || hasSkeleton ? "Yes" : clips.length ? "Unknown" : "No",
          hasSkin,
          hasSkeleton,
          warnings: [
            size.x > 100 || size.y > 100 || size.z > 100 ? "Model scale appears large — units may be millimeters or uncertain." : null,
          ].filter(Boolean),
        });

        const fit = () => {
          const maxDim = Math.max(size.x, size.y, size.z, 0.001);
          const dist = maxDim * 2.2;
          camera.position.set(dist, dist * 0.7, dist);
          controls.target.set(0, 0, 0);
          controls.update();
        };
        fit();

        const transients = [];
        const markerRoots = [];
        const _world = new THREE.Vector3();
        const _dir = new THREE.Vector3();
        const markerColors = {
          Grip: 0x44cc88,
          Muzzle: 0xffcc44,
          LeftHand: 0x66aaff,
          RightHand: 0xff66aa,
        };

        function makeMarker(label, color) {
          const group = new THREE.Group();
          group.name = `HertzStudioAnchorMarker_${label}`;
          const sphere = new THREE.Mesh(
            new THREE.SphereGeometry(0.025, 10, 10),
            new THREE.MeshBasicMaterial({ color, depthTest: false }),
          );
          sphere.renderOrder = 10;
          group.add(sphere);
          const stemGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(0, 0, 0.12),
          ]);
          const stem = new THREE.Line(stemGeo, new THREE.LineBasicMaterial({ color, depthTest: false }));
          stem.renderOrder = 10;
          group.add(stem);
          group.userData.hertzAnchorLabel = label;
          return group;
        }

        function clearMarkers() {
          while (markerRoots.length) {
            const obj = markerRoots.pop();
            scene.remove(obj);
            disposeObject(obj, THREE);
          }
        }

        const effectsApi = {
          ready: true,
          THREE,
          findByName(name) {
            if (!name) return null;
            let found = null;
            root.traverse((obj) => {
              if (found) return;
              if (obj.name === name) found = obj;
            });
            return found;
          },
          getWorldPosition(obj, out = _world) {
            if (!obj) return null;
            obj.updateWorldMatrix(true, false);
            obj.getWorldPosition(out);
            return out.clone();
          },
          getWorldDirection(obj, out = _dir) {
            if (!obj) return null;
            obj.updateWorldMatrix(true, false);
            // Object3D positive-Z axis in world space — muzzle forward, not fixed world +Z.
            if (typeof obj.getWorldDirection === "function") {
              obj.getWorldDirection(out);
            } else {
              out.set(0, 0, 1).applyQuaternion(obj.getWorldQuaternion(new THREE.Quaternion()));
            }
            if (out.lengthSq() < 1e-8) out.set(0, 0, 1);
            else out.normalize();
            return out.clone();
          },
          setRecoilOffset(y) {
            previewPivot.position.y = Number(y) || 0;
          },
          getRecoilOffset() {
            return previewPivot.position.y;
          },
          resetRecoil() {
            previewPivot.position.set(0, 0, 0);
            previewPivot.rotation.set(0, 0, 0);
          },
          addTransient(obj) {
            if (!obj) return;
            scene.add(obj);
            transients.push(obj);
          },
          clearTransients() {
            while (transients.length) {
              const obj = transients.pop();
              scene.remove(obj);
              disposeObject(obj, THREE);
            }
          },
          clearAnchorMarkers() {
            clearMarkers();
          },
          /**
           * Resolve Grip/Muzzle/LeftHand/RightHand against the loaded hierarchy and show markers.
           * Returns truthful found/missing status for each configured name.
           */
          resolveAnchors(names = {}) {
            clearMarkers();
            const keys = ["Grip", "Muzzle", "LeftHand", "RightHand"];
            const report = {};
            for (const key of keys) {
              const configured = names[key] || names[key.toLowerCase()] || key;
              const node = effectsApi.findByName(configured);
              const found = Boolean(node);
              report[key] = {
                configured,
                found,
                state: found ? "found" : "missing",
                nodeName: node?.name || null,
              };
              const marker = makeMarker(key, markerColors[key] || 0xffffff);
              if (node) {
                const wp = effectsApi.getWorldPosition(node);
                if (wp) marker.position.copy(wp);
                const wd = effectsApi.getWorldDirection(node);
                if (wd) marker.lookAt(marker.position.clone().add(wd));
              } else {
                // Labelled fallback offsets — never claim validation.
                const fallback = {
                  Grip: new THREE.Vector3(0, -0.05, 0),
                  Muzzle: new THREE.Vector3(0, 0.05, 0.2),
                  LeftHand: new THREE.Vector3(-0.15, 0, 0),
                  RightHand: new THREE.Vector3(0.15, 0, 0),
                }[key] || new THREE.Vector3();
                marker.position.copy(fallback);
                marker.userData.hertzFallback = true;
              }
              scene.add(marker);
              markerRoots.push(marker);
            }
            return report;
          },
        };

        apiRef.current = {
          fit,
          reset: () => {
            fit();
            effectsApi.resetRecoil();
            effectsApi.clearTransients();
            controls.autoRotate = false;
            setAutorotate(false);
          },
          setAutorotate: (v) => {
            controls.autoRotate = v;
          },
          effects: effectsApi,
          dispose: () => {
            cancelAnimationFrame(raf);
            effectsApi.clearTransients();
            effectsApi.clearAnchorMarkers();
            controls.dispose();
            disposeObject(previewPivot, THREE);
            grid.geometry.dispose();
            grid.material.dispose();
            renderer.dispose();
            if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
          },
        };

        if (apiSlot) apiSlot.current = effectsApi;
        onViewerReadyRef.current?.(effectsApi);

        const tick = () => {
          raf = requestAnimationFrame(tick);
          controls.update();
          renderer.render(scene, camera);
        };
        tick();
        setLoading(100);
      } catch (err) {
        if (!cancelled) setError(err.message || "Model preview failed");
        if (apiSlot) apiSlot.current = null;
      }
    })();

    return () => {
      cancelled = true;
      apiRef.current?.dispose?.();
      apiRef.current = null;
      if (apiSlot) apiSlot.current = null;
      // Notify parents of teardown, but do not depend on callback identity for reloads.
      onViewerReadyRef.current?.(null);
    };
  }, [url, assetId, format, fileName]);

  useEffect(() => {
    apiRef.current?.setAutorotate?.(autorotate);
  }, [autorotate]);

  return (
    <div className="space-y-3" data-testid="model-viewer">
      <div
        ref={mountRef}
        className="relative min-h-[320px] w-full overflow-hidden rounded-2xl border border-white/10 bg-black/40"
        data-testid="model-viewer-canvas"
      />
      {loading > 0 && loading < 100 ? (
        <p className="text-xs text-muted-foreground">Loading model… {loading}%</p>
      ) : null}
      {error ? <p className="error text-sm">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => apiRef.current?.reset?.()}>
          Reset camera
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => apiRef.current?.fit?.()}>
          Fit to model
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setAutorotate((v) => !v)}>
          {autorotate ? "Stop autorotate" : "Autorotate"}
        </Button>
      </div>
      {meta ? (
        <dl className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2" data-testid="inspected-model-meta">
          <div>
            Bounding box (inspected): {meta.boundingBox.x} × {meta.boundingBox.y} × {meta.boundingBox.z} (
            {meta.boundingBox.units})
          </div>
          <div>
            Tris {meta.triangles} · Verts {meta.vertices} · Meshes {meta.meshes}
          </div>
          <div>
            Materials {meta.materials} · Textures {meta.textures}
          </div>
          <div>Rigged: {meta.rigged}</div>
          <div>
            Animations:{" "}
            {meta.animations.length
              ? meta.animations.map((a) => `${a.name} (${a.duration.toFixed(2)}s)`).join(", ")
              : "none"}
          </div>
          {meta.warnings?.length ? <div className="text-[var(--glow)]">{meta.warnings.join(" ")}</div> : null}
        </dl>
      ) : null}
    </div>
  );
}

function disposeObject(root, THREE) {
  root.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((m) => {
        Object.values(m).forEach((v) => {
          if (v && v.isTexture) v.dispose();
        });
        m.dispose?.();
      });
    }
  });
}
