import { useEffect, useState } from "react";
import { Link2 } from "lucide-react";
import { api } from "../api.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { headsetRecovery, headsetStatusLabel } from "../lib/headsetDisplay.js";

export function HeadsetConnectionCard({ headset }) {
  const status = headset?.stale ? "unknown" : headset?.status || "unknown";
  const label = headsetStatusLabel(headset);
  const xr = headset?.openxr || {};
  const adb = headset?.adb || {};
  return (
    <Card data-testid="headset-connection-card">
      <CardHeader>
        <CardTitle>Headset</CardTitle>
        <CardDescription className={status === "connected" ? "text-[var(--ok)]" : undefined}>
          {label}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div>
          <strong>USB / ADB</strong>
          <div className="meta mt-1">
            <span>Status: {adb.status || "unknown"}</span>
            <span>Devices: {adb.deviceCount ?? 0}</span>
            <span>Model: {adb.model || "—"}</span>
            <span>Transport: {adb.transport || "—"}</span>
            <span>Serial: {adb.maskedSerial || "—"}</span>
            <span>Last successful probe: {headset?.lastSuccessfulProbeAt || "—"}</span>
          </div>
        </div>
        <div>
          <strong>OpenXR runtime</strong>
          <div className="meta mt-1">
            <span>Unity: {xr.unityConnected ? "connected" : "offline"}</span>
            <span>Loader: {xr.loaderActive ? xr.loaderName || "active" : "inactive"}</span>
            <span>XR display: {xr.displayRunning ? "running" : "not running"}</span>
            <span>HMD input: {xr.hmdPresent ? xr.deviceName || "observable" : "not observable"}</span>
            <span>Runtime: {xr.runtimeName || "—"}</span>
          </div>
        </div>
        <p className="muted">{headsetRecovery(status)}</p>
        <p className="text-xs text-muted-foreground">
          Headset status is informational for editing. It only gates headset verification, Quest transfer, performance capture, and audible headset testing.
        </p>
      </CardContent>
    </Card>
  );
}

export default function Connections() {
  const [data, setData] = useState(null);
  const [pairing, setPairing] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [sketchfabToken, setSketchfabToken] = useState("");
  const [sketchfabBusy, setSketchfabBusy] = useState(false);
  const [sketchfabMeta, setSketchfabMeta] = useState(null);

  async function refresh() {
    const next = await api("/api/connections");
    setData(next);
    const sf = await api("/api/connections/sketchfab");
    setSketchfabMeta(sf);
  }

  useEffect(() => {
    refresh().catch((err) => setError(err.message));
    const timer = setInterval(() => {
      refresh().catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  async function testSketchfab() {
    setSketchfabBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api("/api/connections/sketchfab/test", {
        method: "POST",
        body: JSON.stringify({ credential: sketchfabToken }),
      });
      setMessage(`Sketchfab OK: ${result.accountLabel || "account"} (read-only validation).`);
      setSketchfabToken("");
    } catch (err) {
      setError(err.message);
    } finally {
      setSketchfabBusy(false);
    }
  }

  async function saveSketchfab() {
    setSketchfabBusy(true);
    setError("");
    setMessage("");
    try {
      const meta = await api("/api/connections/sketchfab", {
        method: "POST",
        body: JSON.stringify({ credential: sketchfabToken }),
      });
      setSketchfabMeta(meta);
      setSketchfabToken("");
      setMessage("Sketchfab credential stored in OS DPAPI secret store (not store.json).");
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setSketchfabBusy(false);
    }
  }

  async function disconnectSketchfab() {
    setSketchfabBusy(true);
    setError("");
    try {
      const meta = await api("/api/connections/sketchfab", { method: "DELETE" });
      setSketchfabMeta(meta);
      setSketchfabToken("");
      setMessage("Sketchfab disconnected.");
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setSketchfabBusy(false);
    }
  }

  async function startPairing() {
    setError("");
    setMessage("");
    try {
      const result = await api("/api/connections/pair/start", { method: "POST", body: "{}" });
      setPairing(result);
      setMessage("Pairing code ready. Redeem it from the Unity-machine connector only.");
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="page-enter">
      <div className="page-head">
        <div>
          <div className="eyebrow mb-3">Secure links</div>
          <h1>
            Connections that stay{" "}
            <span className="text-[var(--glow)]">private</span>.
          </h1>
          <p>
            Credentials live in backend/OS secret storage — never browser storage, builds, or public static hosting.
            Unity talks outbound; Editor/MCP ports stay off the public internet.
          </p>
        </div>
        <div className="actions">
          <Button className="gap-2 font-semibold" onClick={startPairing}>
            <Link2 className="size-4" />
            Pair Unity connector
          </Button>
        </div>
      </div>

      {error ? <p className="error mb-4">{error}</p> : null}
      {message ? <p className="ok mb-4">{message}</p> : null}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Unity connector</CardTitle>
            <CardDescription
              className={data?.project?.unityConnected ? "text-[var(--ok)]" : undefined}
            >
              {data?.project?.unityConnected
                ? "Connected"
                : data?.pairing?.paired
                  ? "Paired — Unity offline or connector idle"
                  : "Not paired yet"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="meta">
              <span>Revision {data?.project?.unityRevision ?? 0}</span>
              <span>Last seen {data?.project?.connectorLastSeenAt || "—"}</span>
              <span>Last sync {data?.project?.lastSceneSyncAt || "—"}</span>
            </div>
            {pairing ? (
              <div className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-4 text-sm">
                <div>
                  <strong>Pairing code:</strong>{" "}
                  <code className="text-primary">{pairing.code}</code>
                </div>
                <p className="muted mt-2">Expires {pairing.expiresAt}</p>
                <p className="muted">{pairing.instruction}</p>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <HeadsetConnectionCard headset={data?.connections?.headset} />

        <Card>
          <CardHeader>
            <CardTitle>Sketchfab</CardTitle>
            <CardDescription>
              {sketchfabMeta?.status || data?.connections?.sketchfab?.status || "not_configured"}
              {sketchfabMeta?.maskedId ? ` · ${sketchfabMeta.maskedId}` : ""}
              {sketchfabMeta?.accountLabel ? ` · ${sketchfabMeta.accountLabel}` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="muted text-sm">
              Paste a new API token to test or replace. The field is never prefilled with an existing secret. Sent only
              to the authenticated backend over local trusted transport / HTTPS; stored via Windows DPAPI.
            </p>
            <div className="space-y-2">
              <Label htmlFor="sketchfab-token">API token</Label>
              <Input
                id="sketchfab-token"
                type="password"
                autoComplete="new-password"
                placeholder="Paste token (never stored in the browser)"
                value={sketchfabToken}
                onChange={(e) => setSketchfabToken(e.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={sketchfabBusy || !sketchfabToken}
                onClick={testSketchfab}
              >
                Test
              </Button>
              <Button disabled={sketchfabBusy || !sketchfabToken} onClick={saveSketchfab}>
                Save
              </Button>
              <Button
                variant="outline"
                disabled={sketchfabBusy || !sketchfabMeta?.configured}
                onClick={disconnectSketchfab}
              >
                Disconnect
              </Button>
            </div>
            {sketchfabMeta?.validatedAt ? (
              <p className="text-xs text-muted-foreground">Validated {sketchfabMeta.validatedAt}</p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Kenney</CardTitle>
            <CardDescription>no_credential_required</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="muted text-sm">
              Download free individual packs from kenney.nl and import ZIPs on the Asset Library. No Kenney API key
              field — the paid All-in-1 bundle is not required.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle>Deploy / Name.com</CardTitle>
            <Badge variant="outline" className="rounded-full border-[var(--glow)]/40 text-[var(--glow)]">
              pending
            </Badge>
          </CardHeader>
          <CardContent>
            <p className="text-sm">
              Domain <strong>hertz.software</strong> → <strong>studio.hertz.software</strong>. Hosting provider not
              selected. DNS/setup deferred.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Meshy</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="muted">Excluded from HERTZ Studio. Credit-based generators are not part of this product.</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
