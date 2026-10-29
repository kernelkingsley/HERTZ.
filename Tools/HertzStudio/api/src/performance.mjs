/**
 * W10 Performance — static Unity inspection + Editor capture + Quest provenance.
 * Browser cannot claim source:"quest_device".
 */
import { createHash, randomUUID } from "node:crypto";
import { loadStore, saveStore } from "./store.mjs";
import { postUnityBridge } from "./unityBridgeClient.mjs";
import { assertDedicatedStudioScene, canonicalizeSceneAssetPath } from "./sceneIdentity.mjs";

const SOURCES = new Set(["static_estimate", "unity_editor", "quest_device", "browser_viewport"]);

function ensure(store) {
  if (!store.performance) store.performance = { captures: [] };
  if (!Array.isArray(store.performance.captures)) store.performance.captures = [];
  return store;
}

function assertFinite(n, label) {
  if (n == null) return null;
  const v = Number(n);
  if (!Number.isFinite(v)) {
    const err = new Error(`${label} must be finite.`);
    err.code = "malformed_capture";
    throw err;
  }
  return v;
}

export async function runStaticProjectInspection(body = {}) {
  const scenePath = body.scenePath ? assertDedicatedStudioScene(body.scenePath) : null;
  const bridge = await postUnityBridge(
    "/performance/inspect-static",
    { scenePath },
    { timeoutMs: 30000 },
  );
  if (!bridge.ok) {
    const err = new Error(bridge.error || "Unity static performance inspect failed.");
    err.code = bridge.status === 0 ? "unity_offline" : "unity_inspect_failed";
    throw err;
  }
  const data = bridge.data || {};
  const capture = {
    id: randomUUID(),
    source: "static_estimate",
    provenance: {
      importer: "unity_bridge",
      schema: "hertz.performance.static.v1",
      captureHash: createHash("sha256").update(JSON.stringify(data)).digest("hex"),
    },
    capturedAt: new Date().toISOString(),
    buildVersion: data.buildVersion || null,
    device: null,
    refreshRateHz: null,
    scenePath: data.scenePath || scenePath,
    sceneGuid: data.sceneGuid || null,
    sceneRevision: data.unityRevision ?? null,
    summary: data.summary || {},
    findings: Array.isArray(data.findings) ? data.findings : [],
    unavailable: Array.isArray(data.unavailable) ? data.unavailable : [],
    label: "Static project estimate (not Quest)",
    createdAt: new Date().toISOString(),
  };
  const store = ensure(loadStore());
  store.performance.captures.unshift(capture);
  store.performance.captures = store.performance.captures.slice(0, 200);
  saveStore(store);
  return capture;
}

export async function ingestEditorCapture(body = {}) {
  const scenePath = body.scenePath ? assertDedicatedStudioScene(body.scenePath) : null;
  const bridge = await postUnityBridge(
    "/performance/editor-capture",
    {
      scenePath,
      durationSeconds: assertFinite(body.durationSeconds, "durationSeconds") ?? 5,
      expectedUnityRevision: body.expectedUnityRevision ?? null,
    },
    { timeoutMs: 60000 },
  );
  if (!bridge.ok) {
    const err = new Error(bridge.error || "Unity Editor capture failed.");
    err.code = bridge.status === 0 ? "unity_offline" : "unity_capture_failed";
    throw err;
  }
  const data = bridge.data || {};
  const capture = {
    id: randomUUID(),
    source: "unity_editor",
    provenance: {
      importer: "unity_bridge",
      schema: "hertz.performance.editor.v1",
      captureHash: data.captureHash || createHash("sha256").update(JSON.stringify(data.summary || {})).digest("hex"),
    },
    capturedAt: data.capturedAt || new Date().toISOString(),
    buildVersion: data.buildVersion || null,
    device: "UnityEditor",
    refreshRateHz: assertFinite(data.refreshRateHz, "refreshRateHz"),
    scenePath: data.scenePath || scenePath,
    sceneGuid: data.sceneGuid || null,
    sceneRevision: data.unityRevision ?? null,
    staleSceneRevision: data.staleSceneRevision === true,
    durationSeconds: data.durationSeconds ?? null,
    sampleCount: data.sampleCount ?? 0,
    summary: data.summary || {},
    unavailable: Array.isArray(data.unavailable) ? data.unavailable : [],
    label: "Unity Editor measurement (not Quest)",
    createdAt: new Date().toISOString(),
  };
  if (capture.refreshRateHz) capture.summary.frameBudgetMs = 1000 / capture.refreshRateHz;
  const store = ensure(loadStore());
  store.performance.captures.unshift(capture);
  store.performance.captures = store.performance.captures.slice(0, 200);
  saveStore(store);
  return capture;
}

/**
 * Quest / browser / generic ingest.
 * quest_device requires connector provenance — never browser-only claim.
 */
export function ingestPerformanceCapture(body = {}) {
  const store = ensure(loadStore());
  const source = String(body.source || "");
  if (!SOURCES.has(source)) {
    const err = new Error(`source must be one of ${[...SOURCES].join(", ")}.`);
    err.code = "invalid_source";
    throw err;
  }

  if (source === "quest_device") {
    const prov = body.provenance || {};
    if (prov.importer !== "quest_device_importer" && prov.importer !== "connector_quest_import") {
      const err = new Error(
        "source quest_device requires provenance.importer from the Quest device importer/connector — browser claims are rejected.",
      );
      err.code = "quest_provenance_required";
      throw err;
    }
    if (!prov.captureHash || !prov.schema || !prov.device || !prov.buildIdentity) {
      const err = new Error("Quest capture provenance incomplete (schema, captureHash, device, buildIdentity).");
      err.code = "quest_provenance_incomplete";
      throw err;
    }
  }

  if (source === "static_estimate" || source === "unity_editor") {
    const err = new Error(
      `Use /api/performance/inspect-static or /api/performance/editor-capture for ${source} — do not post fabricated summaries.`,
    );
    err.code = "use_authoritative_endpoint";
    throw err;
  }

  const samples = Array.isArray(body.samples) ? body.samples : [];
  if (samples.length > 5000) {
    const err = new Error("Sample count exceeds bound (5000).");
    err.code = "payload_too_large";
    throw err;
  }

  let scenePath = null;
  if (body.scenePath) {
    scenePath = canonicalizeSceneAssetPath(body.scenePath);
    if (!scenePath) {
      const err = new Error("Invalid scenePath.");
      err.code = "invalid_scene_path";
      throw err;
    }
  }

  const capture = {
    id: randomUUID(),
    source,
    provenance: body.provenance || {
      importer: source === "browser_viewport" ? "studio_browser" : "unknown",
      schema: source === "browser_viewport" ? "hertz.performance.browser.v1" : "hertz.performance.v1",
    },
    capturedAt: body.capturedAt || new Date().toISOString(),
    buildVersion: body.buildVersion || body.provenance?.buildIdentity || null,
    device: body.device || body.provenance?.device || null,
    refreshRateHz: assertFinite(body.refreshRateHz, "refreshRateHz"),
    scenePath,
    sceneGuid: body.sceneGuid || null,
    sceneRevision: body.sceneRevision ?? null,
    durationSeconds: assertFinite(body.durationSeconds, "durationSeconds"),
    sampleCount: samples.length,
    summary: {
      cpuFrameMs: assertFinite(body.cpuFrameMs, "cpuFrameMs"),
      gpuFrameMs: assertFinite(body.gpuFrameMs, "gpuFrameMs"),
      fps: assertFinite(body.fps, "fps"),
      drawCalls: assertFinite(body.drawCalls, "drawCalls"),
      batches: assertFinite(body.batches, "batches"),
      triangles: assertFinite(body.triangles, "triangles"),
      vertices: assertFinite(body.vertices, "vertices"),
      textureMemoryBytes: assertFinite(body.textureMemoryBytes, "textureMemoryBytes"),
      materialCount: assertFinite(body.materialCount, "materialCount"),
      lightCount: assertFinite(body.lightCount, "lightCount"),
    },
    unavailable: Array.isArray(body.unavailable) ? body.unavailable : [],
    label:
      source === "quest_device"
        ? "Quest device capture"
        : "Browser viewport (not headset)",
    createdAt: new Date().toISOString(),
  };
  if (capture.refreshRateHz) capture.summary.frameBudgetMs = 1000 / capture.refreshRateHz;

  store.performance.captures.unshift(capture);
  store.performance.captures = store.performance.captures.slice(0, 200);
  saveStore(store);
  return capture;
}

export function listPerformanceCaptures({ page = 1, pageSize = 20, source = null } = {}) {
  const store = ensure(loadStore());
  let list = store.performance.captures;
  if (source) list = list.filter((c) => c.source === source);
  const p = Math.max(1, Number(page) || 1);
  const ps = Math.min(100, Math.max(1, Number(pageSize) || 20));
  const start = (p - 1) * ps;
  return {
    total: list.length,
    page: p,
    pageSize: ps,
    captures: list.slice(start, start + ps),
    note: "Never label estimates or Editor results as Quest results. Quest requires device importer provenance.",
  };
}
