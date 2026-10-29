import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cleanupE2eWeaponById,
  combineE2eAndCleanupErrors,
  decideCleanupPath,
  isE2eWeaponName,
  makeE2eWeaponName,
} from "./weapon-e2e-cleanup.mjs";

function mockApi(handlers) {
  const calls = [];
  const apiFetch = async (path, opts = {}) => {
    calls.push({ path, method: (opts.method || "GET").toUpperCase(), body: opts.body || null });
    for (const h of handlers) {
      if (h.match(path, opts)) {
        const out = typeof h.respond === "function" ? h.respond(path, opts, calls) : h.respond;
        return {
          status: out.status ?? 200,
          ok: (out.status ?? 200) >= 200 && (out.status ?? 200) < 300,
          json: async () => out.json ?? {},
        };
      }
    }
    return { status: 500, ok: false, json: async () => ({ error: `unhandled ${path}` }) };
  };
  return { apiFetch, calls };
}

describe("weapon-e2e-cleanup helpers", () => {
  it("names are unique and prefix-matched", () => {
    assert.equal(makeE2eWeaponName("abc"), "E2E Left Pistol abc");
    assert.equal(isE2eWeaponName("E2E Left Pistol"), true);
    assert.equal(isE2eWeaponName("E2E Left Pistol abc"), true);
    assert.equal(isE2eWeaponName("Left Pistol"), false);
  });

  it("cleanup never selects by display name (decision uses weapon + deps only)", () => {
    const path = decideCleanupPath({
      weapon: { id: "w1", displayName: "ignored", unitySync: { state: "disconnected" } },
      dependencies: [],
    });
    assert.equal(path, "direct_delete");
  });

  it("unsynchronized/disconnected → direct catalog deletion", () => {
    assert.equal(
      decideCleanupPath({
        weapon: { id: "w1", unitySync: { state: "disconnected" } },
        dependencies: [],
      }),
      "direct_delete",
    );
  });

  it("failed sync with no mapping → direct deletion", () => {
    assert.equal(
      decideCleanupPath({
        weapon: { id: "w1", unitySync: { state: "failed" } },
        dependencies: [],
      }),
      "direct_delete",
    );
  });

  it("applied with mapping → unity delete then catalog", () => {
    assert.equal(
      decideCleanupPath({
        weapon: {
          id: "w1",
          unitySync: { state: "applied", assetGuid: "g", assetPath: "Assets/x.asset" },
        },
        dependencies: [{ kind: "unity_mapping" }],
      }),
      "unity_delete_then_catalog",
    );
  });

  it("pending/applying jobs → wait", () => {
    assert.equal(
      decideCleanupPath({
        weapon: { id: "w1", unitySync: { state: "queued" } },
        dependencies: [{ kind: "sync_job" }],
      }),
      "wait_jobs",
    );
  });

  it("already-deleted entry is already_gone", () => {
    assert.equal(decideCleanupPath({ weapon: null }), "already_gone");
  });
});

describe("cleanupE2eWeaponById", () => {
  it("idempotent success when already deleted", async () => {
    const { apiFetch, calls } = mockApi([
      {
        match: (p) => p === "/api/weapons/w-gone",
        respond: { status: 404, json: { error: "not found" } },
      },
      {
        match: (p) => p === "/api/weapons",
        respond: { status: 200, json: { weapons: [] } },
      },
      {
        match: (p) => p.includes("/dependencies"),
        respond: { status: 404, json: { error: "not found" } },
      },
    ]);
    const result = await cleanupE2eWeaponById({
      weaponId: "w-gone",
      apiFetch,
      timeoutMs: 1000,
      pollMs: 10,
    });
    assert.equal(result.ok, true);
    assert.equal(result.proof.catalogGone, true);
    assert.equal(calls.some((c) => c.method === "DELETE"), false);
  });

  it("direct-deletes disconnected weapon", async () => {
    let exists = true;
    const { apiFetch, calls } = mockApi([
      {
        match: (p, o) => p === "/api/weapons/w1" && (o.method || "GET") === "GET",
        respond: () =>
          exists
            ? {
                status: 200,
                json: { id: "w1", unitySync: { state: "disconnected" } },
              }
            : { status: 404, json: { error: "not found" } },
      },
      {
        match: (p) => p.includes("/dependencies"),
        respond: { status: 200, json: { dependencies: [] } },
      },
      {
        match: (p, o) => String(p).startsWith("/api/weapons/w1") && o.method === "DELETE",
        respond: () => {
          exists = false;
          return { status: 200, json: { ok: true, deleted: true } };
        },
      },
      {
        match: (p) => p === "/api/weapons",
        respond: { status: 200, json: { weapons: [] } },
      },
    ]);
    const result = await cleanupE2eWeaponById({
      weaponId: "w1",
      apiFetch,
      timeoutMs: 2000,
      pollMs: 10,
    });
    assert.equal(result.ok, true);
    assert.ok(calls.some((c) => c.method === "DELETE" && String(c.path).includes("unassignLoadout=1")));
    assert.equal(calls.some((c) => String(c.path).includes("retain_unity")), false);
  });

  it("applied entry queues Unity delete then catalog delete", async () => {
    let phase = "mapped";
    let polls = 0;
    const { apiFetch, calls } = mockApi([
      {
        match: (p, o) => p === "/api/weapons/w-applied" && (o.method || "GET") === "GET",
        respond: () => {
          if (phase === "gone") return { status: 404, json: { error: "not found" } };
          if (phase === "unmapped") {
            return {
              status: 200,
              json: {
                id: "w-applied",
                unitySync: { state: "disconnected", deletedInUnity: true },
              },
            };
          }
          return {
            status: 200,
            json: {
              id: "w-applied",
              unitySync: {
                state: "applied",
                assetGuid: "guid-1",
                assetPath: "Assets/HertzStudio/Weapons/Definitions/w-applied.asset",
              },
            },
          };
        },
      },
      {
        match: (p) => p.includes("/dependencies"),
        respond: () => {
          polls += 1;
          if (phase === "gone" || phase === "unmapped") {
            return { status: 200, json: { dependencies: [] } };
          }
          // After enqueue, briefly busy then mapping clears.
          if (phase === "deleting") {
            if (polls > 3) {
              phase = "unmapped";
              return { status: 200, json: { dependencies: [] } };
            }
            return {
              status: 200,
              json: { dependencies: [{ kind: "unity_mapping" }, { kind: "sync_job" }] },
            };
          }
          return {
            status: 200,
            json: { dependencies: [{ kind: "unity_mapping" }] },
          };
        },
      },
      {
        match: (p, o) => p.includes("/unity-delete") && o.method === "POST",
        respond: () => {
          phase = "deleting";
          return { status: 202, json: { requestId: "r1", job: { status: "pending_unity" } } };
        },
      },
      {
        match: (p, o) => String(p).includes("unityResolution=unity_deleted") && o.method === "DELETE",
        respond: () => {
          phase = "gone";
          return { status: 200, json: { ok: true, deleted: true } };
        },
      },
      {
        match: (p) => p === "/api/weapons",
        respond: { status: 200, json: { weapons: [] } },
      },
    ]);
    const resolveUnityAsset = async () => ({ ok: false, exists: false });
    const result = await cleanupE2eWeaponById({
      weaponId: "w-applied",
      apiFetch,
      resolveUnityAsset,
      timeoutMs: 5000,
      pollMs: 10,
    });
    assert.equal(result.ok, true);
    assert.ok(calls.some((c) => c.method === "POST" && String(c.path).includes("unity-delete")));
    assert.ok(calls.some((c) => c.method === "DELETE" && String(c.path).includes("unity_deleted")));
    assert.equal(calls.some((c) => String(c.path).includes("retain_unity")), false);
    assert.equal(result.proof.usedRetainUnity, false);
    assert.equal(result.proof.deletedModelAsset, false);
  });

  it("Unity delete failure fails closed", async () => {
    const { apiFetch } = mockApi([
      {
        match: (p, o) => p === "/api/weapons/w-fail" && (o.method || "GET") === "GET",
        respond: {
          status: 200,
          json: {
            id: "w-fail",
            unitySync: {
              state: "applied",
              assetGuid: "g",
              assetPath: "Assets/HertzStudio/Weapons/Definitions/w-fail.asset",
            },
          },
        },
      },
      {
        match: (p) => p.includes("/dependencies"),
        respond: { status: 200, json: { dependencies: [{ kind: "unity_mapping" }] } },
      },
      {
        match: (p, o) => p.includes("/unity-delete") && o.method === "POST",
        respond: { status: 400, json: { error: "Unity offline", code: "bridge" } },
      },
    ]);
    const result = await cleanupE2eWeaponById({
      weaponId: "w-fail",
      apiFetch,
      timeoutMs: 1000,
      pollMs: 10,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /Unity delete enqueue failed/);
  });

  it("timeout reports remaining dependency kinds", async () => {
    const { apiFetch } = mockApi([
      {
        match: (p) => p === "/api/weapons/w-wait",
        respond: {
          status: 200,
          json: { id: "w-wait", unitySync: { state: "queued" } },
        },
      },
      {
        match: (p) => p.includes("/dependencies"),
        respond: {
          status: 200,
          json: { dependencies: [{ kind: "sync_job" }, { kind: "unity_sync_state" }] },
        },
      },
    ]);
    const result = await cleanupE2eWeaponById({
      weaponId: "w-wait",
      apiFetch,
      timeoutMs: 40,
      pollMs: 10,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /cleanup timeout for w-wait/);
    assert.match(result.error, /sync_job/);
    assert.match(result.error, /unity_sync_state/);
  });

  it("unrelated protected weapon IDs remain untouched", async () => {
    let exists = true;
    const { apiFetch } = mockApi([
      {
        match: (p) => p === "/api/weapons/keep-me",
        respond: {
          status: 200,
          json: { id: "keep-me", displayName: "Real", unitySync: { state: "applied" } },
        },
      },
      {
        match: (p, o) => p === "/api/weapons/w-temp" && (o.method || "GET") === "GET",
        respond: () =>
          exists
            ? { status: 200, json: { id: "w-temp", unitySync: { state: "disconnected" } } }
            : { status: 404, json: { error: "not found" } },
      },
      {
        match: (p) => p.includes("/dependencies"),
        respond: { status: 200, json: { dependencies: [] } },
      },
      {
        match: (p, o) => String(p).startsWith("/api/weapons/w-temp") && o.method === "DELETE",
        respond: () => {
          exists = false;
          return { status: 200, json: { ok: true, deleted: true } };
        },
      },
      {
        match: (p) => p === "/api/weapons",
        respond: {
          status: 200,
          json: { weapons: [{ id: "keep-me", displayName: "Real" }] },
        },
      },
    ]);
    const result = await cleanupE2eWeaponById({
      weaponId: "w-temp",
      apiFetch,
      protectWeaponIds: ["keep-me"],
      timeoutMs: 2000,
      pollMs: 10,
    });
    assert.equal(result.ok, true);
  });

  it("combineE2eAndCleanupErrors reports both", () => {
    assert.equal(combineE2eAndCleanupErrors(null, null), null);
    assert.match(combineE2eAndCleanupErrors("boom", "cleanup boom"), /E2E failed: boom/);
    assert.match(combineE2eAndCleanupErrors("boom", "cleanup boom"), /cleanup failed: cleanup boom/);
  });

  it("cleanup never uses retain_unity and never deletes model assets", async () => {
    let exists = true;
    const { apiFetch, calls } = mockApi([
      {
        match: (p, o) => p === "/api/weapons/w2" && (o.method || "GET") === "GET",
        respond: () =>
          exists
            ? { status: 200, json: { id: "w2", unitySync: { state: "failed" } } }
            : { status: 404, json: { error: "not found" } },
      },
      {
        match: (p) => p.includes("/dependencies"),
        respond: { status: 200, json: { dependencies: [] } },
      },
      {
        match: (p, o) => String(p).startsWith("/api/weapons/w2") && o.method === "DELETE",
        respond: () => {
          exists = false;
          return { status: 200, json: { ok: true, note: "Imported model assets were not deleted." } };
        },
      },
      {
        match: (p) => p === "/api/weapons",
        respond: { status: 200, json: { weapons: [] } },
      },
    ]);
    const result = await cleanupE2eWeaponById({ weaponId: "w2", apiFetch, timeoutMs: 2000, pollMs: 10 });
    assert.equal(result.ok, true);
    assert.equal(result.proof.usedRetainUnity, false);
    assert.equal(result.proof.deletedModelAsset, false);
    assert.equal(
      calls.some(
        (c) =>
          String(c.path).includes("retain_unity") ||
          String(c.path).includes("/api/assets/") && c.method === "DELETE",
      ),
      false,
    );
  });
});
