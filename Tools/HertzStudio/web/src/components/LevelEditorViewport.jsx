import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_POSITION_SNAP,
  DEFAULT_ROTATION_SNAP_DEG,
  DEFAULT_SCALE_SNAP,
  isProtectedDraftObject,
} from "../lib/levelEditorTransforms.js";
import {
  applyUnityNavToOrbit,
  buildHierarchyPlan,
  computeFrameCameraPlacement,
  controlHelpText,
  emptyRenderStats,
  fallbackKindForObject,
  isFrameAllKey,
  isFrameSelectedKey,
  mapAxisConstraintKey,
  mapTransformToolKey,
  mapUnityMouseButtons,
  ORBIT_MAX_DISTANCE_M,
  ORBIT_MIN_DISTANCE_M,
  resolveSelectionObjectId,
  selectVisualRoots,
  shouldLoadModelForObject,
  shouldLoadNativeMeshForObject,
  summarizeRenderStats,
  threeLocalEulerToUnityDeg,
  threeLocalToUnityPosition,
  unityLocalEulerDegToThreeRadians,
  unityLocalToThreePosition,
  unityLocalToThreeScale,
  unityPointerNavIntent,
  viewPresetFromNumpad,
} from "../lib/levelEditorSceneViewport.js";
import { rewriteModelDependencyUrl } from "../lib/modelDepUrl.js";
import { loadHmshGeometry } from "../lib/hmshLoader.js";

/**
 * Lazy Three.js scene viewport: hierarchy + catalog GLTF + native mesh snapshots + Unity Scene nav.
 * Loaded only from the Level Editor route. Dashboard never pays for Three/GLTFLoader.
 */
export default function LevelEditorViewport({
  objects = [],
  selectedIndex = 0,
  transformMode = "translate",
  snapEnabled = true,
  positionSnap = DEFAULT_POSITION_SNAP,
  rotationSnapDeg = DEFAULT_ROTATION_SNAP_DEG,
  scaleSnap = DEFAULT_SCALE_SNAP,
  commitsLocked = false,
  syncToken = 0,
  draftId = null,
  descriptorsByObjectId = {},
  onSelectIndex,
  onTransformCommit,
  onTransformModeChange,
  onViewportApi,
}) {
  const mountRef = useRef(null);
  const focusRef = useRef(null);
  const apiRef = useRef(null);
  const propsRef = useRef({});
  const loadGenRef = useRef(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [statusLine, setStatusLine] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const [renderStats, setRenderStats] = useState(() => emptyRenderStats());
  const [diagnostics, setDiagnostics] = useState([]);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  propsRef.current = {
    objects,
    selectedIndex,
    transformMode,
    snapEnabled,
    positionSnap,
    rotationSnapDeg,
    scaleSnap,
    commitsLocked,
    syncToken,
    draftId,
    descriptorsByObjectId,
    onSelectIndex,
    onTransformCommit,
    onTransformModeChange,
    onViewportApi,
  };

  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    const mount = mountRef.current;
    if (!mount) return undefined;

    (async () => {
      try {
        const THREE = await import("three");
        const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
        const { TransformControls } = await import("three/examples/jsm/controls/TransformControls.js");
        const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
        const { clone: skeletonClone } = await import("three/examples/jsm/utils/SkeletonUtils.js");
        if (cancelled) return;

        const width = mount.clientWidth || 720;
        const height = Math.max(360, Math.round(width * 0.55));
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
        renderer.setSize(Math.min(width, 1400), Math.min(height, 900));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        mount.appendChild(renderer.domElement);
        renderer.domElement.style.touchAction = "none";

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x10141c);
        const camera = new THREE.PerspectiveCamera(50, width / height, 0.05, 500);
        camera.position.set(6, 5, 8);

        const hemi = new THREE.HemisphereLight(0xffffff, 0x2a3340, 1.05);
        scene.add(hemi);
        const dir = new THREE.DirectionalLight(0xffffff, 0.75);
        dir.position.set(4, 8, 3);
        scene.add(dir);

        // Unity Scene-view style ground: large grid + subtle mesh plane (HertzStudioTest has no Floor GO).
        const grid = new THREE.GridHelper(200, 200, 0x5a6578, 0x2a3340);
        grid.position.y = 0;
        scene.add(grid);
        const groundMat = new THREE.MeshStandardMaterial({
          color: 0x3d3428,
          roughness: 0.95,
          metalness: 0.02,
          transparent: true,
          opacity: 0.88,
        });
        const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), groundMat);
        ground.rotation.x = -Math.PI / 2;
        ground.position.y = -0.002;
        ground.receiveShadow = false;
        ground.name = "studioGroundPlane";
        scene.add(ground);

        const orbit = new OrbitControls(camera, renderer.domElement);
        orbit.enableDamping = true;
        orbit.target.set(0, 0.5, 0);
        orbit.mouseButtons = mapUnityMouseButtons(THREE);
        orbit.enablePan = true;
        orbit.enableRotate = true;
        orbit.enableZoom = true;
        // Prevent dollying through walls into the mesh interior.
        orbit.minDistance = ORBIT_MIN_DISTANCE_M;
        orbit.maxDistance = ORBIT_MAX_DISTANCE_M;
        camera.near = 0.1;
        camera.far = 500;
        camera.updateProjectionMatrix();

        const transform = new TransformControls(camera, renderer.domElement);
        transform.setSize(0.9);
        transform.setSpace("local");
        scene.add(transform.getHelper ? transform.getHelper() : transform);

        const hierarchyRoot = new THREE.Group();
        hierarchyRoot.name = "unityHierarchy";
        scene.add(hierarchyRoot);

        /** @type {Map<string, THREE.Object3D>} */
        const nodeByObjectId = new Map();
        /** @type {Map<string, { scene: THREE.Object3D, refCount: number }>} */
        const modelCache = new Map();
        /** @type {Map<string, Promise<THREE.Object3D>>} */
        const modelLoads = new Map();
        let dragging = false;
        let transformGestureActive = false;
        /** objectIds whose Three local TRS must not be overwritten until draft commit settles */
        const holdTransformIds = new Set();
        let preDragTransform = null;
        let paused = typeof document !== "undefined" && document.hidden;
        let liveStats = emptyRenderStats();

        const boxGeo = new THREE.BoxGeometry(0.2, 0.2, 0.2);
        const matFallback = new THREE.MeshStandardMaterial({
          color: 0x6b8cae,
          roughness: 0.75,
          metalness: 0.05,
          transparent: true,
          opacity: 0.35,
        });
        const matSelected = new THREE.MeshStandardMaterial({
          color: 0xd4a24c,
          roughness: 0.45,
          metalness: 0.1,
          transparent: true,
          opacity: 0.55,
        });
        const matProtected = new THREE.MeshStandardMaterial({
          color: 0x555b66,
          roughness: 0.9,
          metalness: 0,
          transparent: true,
          opacity: 0.4,
        });
        const matLight = new THREE.MeshStandardMaterial({
          color: 0xffe08a,
          roughness: 0.4,
          metalness: 0.1,
          transparent: true,
          opacity: 0.55,
        });
        const matLoading = new THREE.MeshStandardMaterial({
          color: 0x8aa4c8,
          roughness: 0.7,
          metalness: 0,
          transparent: true,
          opacity: 0.3,
        });

        function publishStats(partial = {}) {
          liveStats = { ...liveStats, ...partial };
          setRenderStats({ ...liveStats });
          setStatusLine(summarizeRenderStats(liveStats).label);
        }

        function readEulerDeg(obj3) {
          return {
            x: THREE.MathUtils.radToDeg(obj3.rotation.x),
            y: THREE.MathUtils.radToDeg(-obj3.rotation.y),
            z: THREE.MathUtils.radToDeg(-obj3.rotation.z),
          };
        }

        function applySnapSettings() {
          const p = propsRef.current;
          if (p.snapEnabled) {
            transform.setTranslationSnap(p.positionSnap);
            transform.setRotationSnap(THREE.MathUtils.degToRad(p.rotationSnapDeg));
            transform.setScaleSnap(p.scaleSnap);
          } else {
            transform.setTranslationSnap(null);
            transform.setRotationSnap(null);
            transform.setScaleSnap(null);
          }
        }

        function applyLocalUnityTransform(node, obj) {
          const pos = unityLocalToThreePosition(obj.localPosition || obj.position || {});
          const rot = unityLocalEulerDegToThreeRadians(obj.localRotation || obj.rotation || {}, THREE);
          const scale = unityLocalToThreeScale(obj.localScale || obj.scale || {});
          node.position.set(pos.x, pos.y, pos.z);
          node.rotation.set(rot.x, rot.y, rot.z);
          node.scale.set(scale.x, scale.y, scale.z);
        }

        function disposeExclusiveTree(root) {
          root.traverse((child) => {
            if (child.geometry && child.userData?.ownsGeometry) child.geometry.dispose?.();
            if (child.material && child.userData?.ownsMaterial) {
              const mats = Array.isArray(child.material) ? child.material : [child.material];
              mats.forEach((m) => m.dispose?.());
            }
          });
        }

        function releaseCachedModel(cacheKey) {
          const entry = modelCache.get(cacheKey);
          if (!entry) return;
          entry.refCount -= 1;
          if (entry.refCount <= 0) {
            entry.scene.traverse((child) => {
              if (child.geometry) child.geometry.dispose?.();
              if (child.material) {
                const mats = Array.isArray(child.material) ? child.material : [child.material];
                mats.forEach((m) => {
                  if (!m) return;
                  Object.values(m).forEach((v) => {
                    if (v && v.isTexture) v.dispose?.();
                  });
                  m.dispose?.();
                });
              }
            });
            modelCache.delete(cacheKey);
          }
        }

        async function loadCachedModel(cacheKey, modelUrl, assetIdForDeps = null) {
          if (modelCache.has(cacheKey)) {
            const entry = modelCache.get(cacheKey);
            entry.refCount += 1;
            return entry.scene;
          }
          if (modelLoads.has(cacheKey)) {
            const sceneRoot = await modelLoads.get(cacheKey);
            const entry = modelCache.get(cacheKey);
            if (entry) entry.refCount += 1;
            return sceneRoot;
          }
          const promise = new Promise((resolve, reject) => {
            const loader = new GLTFLoader();
            if (assetIdForDeps) {
              loader.manager.setURLModifier((requestUrl) =>
                rewriteModelDependencyUrl(requestUrl, assetIdForDeps, window.location.origin),
              );
            }
            loader.load(modelUrl, (gltf) => resolve(gltf.scene), undefined, reject);
          })
            .then((sceneRoot) => {
              modelCache.set(cacheKey, { scene: sceneRoot, refCount: 1 });
              modelLoads.delete(cacheKey);
              return sceneRoot;
            })
            .catch((err) => {
              modelLoads.delete(cacheKey);
              throw err;
            });
          modelLoads.set(cacheKey, promise);
          return promise;
        }

        function makeHelper(kind) {
          const mat =
            kind === "protected"
              ? matProtected
              : kind === "light"
                ? matLight
                : kind === "loading"
                  ? matLoading
                  : matFallback;
          const mesh = new THREE.Mesh(boxGeo, mat);
          mesh.userData.ownsGeometry = false;
          mesh.userData.ownsMaterial = false;
          mesh.userData.helperKind = kind;
          return mesh;
        }

        function applyFramePlacement(placement) {
          if (!placement) return;
          camera.near = placement.near;
          camera.far = placement.far;
          camera.updateProjectionMatrix();
          camera.position.set(placement.position.x, placement.position.y, placement.position.z);
          orbit.target.set(placement.target.x, placement.target.y, placement.target.z);
          orbit.minDistance = placement.minDistance ?? ORBIT_MIN_DISTANCE_M;
          orbit.maxDistance = ORBIT_MAX_DISTANCE_M;
          orbit.update();
        }

        function frameObject(obj3) {
          if (!obj3) return;
          obj3.updateWorldMatrix(true, true);
          const box = new THREE.Box3().setFromObject(obj3);
          const worldPos = new THREE.Vector3();
          obj3.getWorldPosition(worldPos);
          const empty = !Number.isFinite(box.min.x) || box.isEmpty();
          const placement = computeFrameCameraPlacement(
            empty
              ? null
              : {
                  min: { x: box.min.x, y: box.min.y, z: box.min.z },
                  max: { x: box.max.x, y: box.max.y, z: box.max.z },
                },
            { x: worldPos.x, y: worldPos.y, z: worldPos.z },
          );
          applyFramePlacement(placement);
        }

        function frameSelected(objectId = null, attempt = 0) {
          const objs = propsRef.current.objects || [];
          const id =
            objectId ||
            objs[propsRef.current.selectedIndex]?.objectId ||
            null;
          if (!id) return false;
          const node = nodeByObjectId.get(id);
          if (!node) {
            // Hierarchy may still be syncing after a draft refresh.
            if (attempt < 12) {
              requestAnimationFrame(() => frameSelected(id, attempt + 1));
            }
            return false;
          }
          frameObject(node);
          return true;
        }

        function frameAll() {
          const box = new THREE.Box3();
          let any = false;
          for (const node of nodeByObjectId.values()) {
            if (!node.visible) continue;
            box.expandByObject(node);
            any = true;
          }
          if (!any || !Number.isFinite(box.min.x) || box.isEmpty()) {
            applyFramePlacement(
              computeFrameCameraPlacement(null, { x: 0, y: 0.5, z: 0 }, { minStandOff: 6 }),
            );
            return;
          }
          applyFramePlacement(
            computeFrameCameraPlacement({
              min: { x: box.min.x, y: box.min.y, z: box.min.z },
              max: { x: box.max.x, y: box.max.y, z: box.max.z },
            }),
          );
        }

        function applyViewPreset(name) {
          const t = orbit.target.clone();
          const dist = camera.position.distanceTo(t) || 8;
          const map = {
            front: new THREE.Vector3(0, 0, dist),
            back: new THREE.Vector3(0, 0, -dist),
            right: new THREE.Vector3(dist, 0, 0),
            left: new THREE.Vector3(-dist, 0, 0),
            top: new THREE.Vector3(0, dist, 0.001),
            bottom: new THREE.Vector3(0, -dist, 0.001),
          };
          const offset = map[name];
          if (!offset) return;
          camera.position.copy(t).add(offset);
          camera.up.set(0, 1, 0);
          orbit.update();
        }

        function detachAll() {
          for (const [objectId, node] of nodeByObjectId) {
            if (transform.object === node) transform.detach();
            if (node.parent) node.parent.remove(node);
            if (node.userData.cacheKey) releaseCachedModel(node.userData.cacheKey);
            else disposeExclusiveTree(node);
            nodeByObjectId.delete(objectId);
          }
          while (hierarchyRoot.children.length) hierarchyRoot.remove(hierarchyRoot.children[0]);
        }

        function clearVisualChildren(node) {
          const keep = [];
          for (const child of [...node.children]) {
            if (child.userData?.hierarchyChild) continue;
            node.remove(child);
            if (child.userData?.cacheKey) releaseCachedModel(child.userData.cacheKey);
            else disposeExclusiveTree(child);
          }
          return keep;
        }

        async function attachGeometry(node, obj, desc, kind, gen, list) {
          const wantCatalog = shouldLoadModelForObject(obj, list) && desc?.supported && desc?.modelUrl;
          const wantNative = shouldLoadNativeMeshForObject(obj, desc);
          const isHmsh =
            wantNative &&
            (desc?.format === "hmsh1" ||
              desc?.format === "hmsh2" ||
              String(desc?.modelUrl || "").toLowerCase().endsWith(".hmsh"));

          if (wantCatalog || wantNative) {
            if (node.userData.geometryAttached && node.userData.geometryUrl === desc.modelUrl) {
              return { rendered: true, native: Boolean(wantNative) };
            }
            clearVisualChildren(node);
            const loading = makeHelper("loading");
            node.add(loading);
            liveStats.modelsLoading += 1;
            publishStats();
            const cacheKey = wantCatalog ? `catalog:${obj.assetId}` : `native:${desc.modelUrl}`;
            const draftAtStart = propsRef.current.draftId;
            try {
              let visual = null;
              if (isHmsh) {
                const parsed = await loadHmshGeometry(desc.modelUrl, THREE);
                const geometry = parsed.geometry || parsed;
                let mats = Array.isArray(parsed.materials) ? parsed.materials : null;
                if (!mats || mats.length === 0) {
                  const bc = desc.baseColor || {};
                  mats = [
                    new THREE.MeshStandardMaterial({
                      color: new THREE.Color(bc.r ?? 0.75, bc.g ?? 0.75, bc.b ?? 0.75),
                      roughness: 0.7,
                      metalness: 0.05,
                      transparent: (bc.a ?? 1) < 0.999,
                      opacity: bc.a ?? 1,
                      side: THREE.DoubleSide,
                    }),
                  ];
                }
                // Manifest material slots fill gaps when binary has fewer colors than submeshes.
                if (Array.isArray(desc.materials) && desc.materials.length > mats.length) {
                  for (let mi = mats.length; mi < desc.materials.length; mi += 1) {
                    const bc = desc.materials[mi] || {};
                    mats.push(
                      new THREE.MeshStandardMaterial({
                        color: new THREE.Color(bc.r ?? 0.75, bc.g ?? 0.75, bc.b ?? 0.75),
                        roughness: 0.7,
                        metalness: 0.05,
                        transparent: (bc.a ?? 1) < 0.999,
                        opacity: bc.a ?? 1,
                        side: THREE.DoubleSide,
                      }),
                    );
                  }
                }
                const mesh = new THREE.Mesh(geometry, mats.length === 1 ? mats[0] : mats);
                mesh.userData.ownsGeometry = true;
                mesh.userData.ownsMaterial = true;
                mesh.userData.objectId = obj.objectId;
                visual = mesh;
              } else {
                const source = await loadCachedModel(
                  cacheKey,
                  desc.modelUrl,
                  wantCatalog ? obj.assetId : null,
                );
                visual = skeletonClone(source);
                visual.traverse((c) => {
                  c.userData.objectId = obj.objectId;
                  c.userData.rootObjectId = obj.rootObjectId || obj.objectId;
                });
                node.userData.cacheKey = cacheKey;
                node.userData.isModelInstance = true;
              }
              liveStats.modelsLoading = Math.max(0, liveStats.modelsLoading - 1);
              if (
                cancelled ||
                gen !== loadGenRef.current ||
                propsRef.current.draftId !== draftAtStart ||
                propsRef.current.draftId !== node.userData.draftId
              ) {
                if (node.userData.cacheKey) releaseCachedModel(node.userData.cacheKey);
                else if (visual) disposeExclusiveTree(visual);
                publishStats();
                return { rendered: false };
              }
              const live = propsRef.current.objects?.find((o) => o?.objectId === obj.objectId);
              if (!live || live.removed) {
                if (node.userData.cacheKey) releaseCachedModel(node.userData.cacheKey);
                else if (visual) disposeExclusiveTree(visual);
                publishStats();
                return { rendered: false };
              }
              clearVisualChildren(node);
              node.add(visual);
              node.userData.geometryAttached = true;
              node.userData.geometryUrl = desc.modelUrl;
              if (wantCatalog) {
                liveStats.modelsRendered += 1;
              } else {
                liveStats.nativeMeshesRendered += 1;
              }
              publishStats();
              return { rendered: true, native: Boolean(wantNative) };
            } catch (err) {
              liveStats.modelsLoading = Math.max(0, liveStats.modelsLoading - 1);
              liveStats.failed += 1;
              liveStats.lastModelError = `${obj.name || obj.objectId}: ${err.message || "load failed"}`;
              clearVisualChildren(node);
              node.add(makeHelper("unsupported"));
              node.userData.geometryAttached = false;
              node.userData.loadError = liveStats.lastModelError;
              publishStats();
              return { rendered: false, failed: true };
            }
          }

          if (kind === "mesh_child") {
            clearVisualChildren(node);
            return { rendered: false };
          }

          if (kind === "empty") {
            clearVisualChildren(node);
            return { rendered: false };
          }

          if (!node.userData.geometryAttached) {
            clearVisualChildren(node);
            if (kind === "protected" || kind === "light" || kind === "unsupported") {
              node.add(makeHelper(kind === "protected" ? "protected" : kind === "light" ? "light" : "unsupported"));
              if (kind === "protected") liveStats.protectedHelpers += 1;
              else liveStats.fallbacks += 1;
            }
          }
          publishStats();
          return { rendered: false };
        }

        async function syncFromProps() {
          const p = propsRef.current;
          const gen = ++loadGenRef.current;
          const list = p.objects || [];
          const plan = buildHierarchyPlan(list);

          liveStats = emptyRenderStats();
          liveStats.modelRootsDiscovered = selectVisualRoots(list).length;

          // Remove stale nodes
          for (const [objectId, node] of [...nodeByObjectId.entries()]) {
            if (!plan.byId.has(objectId) || p.draftId !== node.userData.draftId) {
              if (transform.object === node) transform.detach();
              if (node.parent) node.parent.remove(node);
              if (node.userData.cacheKey) releaseCachedModel(node.userData.cacheKey);
              else disposeExclusiveTree(node);
              nodeByObjectId.delete(objectId);
            }
          }

          // Ensure node per object
          for (const obj of list) {
            if (!obj?.objectId) continue;
            let node = nodeByObjectId.get(obj.objectId);
            if (!node) {
              node = new THREE.Group();
              node.name = obj.name || obj.objectId;
              node.userData.objectId = obj.objectId;
              nodeByObjectId.set(obj.objectId, node);
            }
            node.userData.objectId = obj.objectId;
            node.userData.draftIndex = list.indexOf(obj);
            node.userData.protected = isProtectedDraftObject(obj) || obj.renderCategory === "xr_protected";
            node.userData.draftId = p.draftId;
            node.userData.renderRole = obj.renderRole;
            node.userData.renderCategory = obj.renderCategory;
            node.visible = obj.active !== false;
          }

          // Parent under hierarchy (local transforms only)
          for (const obj of list) {
            if (!obj?.objectId) continue;
            const node = nodeByObjectId.get(obj.objectId);
            if (!node) continue;
            if (plan.cyclic.has(obj.objectId)) {
              if (node.parent !== hierarchyRoot) hierarchyRoot.add(node);
            } else {
              const parentId = obj.parentObjectId;
              const parentNode =
                parentId && plan.byId.has(parentId) && !plan.cyclic.has(parentId)
                  ? nodeByObjectId.get(parentId)
                  : hierarchyRoot;
              if (node.parent !== parentNode) parentNode.add(node);
              // Mark hierarchy links so clearVisualChildren does not strip real children nodes
              node.userData.hierarchyChild = true;
            }
            const skipTransformWrite =
              holdTransformIds.has(obj.objectId) ||
              (dragging && transform.object === node) ||
              (p.commitsLocked && transform.object === node);
            if (!skipTransformWrite) applyLocalUnityTransform(node, obj);
          }

          const diag = [];
          for (const obj of list) {
            if (!obj?.objectId) continue;
            const node = nodeByObjectId.get(obj.objectId);
            const desc = p.descriptorsByObjectId?.[obj.objectId];
            const kind = fallbackKindForObject(obj, desc);
            node.userData.fallbackKind = kind;
            await attachGeometry(node, obj, desc, kind, gen, list);
            if (cancelled || gen !== loadGenRef.current) return;
            diag.push({
              name: obj.name || "",
              objectId: obj.objectId,
              renderCategory: obj.renderCategory || obj.renderRole || "",
              sourceType: desc?.sourceType || "none",
              loadStatus: node.userData.geometryAttached
                ? "rendered"
                : node.userData.loadError
                  ? "failed"
                  : kind,
              error: node.userData.loadError || desc?.fallbackReason || null,
            });
          }
          setDiagnostics(diag);
          publishStats();

          transform.setMode(p.transformMode || "translate");
          applySnapSettings();
          transform.enabled = !p.commitsLocked;

          const selectedObj = list[p.selectedIndex];
          const selectedId = selectedObj && !selectedObj.removed ? selectedObj.objectId : null;
          const selectedNode = selectedId ? nodeByObjectId.get(selectedId) : null;
          if (selectedNode && !selectedNode.userData.protected && !p.commitsLocked) {
            if (transform.object !== selectedNode) transform.attach(selectedNode);
          } else if (!selectedNode || selectedNode.userData.protected) {
            transform.detach();
          }
        }

        transform.addEventListener("dragging-changed", (event) => {
          const isDragging = Boolean(event.value);
          transformGestureActive = isDragging;
          orbit.enabled = !isDragging;
          if (isDragging && transform.object) {
            dragging = true;
            preDragTransform = {
              position: transform.object.position.clone(),
              rotation: transform.object.rotation.clone(),
              scale: transform.object.scale.clone(),
            };
            return;
          }

          // Drag ended — hold Three TRS across the async draft PUT so sync cannot snap back.
          dragging = false;
          const mesh = transform.object;
          if (!mesh || mesh.userData.protected || propsRef.current.commitsLocked) {
            preDragTransform = null;
            transformGestureActive = false;
            return;
          }
          const objectId = mesh.userData.objectId;
          const commit = propsRef.current.onTransformCommit;
          if (typeof commit !== "function" || !objectId) {
            preDragTransform = null;
            transformGestureActive = false;
            return;
          }

          holdTransformIds.add(objectId);
          const localPosition = threeLocalToUnityPosition(mesh.position);
          const localRotation = threeLocalEulerToUnityDeg(mesh.rotation, THREE);
          const localScale = {
            x: mesh.scale.x,
            y: mesh.scale.y,
            z: mesh.scale.z,
          };
          const worldPos = new THREE.Vector3();
          const worldQuat = new THREE.Quaternion();
          const worldScale = new THREE.Vector3();
          mesh.updateWorldMatrix(true, false);
          mesh.matrixWorld.decompose(worldPos, worldQuat, worldScale);
          const worldEuler = new THREE.Euler().setFromQuaternion(worldQuat, "XYZ");
          const payload = {
            localPosition,
            localRotation,
            localScale,
            position: threeLocalToUnityPosition(worldPos),
            rotation: threeLocalEulerToUnityDeg(worldEuler, THREE),
            scale: { x: worldScale.x, y: worldScale.y, z: worldScale.z },
            space: "local",
          };

          Promise.resolve(commit(objectId, payload))
            .catch(() => {
              if (preDragTransform && mesh) {
                mesh.position.copy(preDragTransform.position);
                mesh.rotation.copy(preDragTransform.rotation);
                mesh.scale.copy(preDragTransform.scale);
              }
            })
            .finally(() => {
              holdTransformIds.delete(objectId);
              preDragTransform = null;
              transformGestureActive = false;
              // Re-sync once from the settled draft (success or rollback).
              apiRef.current?.syncFromProps?.();
            });
        });

        const raycaster = new THREE.Raycaster();
        const pointer = new THREE.Vector2();

        function onPointerDown(event) {
          const intent = unityPointerNavIntent(event, { gizmoDragging: dragging });
          applyUnityNavToOrbit(orbit, THREE, intent);
          if (intent.action !== "select" || propsRef.current.commitsLocked) return;
          const rect = renderer.domElement.getBoundingClientRect();
          pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
          pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
          raycaster.setFromCamera(pointer, camera);
          const targets = [];
          for (const node of nodeByObjectId.values()) {
            if (!node.visible) continue;
            node.traverse((c) => {
              if (c.isMesh && !c.userData?.helperKind) targets.push(c);
              else if (c.isMesh && c.userData?.helperKind) targets.push(c);
            });
          }
          const hits = raycaster.intersectObjects(targets, false);
          if (!hits.length) return;
          const hit = hits[0].object;
          const hitId = hit.userData.objectId || hit.userData.rootObjectId;
          const resolvedId = resolveSelectionObjectId(hitId, propsRef.current.objects || []);
          const index = (propsRef.current.objects || []).findIndex((o) => o && o.objectId === resolvedId);
          if (index >= 0 && typeof propsRef.current.onSelectIndex === "function") {
            propsRef.current.onSelectIndex(index);
          }
        }

        function onPointerMove(event) {
          // Keep Alt+LMB orbit armed while the button is held (Unity Scene view).
          if (event.buttons & 1) {
            const fake = { button: 0, altKey: event.altKey };
            applyUnityNavToOrbit(orbit, THREE, unityPointerNavIntent(fake, { gizmoDragging: dragging }));
          }
        }

        function onPointerUp(event) {
          if (event.button === 0) {
            applyUnityNavToOrbit(orbit, THREE, { action: "select", reason: "lmb" });
          }
        }

        function onContextMenu(event) {
          // Canvas-only: allow RMB orbit without the browser menu (not global).
          event.preventDefault();
        }

        function onKeyDown(event) {
          if (propsRef.current.commitsLocked) return;
          const tag = event.target?.tagName;
          if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
          if (
            document.activeElement !== focusRef.current &&
            document.activeElement !== renderer.domElement &&
            !focusRef.current?.contains(document.activeElement)
          ) {
            return;
          }
          const mode = mapTransformToolKey(event.key);
          if (mode) {
            event.preventDefault();
            propsRef.current.onTransformModeChange?.(mode);
            return;
          }
          if (transformGestureActive || dragging) {
            const axis = mapAxisConstraintKey(event.key, event.shiftKey);
            if (axis) {
              event.preventDefault();
              if (axis.plane) {
                transform.showX = axis.axis !== "x";
                transform.showY = axis.axis !== "y";
                transform.showZ = axis.axis !== "z";
              } else {
                transform.showX = axis.axis === "x";
                transform.showY = axis.axis === "y";
                transform.showZ = axis.axis === "z";
              }
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              if (preDragTransform && transform.object) {
                transform.object.position.copy(preDragTransform.position);
                transform.object.rotation.copy(preDragTransform.rotation);
                transform.object.scale.copy(preDragTransform.scale);
              }
              transform.showX = transform.showY = transform.showZ = true;
              return;
            }
          }
          const preset = viewPresetFromNumpad(event.code, event.ctrlKey || event.metaKey);
          if (preset) {
            event.preventDefault();
            applyViewPreset(preset);
            return;
          }
          if (isFrameSelectedKey(event.code, event.key)) {
            event.preventDefault();
            frameSelected();
            return;
          }
          if (isFrameAllKey(event.code)) {
            event.preventDefault();
            frameAll();
          }
        }

        function onVisibility() {
          paused = document.hidden;
        }

        const ro = new ResizeObserver(() => {
          if (!mount) return;
          const w = mount.clientWidth || width;
          const h = Math.max(360, Math.round(w * 0.55));
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.setSize(Math.min(w, 1400), Math.min(h, 900));
        });
        ro.observe(mount);

        // Capture phase so Alt+LMB orbit mapping is armed before OrbitControls sees the event.
        renderer.domElement.addEventListener("pointerdown", onPointerDown, true);
        renderer.domElement.addEventListener("pointermove", onPointerMove, true);
        renderer.domElement.addEventListener("pointerup", onPointerUp, true);
        renderer.domElement.addEventListener("pointerleave", onPointerUp, true);
        renderer.domElement.addEventListener("contextmenu", onContextMenu);
        focusRef.current?.addEventListener("keydown", onKeyDown);
        document.addEventListener("visibilitychange", onVisibility);

        await syncFromProps();
        frameAll();

        /**
         * Stable Playwright hook: apply a local translation delta and dispatch the same
         * production onTransformCommit path used when a gizmo drag ends.
         * Does not bypass draft PUT — it calls onTransformCommit exactly like a real gesture.
         */
        function commitTestGizmoDelta(objectId, { dx = 0, dy = 0, dz = 0 } = {}) {
          const objs = propsRef.current.objects || [];
          const idx = Number(propsRef.current.selectedIndex) || 0;
          const id = objectId || objs[idx]?.objectId || null;
          const mesh = id ? nodeByObjectId.get(id) : null;
          if (!mesh || mesh.userData.protected) {
            return Promise.reject(new Error("No editable viewport node for gizmo test commit."));
          }
          if (propsRef.current.commitsLocked) {
            return Promise.reject(new Error("Transform commit locked."));
          }
          mesh.position.x += Number(dx) || 0;
          mesh.position.y += Number(dy) || 0;
          mesh.position.z += Number(dz) || 0;
          mesh.updateWorldMatrix(true, false);
          const commit = propsRef.current.onTransformCommit;
          if (typeof commit !== "function") {
            return Promise.reject(new Error("onTransformCommit missing."));
          }
          const localPosition = threeLocalToUnityPosition(mesh.position);
          const localRotation = threeLocalEulerToUnityDeg(mesh.rotation, THREE);
          const localScale = { x: mesh.scale.x, y: mesh.scale.y, z: mesh.scale.z };
          const worldPos = new THREE.Vector3();
          const worldQuat = new THREE.Quaternion();
          const worldScale = new THREE.Vector3();
          mesh.matrixWorld.decompose(worldPos, worldQuat, worldScale);
          const worldEuler = new THREE.Euler().setFromQuaternion(worldQuat, "XYZ");
          const payload = {
            localPosition,
            localRotation,
            localScale,
            position: threeLocalToUnityPosition(worldPos),
            rotation: threeLocalEulerToUnityDeg(worldEuler, THREE),
            scale: { x: worldScale.x, y: worldScale.y, z: worldScale.z },
            space: "local",
          };
          holdTransformIds.add(id);
          return Promise.resolve(commit(id, payload)).finally(() => {
            holdTransformIds.delete(id);
            apiRef.current?.syncFromProps?.();
          });
        }

        const api = {
          syncFromProps,
          frameSelected,
          frameAll,
          commitTestGizmoDelta,
          dispose: () => {
            cancelAnimationFrame(raf);
            document.removeEventListener("visibilitychange", onVisibility);
            focusRef.current?.removeEventListener("keydown", onKeyDown);
            renderer.domElement.removeEventListener("pointerdown", onPointerDown, true);
            renderer.domElement.removeEventListener("pointermove", onPointerMove, true);
            renderer.domElement.removeEventListener("pointerup", onPointerUp, true);
            renderer.domElement.removeEventListener("pointerleave", onPointerUp, true);
            renderer.domElement.removeEventListener("contextmenu", onContextMenu);
            ro.disconnect();
            transform.dispose();
            orbit.dispose();
            detachAll();
            boxGeo.dispose();
            matFallback.dispose();
            matSelected.dispose();
            matProtected.dispose();
            matLight.dispose();
            matLoading.dispose();
            grid.geometry.dispose();
            if (Array.isArray(grid.material)) grid.material.forEach((m) => m.dispose());
            else grid.material.dispose();
            ground.geometry.dispose();
            groundMat.dispose();
            renderer.dispose();
            if (renderer.domElement.parentNode) {
              renderer.domElement.parentNode.removeChild(renderer.domElement);
            }
            propsRef.current.onViewportApi?.(null);
          },
        };
        apiRef.current = api;
        propsRef.current.onViewportApi?.(api);

        const tick = () => {
          raf = requestAnimationFrame(tick);
          if (paused) return;
          orbit.update();
          renderer.render(scene, camera);
        };
        tick();
        if (!cancelled) setReady(true);
      } catch (err) {
        if (!cancelled) setError(err.message || "Viewport failed to load");
      }
    })();

    return () => {
      cancelled = true;
      loadGenRef.current += 1;
      apiRef.current?.dispose?.();
      apiRef.current = null;
    };
  }, []);

  useEffect(() => {
    apiRef.current?.syncFromProps?.();
  }, [
    objects,
    selectedIndex,
    transformMode,
    snapEnabled,
    positionSnap,
    rotationSnapDeg,
    scaleSnap,
    commitsLocked,
    syncToken,
    draftId,
    descriptorsByObjectId,
  ]);

  const catalogRoots = selectVisualRoots(objects);
  const statsLabel = summarizeRenderStats(renderStats).label;

  return (
    <div
      className="space-y-2"
      data-testid="level-editor-viewport"
      ref={focusRef}
      tabIndex={0}
      role="application"
      aria-label="Scene viewport. Press question mark for controls help."
      onKeyDown={(e) => {
        if (e.key === "?" || (e.shiftKey && e.key === "/")) {
          e.preventDefault();
          setShowHelp((v) => !v);
        }
      }}
    >
      <div
        ref={mountRef}
        className="relative min-h-[360px] w-full overflow-hidden rounded-2xl border border-white/10 bg-black/50"
        aria-label="Scene viewport canvas"
      />
      {!ready && !error ? <p className="text-xs text-muted-foreground">Loading scene viewport…</p> : null}
      {error ? <p className="error text-sm">{error}</p> : null}
      {statusLine ? (
        <p className="muted text-xs" data-testid="viewport-status">
          {statusLine}
        </p>
      ) : null}
      {renderStats.lastModelError ? (
        <p className="text-xs text-amber-200/90" data-testid="viewport-last-error">
          Last model error: {renderStats.lastModelError}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground" data-testid="viewport-legend">
        <span data-testid="viewport-stat-discovered">Model roots discovered: {renderStats.modelRootsDiscovered}</span>
        <span data-testid="viewport-stat-loading">Loading: {renderStats.modelsLoading}</span>
        <span data-testid="viewport-stat-catalog">Catalog rendered: {renderStats.modelsRendered}</span>
        <span data-testid="viewport-stat-native">Native meshes: {renderStats.nativeMeshesRendered}</span>
        <span data-testid="viewport-stat-fallback">Fallbacks: {renderStats.fallbacks}</span>
        <span data-testid="viewport-stat-failed">Failed: {renderStats.failed}</span>
        <span data-testid="viewport-stat-protected">Protected helpers: {renderStats.protectedHelpers}</span>
        <span className="opacity-70">Catalog roots in draft: {catalogRoots.length}</span>
      </div>
      <button
        type="button"
        className="text-xs text-muted-foreground underline"
        data-testid="viewport-diagnostics-toggle"
        onClick={() => setShowDiagnostics((v) => !v)}
      >
        {showDiagnostics ? "Hide" : "Show"} diagnostics ({diagnostics.length})
      </button>
      {showDiagnostics ? (
        <div
          className="max-h-48 overflow-auto rounded-xl border border-white/10 bg-black/40 p-2 text-xs"
          data-testid="viewport-diagnostics"
        >
          <table className="w-full text-left">
            <thead>
              <tr>
                <th>Name</th>
                <th>Category</th>
                <th>Source</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {diagnostics.slice(0, 200).map((row) => (
                <tr key={row.objectId}>
                  <td>{row.name}</td>
                  <td>{row.renderCategory}</td>
                  <td>{row.sourceType}</td>
                  <td title={row.error || ""}>{row.loadStatus}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {showHelp ? (
        <pre
          className="whitespace-pre-wrap rounded-xl border border-white/10 bg-black/40 p-3 text-xs"
          data-testid="viewport-help"
        >
          {controlHelpText()}
        </pre>
      ) : (
        <p className="muted text-xs">
          Faithful static Unity preview (meshes/materials/hierarchy). Not pixel-perfect URP/post/XR runtime. Focus
          viewport, press ? for Unity-style controls. {statsLabel}
        </p>
      )}
    </div>
  );
}
