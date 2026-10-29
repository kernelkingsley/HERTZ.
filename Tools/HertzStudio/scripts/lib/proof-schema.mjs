/**
 * Fail-closed proof artifact schema for W03 runners.
 * Every claimed field must be produced by a named check.
 * A check with actual/expected "skipped" must never pass.
 */
export const PROOF_SCHEMA_VERSION = 2;

export const REQUIRED_CHECK_FIELDS = Object.freeze(["name", "pass", "actual", "expected"]);

function isSkippedValue(value) {
  if (value === "skipped") return true;
  if (value && typeof value === "object") {
    if (value.actual === "skipped" || value.status === "skipped") return true;
  }
  return false;
}

export function createProofBuilder({
  proof,
  runner,
  runnerVersion = "1",
  command,
  scenePath = null,
}) {
  const checks = [];
  const startedAt = new Date().toISOString();
  return {
    record(name, pass, { actual = null, expected = null, detail = "" } = {}) {
      const skipped = isSkippedValue(actual) || isSkippedValue(expected);
      const finalPass = Boolean(pass) && !skipped;
      checks.push({
        name,
        pass: finalPass,
        actual,
        expected,
        detail: skipped
          ? `${detail || ""} [fail-closed: skipped cannot pass]`.trim()
          : String(detail || ""),
      });
      const mark = finalPass ? "✓" : "✗";
      console.log(`${mark} ${name}: ${detail || JSON.stringify({ actual, expected })}`);
      return finalPass;
    },
    require(name) {
      if (!checks.some((c) => c.name === name)) {
        checks.push({
          name,
          pass: false,
          actual: null,
          expected: "present",
          detail: "Required check missing from runner output.",
        });
      }
    },
    setScenePath(next) {
      // mutate closed-over scenePath via rebuild — store on builder
      this._scenePath = next;
    },
    build(extra = {}) {
      const requiredNames = Array.isArray(extra.requiredChecks) ? extra.requiredChecks : [];
      for (const name of requiredNames) {
        if (!checks.some((c) => c.name === name)) {
          checks.push({
            name,
            pass: false,
            actual: null,
            expected: "present",
            detail: "Required check missing from runner output.",
          });
        }
      }
      // Fail any skipped that slipped through
      for (const c of checks) {
        if (c.pass && (isSkippedValue(c.actual) || isSkippedValue(c.expected))) {
          c.pass = false;
          c.detail = `${c.detail || ""} [fail-closed: skipped cannot pass]`.trim();
        }
      }
      const passed = checks.filter((c) => c.pass).length;
      const ok = checks.length > 0 && checks.every((c) => c.pass);
      const scene = extra.scenePath ?? this._scenePath ?? scenePath;
      return {
        schemaVersion: PROOF_SCHEMA_VERSION,
        proof,
        runner,
        runnerVersion,
        command,
        stampedAt: new Date().toISOString(),
        startedAt,
        scenePath: scene,
        checks,
        passed,
        total: checks.length,
        ok,
        ...sanitizeExtra(extra),
      };
    },
  };
}

function sanitizeExtra(extra) {
  const out = { ...extra };
  delete out.requiredChecks;
  delete out.ok;
  delete out.passed;
  delete out.total;
  delete out.checks;
  return out;
}

/** Max age for proof artifacts accepted by the aggregator (6 hours). */
export const MAX_PROOF_AGE_MS = 6 * 60 * 60 * 1000;

export function assertProofSchema(artifact, requiredChecks = [], { maxAgeMs = MAX_PROOF_AGE_MS } = {}) {
  const errors = [];
  if (!artifact || typeof artifact !== "object") return ["artifact missing"];
  if (artifact.schemaVersion !== PROOF_SCHEMA_VERSION) {
    errors.push(`schemaVersion mismatch (got ${artifact.schemaVersion}, want ${PROOF_SCHEMA_VERSION})`);
  }
  if (!artifact.runner) errors.push("runner missing");
  if (!artifact.command) errors.push("command missing");
  if (!artifact.stampedAt) errors.push("stampedAt missing");
  else {
    const stamped = Date.parse(artifact.stampedAt);
    if (!Number.isFinite(stamped)) errors.push("stampedAt invalid");
    else if (Date.now() - stamped > maxAgeMs) errors.push("artifact stale");
  }
  if (!Array.isArray(artifact.checks)) errors.push("checks missing");
  else {
    for (const check of artifact.checks) {
      for (const field of REQUIRED_CHECK_FIELDS) {
        if (!(field in check)) errors.push(`check ${check?.name || "?"} missing ${field}`);
      }
      if (check.pass && (isSkippedValue(check.actual) || isSkippedValue(check.expected))) {
        errors.push(`check ${check.name} passed with skipped actual/expected`);
      }
    }
    for (const name of requiredChecks) {
      if (!artifact.checks.some((c) => c.name === name)) errors.push(`required check missing: ${name}`);
    }
    const derivedOk = artifact.checks.length > 0 && artifact.checks.every((c) => c.pass);
    if (Boolean(artifact.ok) !== derivedOk) errors.push("ok does not match checks");
  }
  return errors;
}
