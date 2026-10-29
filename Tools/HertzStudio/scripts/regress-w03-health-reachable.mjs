/**
 * Focused regress: connector must treat deferred/stalled /health as unreachable
 * so queued mutations wait (unityReachable=false).
 */
import { isUnityHealthReachable } from "../connector/src/unityHealth.mjs";

const cases = [
  {
    name: "healthy_200_ok",
    health: { ok: true, status: 200, data: { ok: true, unityRevision: 12, scenePath: "Assets/Scenes/HertzStudioTest.unity" } },
    expect: true,
  },
  {
    name: "main_thread_503",
    health: {
      ok: false,
      status: 503,
      data: {
        ok: false,
        error: "main_thread_unavailable",
        note: "main_thread_deferred",
        unityRevision: -1,
      },
    },
    expect: false,
  },
  {
    name: "legacy_false_ok_200_deferred_body",
    health: {
      ok: true,
      status: 200,
      data: { status: "ok", note: "main_thread_deferred", unityRevision: -1 },
    },
    expect: false,
  },
  {
    name: "http_500",
    health: { ok: false, status: 500, data: { error: "boom" } },
    expect: false,
  },
  {
    name: "fetch_failed_null",
    health: null,
    expect: false,
  },
];

let failed = 0;
const results = [];
for (const c of cases) {
  const actual = isUnityHealthReachable(c.health);
  const pass = actual === c.expect;
  if (!pass) failed += 1;
  results.push({ name: c.name, expect: c.expect, actual, pass });
}

const report = {
  ok: failed === 0,
  checks: results.length,
  failed,
  results,
  note: "503 / deferred health => unityReachable false; mutations stay queued",
};

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
