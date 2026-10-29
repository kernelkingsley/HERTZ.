import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { getMilestoneStatus, statusBadgeVariant } from "../lib/milestoneStatus.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** W10 Performance inspector — never labels estimates/Editor as Quest. */
export default function Performance() {
  const status = getMilestoneStatus("W10");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setData(await api("/api/performance/captures?page=1&pageSize=20"));
  }, []);

  useEffect(() => {
    refresh().catch((e) => setError(String(e.message || e)));
  }, []);

  async function ingest(source) {
    setBusy(true);
    setError("");
    try {
      await api("/api/performance/captures", {
        method: "POST",
        body: JSON.stringify({
          source,
          buildVersion: "local-dev",
          device: source === "quest_device" ? "Quest 3S" : source === "browser_viewport" ? "Chrome" : "Editor",
          refreshRateHz: source === "quest_device" ? 72 : 60,
          scenePath: "Assets/Scenes/HertzStudioTest.unity",
          sceneRevision: 1,
          durationSeconds: 5,
          cpuFrameMs: 8.2,
          gpuFrameMs: 7.1,
          fps: 72,
          drawCalls: 120,
          batches: 80,
          triangles: 450000,
          vertices: 300000,
          textureMemoryBytes: 64 * 1024 * 1024,
          materialCount: 24,
          lightCount: 3,
          unavailable: source === "static_estimate" ? ["gpuFrameMs: estimate only"] : [],
          samples: [{ t: 0, cpu: 8.2 }],
        }),
      });
      await refresh();
      setMessage(`Ingested ${source} capture (labeled honestly).`);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function ingestMalformed() {
    setBusy(true);
    setError("");
    try {
      await api("/api/performance/captures", {
        method: "POST",
        body: JSON.stringify({ source: "unity_editor", cpuFrameMs: Number.NaN }),
      });
      setMessage("Unexpected: malformed accepted");
    } catch (e) {
      setError(`Malformed rejected (expected): ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-enter space-y-6">
      <div className="page-head">
        <div>
          <div className="eyebrow mb-3">Budget</div>
          <h1>Performance</h1>
          <p>
            Static estimates, Editor measurements, browser viewport metrics, and Quest device captures are separate
            sources. Real Quest results stay pending without a device capture.
          </p>
        </div>
        <Badge variant={statusBadgeVariant(status)} className="rounded-full">
          W10: {status}
        </Badge>
      </div>

      {error ? <p className="error">{error}</p> : null}
      {message ? <p className="muted">{message}</p> : null}

      <Card>
        <CardHeader>
          <CardTitle>Import / capture</CardTitle>
          <CardDescription>Quest 3S procedure: build → headset profiler/export → upload here as quest_device</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button type="button" disabled={busy} onClick={() => ingest("static_estimate")}>
            Static estimate
          </Button>
          <Button type="button" disabled={busy} onClick={() => ingest("unity_editor")}>
            Editor measurement
          </Button>
          <Button type="button" disabled={busy} onClick={() => ingest("browser_viewport")}>
            Browser viewport
          </Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => ingest("quest_device")}>
            Quest fixture (mark pending if not real)
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={ingestMalformed}>
            Malformed (expect fail)
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Captures</CardTitle>
          <CardDescription>
            {data ? `page ${data.page}/${Math.max(1, Math.ceil(data.total / data.pageSize))} · ${data.total} total` : "…"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm">
            {(data?.captures || []).map((c) => (
              <li key={c.id} className="rounded border px-3 py-2">
                <div className="font-medium">{c.label}</div>
                <div className="text-muted-foreground">
                  {c.source} · {c.device || "—"} · {c.scenePath || "—"} rev {c.sceneRevision ?? "—"} · FPS{" "}
                  {c.summary?.fps ?? "n/a"} · budget {c.summary?.frameBudgetMs?.toFixed?.(2) ?? "n/a"} ms
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
