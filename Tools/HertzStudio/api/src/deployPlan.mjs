/**
 * W14 owner-only deploy planning — honest credential storage, no public mutation.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadStore, saveStore } from "./store.mjs";

const PRODUCTION_URL = "https://studio.hertz.software";
const DOMAIN = "hertz.software";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUDIO_ROOT = path.resolve(HERE, "../..");

function ensure(store) {
  if (!store.deploy) {
    store.deploy = {
      plans: [],
      credentialStatus: { host: "unset", dns: "unset" },
      hostProvider: null,
    };
  }
  if (!store.deploy.credentialStatus) {
    store.deploy.credentialStatus = { host: "unset", dns: "unset" };
  }
  return store;
}

function winCredRead(targetName) {
  // Read-only existence check via cmdkey — never print secret values.
  const r = spawnSync("cmdkey", ["/list", targetName], { encoding: "utf8", windowsHide: true });
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;
  if (r.error) return { ok: false, reason: "cmdkey_unavailable" };
  if (/currently stored credentials|Target:/i.test(out) && out.toLowerCase().includes(targetName.toLowerCase())) {
    return { ok: true };
  }
  // cmdkey /list without match still exits 0 with a header — treat missing target as unset.
  if (/Target:\s*.+/i.test(out) && out.toLowerCase().includes(String(targetName).toLowerCase())) {
    return { ok: true };
  }
  return { ok: false, reason: "not_found" };
}

function winCredStore(targetName, username, secret) {
  // cmdkey /generic:name /user:u /pass:p
  const r = spawnSync(
    "cmdkey",
    [`/generic:${targetName}`, `/user:${username}`, `/pass:${secret}`],
    { encoding: "utf8", windowsHide: true },
  );
  if (r.status !== 0) {
    return { ok: false, error: (r.stderr || r.stdout || "cmdkey failed").slice(0, 200) };
  }
  return { ok: true };
}

export function getDeployOverview() {
  const store = ensure(loadStore());
  const providerSelected = Boolean(store.deploy.hostProvider && store.deploy.hostProvider !== "not selected");
  return {
    productionUrl: PRODUCTION_URL,
    domain: DOMAIN,
    registrar: "Name.com",
    hostProvider: store.deploy.hostProvider || "not selected",
    providerSelectionRequired: !providerSelected,
    credentialStatus: {
      host: store.deploy.credentialStatus?.host || "unset",
      dns: store.deploy.credentialStatus?.dns || "unset",
      note: "Values live only in OS credential store when deposited. Never returned by API. deposited_masked requires a real store success.",
    },
    checklist: [
      "Select host provider (or leave pending)",
      "Deposit host + Name.com credentials via masked form into Windows Credential Manager",
      "Build only Studio web/API artifacts and record hash",
      "Review concrete DNS/cost plan — no auto-provision",
      "Post-release HTTPS/auth/API checks from a second device (pending)",
    ],
    note: "No public deployment, DNS mutation, or paid provisioning without Kingsley approving a concrete plan.",
    pendingExternal: [
      "provider account access",
      "credit verification",
      "public deployment",
      "DNS application",
      "HTTPS",
      "hosted authentication",
      "second-device access",
    ],
  };
}

const ALLOWED_PROVIDERS = new Set([
  // Explicit allow-list only — arbitrary strings are not deployable adapters.
  "pending_selection",
]);

export function selectDeployProvider({ hostProvider } = {}) {
  const store = ensure(loadStore());
  const name = String(hostProvider || "").trim().slice(0, 80);
  if (!name) {
    const err = new Error("hostProvider required.");
    err.code = "provider_not_selected";
    throw err;
  }
  if (!ALLOWED_PROVIDERS.has(name) && name !== "candidate-review-only") {
    const err = new Error(
      `Provider '${name}' is not a configured deployable adapter. Report provider_not_selected until Kingsley chooses an approved provider.`,
    );
    err.code = "provider_not_selected";
    throw err;
  }
  // candidate-review-only allows plan preview without claiming a live adapter.
  store.deploy.hostProvider = name === "pending_selection" ? null : name;
  store.deploy.providerSelectionRequired = !store.deploy.hostProvider || store.deploy.hostProvider === "candidate-review-only";
  saveStore(store);
  return {
    ok: true,
    hostProvider: store.deploy.hostProvider,
    providerSelectionRequired: store.deploy.providerSelectionRequired,
    deployableAdapter: false,
    note: "No live provider adapter is configured. Preview/planning only.",
  };
}

/**
 * Deposit a real credential into Windows Credential Manager.
 * Never writes the secret into store.json or API responses.
 */
export function depositCredential({ kind, username, secret } = {}) {
  const store = ensure(loadStore());
  if (kind !== "host" && kind !== "dns") {
    const err = new Error("kind must be host or dns.");
    err.code = "invalid_request";
    throw err;
  }
  if (!secret || typeof secret !== "string" || secret.length < 8) {
    const err = new Error("A real credential secret must be submitted to the trusted local backend.");
    err.code = "secret_required";
    throw err;
  }
  if (!store.deploy.hostProvider && kind === "host") {
    // Allow deposit before provider selection, but status stays honest.
  }
  const target =
    kind === "host" ? "HertzStudio/Deploy/Host" : "HertzStudio/Deploy/NameCom";
  const user = String(username || kind).slice(0, 128);
  const stored = winCredStore(target, user, secret);
  // Best-effort discard from local refs (GC).
  secret = null;
  if (!stored.ok) {
    const err = new Error(`OS credential store failed: ${stored.error || "unknown"}`);
    err.code = "credential_store_failed";
    throw err;
  }
  const verified = winCredRead(target);
  store.deploy.credentialStatus = {
    ...(store.deploy.credentialStatus || {}),
    [kind]: verified.ok ? "deposited_masked" : "store_write_unverified",
    updatedAt: new Date().toISOString(),
    store: "windows_credential_manager",
    target,
  };
  saveStore(store);
  return {
    ok: true,
    kind,
    status: store.deploy.credentialStatus[kind],
    note: "Secret value not returned. Read-only account validation remains pending until provider APIs are configured.",
  };
}

/** @deprecated Removed misleading no-secret acknowledgement. */
export function acknowledgeCredentialDeposit(body = {}) {
  if (body.secret || body.password || body.token || body.apiKey) {
    return depositCredential({
      kind: body.kind,
      username: body.username,
      secret: body.secret || body.password || body.token || body.apiKey,
    });
  }
  const err = new Error(
    "Acknowledge-without-secret is removed. Submit a real credential to deposit into the OS credential store.",
  );
  err.code = "secret_required";
  throw err;
}

export function buildStudioArtifactHash() {
  // Hash production web dist index + package version as a reviewable artifact identity.
  const distIndex = path.join(STUDIO_ROOT, "web", "dist", "index.html");
  if (!fs.existsSync(distIndex)) {
    const err = new Error("Run production build before hashing artifacts (web/dist missing).");
    err.code = "artifact_missing";
    throw err;
  }
  const h = createHash("sha256");
  h.update(fs.readFileSync(distIndex));
  const assetsDir = path.join(STUDIO_ROOT, "web", "dist", "assets");
  if (fs.existsSync(assetsDir)) {
    for (const name of fs.readdirSync(assetsDir).sort()) {
      h.update(name);
      h.update(fs.readFileSync(path.join(assetsDir, name)));
    }
  }
  // Packaging exclusion note — Unity Library/Temp must never be included (verified by path absence).
  const exclusions = {
    unityLibraryExcluded: !fs.existsSync(path.join(STUDIO_ROOT, "../../Library")),
    note: "Studio artifact hash covers web/dist only; Unity source/Library/Temp are out of package scope.",
  };
  return { artifactHash: h.digest("hex"), exclusions };
}

export function createDeployPlan(body = {}) {
  const store = ensure(loadStore());
  if (!store.deploy.hostProvider || store.deploy.hostProvider === "not selected") {
    const err = new Error("Provider not selected. Cannot build a concrete deploy plan.");
    err.code = "provider_not_selected";
    throw err;
  }
  let artifactHash = String(body.artifactHash || "").trim();
  if (!artifactHash) {
    artifactHash = buildStudioArtifactHash().artifactHash;
  }
  if (!/^[a-f0-9]{64}$/i.test(artifactHash)) {
    const err = new Error("artifactHash must be a 64-char hex SHA-256 of the Studio build.");
    err.code = "invalid_artifact";
    throw err;
  }

  const dnsDiff =
    store.deploy.credentialStatus?.dns === "deposited_masked"
      ? {
          status: "pending_readonly_lookup",
          note: "Name.com read-only lookup runs when API access succeeds; until then show manual records.",
          additions: [
            { type: "CNAME", host: "studio", value: "<host-provider-target>", note: "pending live lookup" },
          ],
          changes: [],
          preserved: ["root domain records", "unrelated subdomains"],
        }
      : {
          status: "credentials_required",
          additions: [
            { type: "CNAME", host: "studio", value: "<host-provider-target>", note: "manual until DNS credential deposited" },
          ],
          changes: [],
          preserved: ["root domain records", "unrelated subdomains"],
        };

  const planBody = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    productionUrl: PRODUCTION_URL,
    hostname: "studio.hertz.software",
    hostProvider: store.deploy.hostProvider,
    artifactHash,
    artifactVersion: body.artifactVersion || null,
    region: body.region || null,
    resources: body.resources || null,
    dnsDiff,
    estimatedCharges: {
      amount: null,
      currency: null,
      honesty: "Unknown until provider credentials validate read-only quotas.",
    },
    spendingStop: "enforced_manual_approval_required",
    rollbackPlan: "Redeploy prior artifact hash; DNS revert only with explicit Kingsley approval.",
    status: "preview_only",
    stages: [
      "build_test_artifacts",
      "package_exclusions_verified",
      "review_plan",
      "await_kingsley_approval",
      "provision_idempotent",
      "post_release_checks",
    ],
  };
  planBody.planHash = createHash("sha256").update(stableStringify(planBody), "utf8").digest("hex");
  store.deploy.plans.unshift({
    id: planBody.id,
    planHash: planBody.planHash,
    createdAt: planBody.createdAt,
    artifactHash,
    body: planBody,
  });
  store.deploy.plans = store.deploy.plans.slice(0, 50);
  saveStore(store);
  return planBody;
}

function stableStringify(obj) {
  const { planHash: _ph, ...rest } = obj;
  return JSON.stringify(rest);
}

export function validateDeployPlanTamper({ planId, planHash, planBody } = {}) {
  const store = ensure(loadStore());
  const remembered = store.deploy.plans.find((p) => p.id === planId);
  if (!remembered) {
    const err = new Error("Unknown deploy plan id.");
    err.code = "unknown_plan";
    throw err;
  }
  if (remembered.planHash !== planHash) {
    const err = new Error("Deploy plan hash mismatch — refusing execution.");
    err.code = "plan_tamper";
    throw err;
  }
  if (remembered.body) {
    const recomputed = createHash("sha256").update(stableStringify(remembered.body), "utf8").digest("hex");
    if (recomputed !== remembered.planHash) {
      const err = new Error("Stored plan body no longer matches planHash.");
      err.code = "plan_tamper";
      throw err;
    }
    if (planBody && typeof planBody === "object") {
      const submitted = createHash("sha256").update(stableStringify({ ...planBody, id: planId }), "utf8").digest("hex");
      // Compare field-level: reject if caller sends altered body claiming same id.
      const keys = ["hostname", "artifactHash", "hostProvider", "productionUrl"];
      for (const k of keys) {
        if (planBody[k] != null && remembered.body[k] != null && planBody[k] !== remembered.body[k]) {
          const err = new Error(`Plan field '${k}' changed since review.`);
          err.code = "plan_field_changed";
          throw err;
        }
      }
      void submitted;
    }
  }
  return { ok: true, planId, status: "hash_matches_preview_only_no_execute" };
}
