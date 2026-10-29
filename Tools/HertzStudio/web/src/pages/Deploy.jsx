import { useEffect, useState } from "react";
import { api } from "../api.js";
import { getMilestoneStatus, statusBadgeVariant } from "../lib/milestoneStatus.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * W14 owner-only deploy planning UI.
 * Never executes public deploy/DNS. Credentials are masked; values never returned by API.
 */
export default function Deploy() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [artifactHash, setArtifactHash] = useState("");
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const w14Status = getMilestoneStatus("W14");

  useEffect(() => {
    api("/api/deploy")
      .then(setData)
      .catch((err) => setError(err.message));
  }, []);

  const [secret, setSecret] = useState("");
  const [provider, setProvider] = useState("");

  async function selectProvider() {
    setBusy(true);
    setError("");
    try {
      await api("/api/deploy/provider", {
        method: "POST",
        body: JSON.stringify({ hostProvider: provider }),
      });
      setData(await api("/api/deploy"));
      setMessage(`Provider set to ${provider}`);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function deposit(kind) {
    setBusy(true);
    setError("");
    try {
      await api("/api/deploy/credentials", {
        method: "POST",
        body: JSON.stringify({ kind, username: kind, secret }),
      });
      setSecret("");
      setData(await api("/api/deploy"));
      setMessage(`${kind} deposited into OS credential store (value never returned).`);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function createPlan() {
    setBusy(true);
    setError("");
    try {
      const p = await api("/api/deploy/plan", {
        method: "POST",
        body: JSON.stringify({
          artifactHash,
          artifactVersion: "local-preview",
          region: "pending_selection",
        }),
      });
      setPlan(p);
      setMessage(`Plan ${p.id} preview_only · hash ${p.planHash?.slice(0, 12)}…`);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function validatePlan() {
    if (!plan) return;
    setBusy(true);
    setError("");
    try {
      const r = await api("/api/deploy/plan/validate", {
        method: "POST",
        body: JSON.stringify({ planId: plan.id, planHash: plan.planHash }),
      });
      setMessage(r.status);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function validateTamper() {
    if (!plan) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/deploy/plan/validate", {
        method: "POST",
        body: JSON.stringify({ planId: plan.id, planHash: "0".repeat(64) }),
      });
      setMessage("Unexpected: tamper accepted");
    } catch (e) {
      setError(`Tamper rejected (expected): ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-enter space-y-6">
      <div className="page-head">
        <div>
          <div className="eyebrow mb-3">Ship</div>
          <h1>
            Deploy <span className="font-normal text-muted-foreground">preview only</span>
          </h1>
          <p>
            Owner-only planning for {data?.productionUrl || "https://studio.hertz.software"}. No public deployment,
            DNS mutation, or paid provisioning in this run.
          </p>
        </div>
        <Badge variant={statusBadgeVariant(w14Status)} className="rounded-full border-[var(--glow)]/40 text-[var(--glow)]">
          W14: {w14Status}
        </Badge>
      </div>

      {error ? <p className="error">{error}</p> : null}
      {message ? <p className="muted">{message}</p> : null}

      <Card>
        <CardHeader>
          <CardTitle>Production target</CardTitle>
          <CardDescription className="text-base text-foreground">
            {data?.productionUrl || "https://studio.hertz.software"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="meta">
            <span>Domain {data?.domain || "hertz.software"}</span>
            <span>Registrar {data?.registrar || "Name.com"}</span>
            <span>Host {data?.hostProvider || "not selected"}</span>
          </div>
          <p className="muted text-sm">{data?.note}</p>
          <div className="text-sm">
            Credentials: host={data?.credentialStatus?.host || "unset"} · dns=
            {data?.credentialStatus?.dns || "unset"}
          </div>
          <p className="muted text-xs">{data?.credentialStatus?.note}</p>
          <div className="flex flex-wrap gap-2 items-end">
            <div>
              <Label>Host provider</Label>
              <Input value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="e.g. candidate-adapter" />
            </div>
            <Button type="button" disabled={busy || !provider} onClick={selectProvider}>
              Select provider
            </Button>
          </div>
          <div className="flex flex-wrap gap-2 items-end">
            <div>
              <Label>Credential (masked; OS store only)</Label>
              <Input
                type="password"
                autoComplete="off"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder="paste secret — never logged"
              />
            </div>
            <Button type="button" disabled={busy || secret.length < 8} onClick={() => deposit("host")}>
              Deposit host secret
            </Button>
            <Button type="button" disabled={busy || secret.length < 8} onClick={() => deposit("dns")}>
              Deposit Name.com secret
            </Button>
          </div>
          <h3 className="text-sm font-semibold tracking-tight">Checklist</h3>
          <ul className="space-y-2 text-sm text-muted-foreground">
            {(data?.checklist || []).map((item) => (
              <li key={item} className="flex items-start gap-2">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-[var(--glow)]" />
                {item}
              </li>
            ))}
          </ul>
          <h3 className="text-sm font-semibold tracking-tight">Pending external</h3>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {(data?.pendingExternal || []).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reviewed plan (preview_only)</CardTitle>
          <CardDescription>64-char SHA-256 of Studio build artifact · tamper hash checked · no execute</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label>Artifact hash</Label>
            <Input
              value={artifactHash}
              onChange={(e) => setArtifactHash(e.target.value.trim())}
              placeholder="64 hex chars"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={busy || artifactHash.length !== 64} onClick={createPlan}>
              Create plan
            </Button>
            <Button type="button" variant="secondary" disabled={busy || !plan} onClick={validatePlan}>
              Validate plan hash
            </Button>
            <Button type="button" variant="outline" disabled={busy || !plan} onClick={validateTamper}>
              Tamper check
            </Button>
          </div>
          {plan ? (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded border p-3 text-xs">
              {JSON.stringify(
                {
                  id: plan.id,
                  hostname: plan.hostname,
                  artifactHash: plan.artifactHash,
                  planHash: plan.planHash,
                  dnsDiff: plan.dnsDiff,
                  estimatedCharges: plan.estimatedCharges,
                  spendingStop: plan.spendingStop,
                  rollbackPlan: plan.rollbackPlan,
                  status: plan.status,
                },
                null,
                2,
              )}
            </pre>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
