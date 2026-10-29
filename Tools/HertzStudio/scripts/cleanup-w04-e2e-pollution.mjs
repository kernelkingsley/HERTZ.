/**
 * One-shot hygiene: remove live W04 browser-E2E catalog pollution by exact IDs.
 * Uses authenticated API → connector → Unity delete flow. Never deletes models.
 *
 * Requires HERTZ_OWNER_PASSWORD. Never logs credentials.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanupE2eWeaponById,
  isE2eWeaponName,
} from "./lib/weapon-e2e-cleanup.mjs";

const PASSWORD = process.env.HERTZ_OWNER_PASSWORD;
const BASE = process.env.HERTZ_STUDIO_URL || "http://127.0.0.1:8787";
const BRIDGE = process.env.HERTZ_UNITY_BRIDGE_URL || "http://127.0.0.1:8791";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const dataDir = path.join(root, "data");
const recoveryDir = path.join(dataDir, "recovery");

const PROTECTED_DEF_NAMES = new Set([
  "W04_Test_LeftPistol",
  "W04_Test_RightPistol",
]);

if (!PASSWORD) {
  console.error("HERTZ_OWNER_PASSWORD is required.");
  process.exit(2);
}

function loadBridgeToken() {
  const cfgPath = path.join(dataDir, "connector-config.json");
  if (!fs.existsSync(cfgPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(cfgPath, "utf8")).bridgeToken || null;
  } catch {
    return null;
  }
}

async function resolveUnityWeapon({ assetGuid, assetPath, weaponId }) {
  const token = loadBridgeToken();
  if (!token) return { ok: false, disconnected: true, error: "no bridge token" };
  try {
    const res = await fetch(`${BRIDGE}/weapons/resolve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hertz-bridge-token": token,
      },
      body: JSON.stringify({ assetGuid, assetPath, weaponId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, exists: data.exists === true, error: data.error || `HTTP ${res.status}` };
    }
    return { ok: true, exists: true, assetType: data.assetType, weaponId: data.weaponId };
  } catch (err) {
    return { ok: false, disconnected: true, error: String(err?.message || err) };
  }
}

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: process.env.HERTZ_OWNER_USERNAME || "kingsley",
      password: PASSWORD,
    }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  const cookie = res.headers.getSetCookie?.()?.[0] || res.headers.get("set-cookie");
  if (!cookie) throw new Error("login missing session cookie");
  return cookie.split(";")[0];
}

function makeApiFetch(cookieHeader) {
  return async (apiPath, opts = {}) => {
    const headers = { ...(opts.headers || {}), cookie: cookieHeader };
    if (opts.body && !headers["content-type"]) headers["content-type"] = "application/json";
    return fetch(`${BASE}${apiPath}`, { ...opts, headers });
  };
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function copyRecovery() {
  fs.mkdirSync(recoveryDir, { recursive: true });
  const t = stamp();
  const storeSrc = path.join(dataDir, "store.json");
  const goodSrc = path.join(dataDir, "store.json.good");
  const storeDst = path.join(recoveryDir, `store-w04-e2e-hygiene-${t}.json`);
  const goodDst = path.join(recoveryDir, `store-w04-e2e-hygiene-${t}.json.good`);
  fs.copyFileSync(storeSrc, storeDst);
  if (fs.existsSync(goodSrc)) fs.copyFileSync(goodSrc, goodDst);
  return { storeDst, goodDst: fs.existsSync(goodDst) ? goodDst : null, stamp: t };
}

function inventoryFromStore() {
  const store = JSON.parse(fs.readFileSync(path.join(dataDir, "store.json"), "utf8"));
  const weapons = Object.values(store.weapons || {});
  const loadout = store.weaponLoadout || {};
  const e2e = weapons.filter(
    (w) => isE2eWeaponName(w.displayName) && w.role === "left_pistol",
  );
  const assigned = e2e.filter(
    (w) => w.id === loadout.leftWeaponId || w.id === loadout.rightWeaponId,
  );
  const jobs = (store.weaponJobs || []).filter((j) => e2e.some((w) => w.id === j.weaponId));
  const activeJobs = jobs.filter((j) =>
    ["pending_unity", "applying", "queued"].includes(j.status),
  );
  return {
    totalWeapons: weapons.length,
    e2eCount: e2e.length,
    loadout: {
      leftWeaponId: loadout.leftWeaponId ?? null,
      rightWeaponId: loadout.rightWeaponId ?? null,
    },
    assignedE2eIds: assigned.map((w) => w.id),
    entries: e2e.map((w) => ({
      id: w.id,
      displayName: w.displayName,
      role: w.role,
      state: w.unitySync?.state || null,
      assetGuid: w.unitySync?.assetGuid || store.weaponMappings?.[w.id]?.assetGuid || null,
      assetPath: w.unitySync?.assetPath || store.weaponMappings?.[w.id]?.assetPath || null,
    })),
    e2eJobCount: jobs.length,
    activeE2eJobCount: activeJobs.length,
    nonE2eCount: weapons.length - e2e.length,
  };
}

async function main() {
  const before = inventoryFromStore();
  if (before.assignedE2eIds.length) {
    throw new Error(`Refusing cleanup: E2E weapons assigned to loadout: ${before.assignedE2eIds.join(",")}`);
  }
  const recovery = copyRecovery();
  console.log(
    JSON.stringify(
      {
        phase: "pre_cleanup",
        recovery: {
          store: path.relative(root, recovery.storeDst).replace(/\\/g, "/"),
          good: recovery.goodDst
            ? path.relative(root, recovery.goodDst).replace(/\\/g, "/")
            : null,
        },
        inventory: before,
      },
      null,
      2,
    ),
  );

  const cookie = await login();
  const apiFetch = makeApiFetch(cookie);
  const results = [];

  for (const entry of before.entries) {
    if (PROTECTED_DEF_NAMES.has(entry.displayName)) {
      throw new Error(`Refusing to touch protected name ${entry.displayName}`);
    }
    const result = await cleanupE2eWeaponById({
      weaponId: entry.id,
      apiFetch,
      resolveUnityAsset: resolveUnityWeapon,
      timeoutMs: 120000,
      pollMs: 1500,
    });
    results.push({
      weaponId: entry.id,
      priorState: entry.state,
      priorPath: entry.assetPath,
      ok: result.ok,
      error: result.error,
      proof: result.proof,
    });
    if (!result.ok) {
      console.error(JSON.stringify({ phase: "cleanup_failed", results }, null, 2));
      process.exit(1);
    }
  }

  const after = inventoryFromStore();
  // Tools/HertzStudio → repo root → Assets/...
  const definitionsDir = path.join(
    path.resolve(root, "../.."),
    "Assets",
    "HertzStudio",
    "Weapons",
    "Definitions",
  );

  const remainingE2eDefFiles = fs.existsSync(definitionsDir)
    ? fs
        .readdirSync(definitionsDir)
        .filter((f) => f.endsWith(".asset") && before.entries.some((e) => f.startsWith(e.id)))
    : [];

  const w04TestLeft = fs.existsSync(path.join(definitionsDir, "W04_Test_LeftPistol.asset"));
  const w04TestRight = fs.existsSync(path.join(definitionsDir, "W04_Test_RightPistol.asset"));

  const summary = {
    phase: "post_cleanup",
    cleanedIds: results.map((r) => r.weaponId),
    cleanedCount: results.length,
    before: {
      catalogE2e: before.e2eCount,
      catalogTotal: before.totalWeapons,
      activeJobs: before.activeE2eJobCount,
      e2eJobs: before.e2eJobCount,
      mapped: before.entries.filter((e) => e.assetGuid).length,
    },
    after: {
      catalogE2e: after.e2eCount,
      catalogTotal: after.totalWeapons,
      activeJobs: after.activeE2eJobCount,
      e2eJobs: after.e2eJobCount,
      loadout: after.loadout,
    },
    unityE2eDefFilesRemaining: remainingE2eDefFiles,
    w04TestDefsPreserved: { left: w04TestLeft, right: w04TestRight },
    recovery: {
      store: path.relative(root, recovery.storeDst).replace(/\\/g, "/"),
      good: recovery.goodDst
        ? path.relative(root, recovery.goodDst).replace(/\\/g, "/")
        : null,
    },
    ok:
      after.e2eCount === 0 &&
      after.activeE2eJobCount === 0 &&
      remainingE2eDefFiles.length === 0 &&
      after.loadout.leftWeaponId === before.loadout.leftWeaponId &&
      after.loadout.rightWeaponId === before.loadout.rightWeaponId,
  };

  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exit(1);
}

main().catch((err) => {
  console.error(String(err?.message || err));
  process.exit(1);
});
