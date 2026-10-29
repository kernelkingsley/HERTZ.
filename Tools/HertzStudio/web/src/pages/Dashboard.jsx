import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Radio, Waves } from "lucide-react";
import { api } from "../api.js";
import {
  applyDurableMilestoneGates,
  editorCardsWithStatus,
  getMilestoneStatus,
  statusBadgeVariant,
  summarizeMilestoneProgress,
} from "../lib/milestoneStatus.js";
import { usePremiumPage } from "@/lib/motion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [gatesTick, setGatesTick] = useState(0);
  const pageRef = usePremiumPage([data?.project?.unityConnected, gatesTick]);
  const editors = editorCardsWithStatus();
  const milestoneSummary = summarizeMilestoneProgress();

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const next = await api("/api/project");
        if (!cancelled) setData(next);
        try {
          const milestones = await api("/api/milestones");
          if (!cancelled) {
            applyDurableMilestoneGates(milestones);
            setGatesTick((n) => n + 1);
          }
        } catch {
          /* keep prior gates */
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    }
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const connected = Boolean(data?.project?.unityConnected);

  return (
    <div ref={pageRef}>
      <div className="page-head" data-reveal>
        <div>
          <div className="eyebrow mb-3">Frequency authoring</div>
          <h1>
            Good working session.
            <br />
            <span className="font-normal text-muted-foreground">Make the town feel </span>
            <span className="text-[var(--glow)]">impossible to ignore.</span>
          </h1>
          <p>
            Cloud drafts stay durable when Unity is offline. Scene apply waits for the paired connector — no public
            Editor ports.
          </p>
        </div>
        <div className="actions">
          <Button
            variant="outline"
            className="border-white/15 bg-white/5"
            nativeButton={false}
            render={<Link to="/find" />}
          >
            Find a model
          </Button>
          <Button className="gap-1.5 font-semibold" nativeButton={false} render={<Link to="/level-editor" />}>
            Open the town
            <ArrowUpRight className="size-4" />
          </Button>
        </div>
      </div>

      <div className="mb-6 flex flex-wrap gap-2" data-reveal>
        <div data-float className="glass-pill">
          <Radio className="size-3.5 text-primary" />
          {connected ? "Unity live" : "Unity offline — drafts OK"}
        </div>
        <div data-float className="glass-pill">
          <Waves className="size-3.5 text-[var(--glow)]" />
          Rev {data?.project?.unityRevision ?? "—"}
        </div>
        <div data-float className="glass-pill text-muted-foreground">
          Pending {data?.queueSummary?.pending ?? 0} · Applied {data?.queueSummary?.applied ?? 0}
        </div>
        <div data-float className="glass-pill text-muted-foreground" data-testid="dashboard-milestone-summary">
          Milestones {milestoneSummary.completed}/{milestoneSummary.total} ({milestoneSummary.percentComplete}%) · W03{" "}
          {getMilestoneStatus("W03")}
        </div>
      </div>

      {error ? <p className="error mb-4" data-reveal>{error}</p> : null}

      <div className="mb-10 grid gap-4 md:grid-cols-3" data-reveal>
        <Card className="md:col-span-1">
          <CardHeader>
            <CardTitle className="text-xl tracking-tight">{data?.project?.name || "HERTZ"}</CardTitle>
            <CardDescription>{data?.project?.description || "Loading project…"}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="meta">
              <span>Draft {data?.draft?.status || "…"}</span>
              <span>{connected ? "Connected" : "Disconnected"}</span>
            </div>
            <Button className="gap-1.5" nativeButton={false} render={<Link to="/level-editor" />}>
              Open in level editor
              <ArrowUpRight className="size-4" />
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Sync pulse</CardTitle>
            <CardDescription>Outbound connector queue</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="grid grid-cols-3 gap-2">
              {[
                { label: "Pending", value: data?.queueSummary?.pending ?? 0 },
                { label: "Applied", value: data?.queueSummary?.applied ?? 0 },
                { label: "Conflicts", value: data?.queueSummary?.conflict ?? 0 },
              ].map((stat) => (
                <div key={stat.label} className="rounded-2xl border border-white/10 bg-white/5 p-3 text-center">
                  <div className="text-2xl font-semibold tracking-tight">{stat.value}</div>
                  <div className="mt-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{stat.label}</div>
                </div>
              ))}
            </div>
            <p className="muted">Last scene sync: {data?.project?.lastSceneSyncAt || "never"}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Deploy</CardTitle>
            <CardDescription>
              <span className="text-foreground">studio.hertz.software</span> · Name.com · hosting deferred
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" className="border-white/15 bg-white/5" nativeButton={false} render={<Link to="/deploy" />}>
              View Deploy status
            </Button>
          </CardContent>
        </Card>
      </div>

      <div className="mb-4 flex items-end justify-between gap-3" data-reveal>
        <div>
          <div className="eyebrow mb-2">Editors</div>
          <h2 className="m-0 text-xl font-semibold tracking-tight">Tools on the frequency</h2>
        </div>
        <Button variant="outline" size="sm" className="border-white/15 bg-white/5" nativeButton={false} render={<Link to="/milestones" />}>
          All milestones
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-reveal>
        {editors.map((editor) => (
          <Link key={editor.title} to={editor.to} className="group block">
            <Card className="h-full transition-all duration-300 group-hover:-translate-y-1 group-hover:border-[var(--glow)]/35 group-hover:shadow-[0_20px_50px_rgb(255_107_61_/_0.12)]">
              <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
                <CardTitle className="text-base tracking-tight">{editor.title}</CardTitle>
                <Badge
                  variant={statusBadgeVariant(editor.state)}
                  className="rounded-full"
                  data-testid={`editor-status-${editor.milestoneId}`}
                >
                  {editor.state}
                </Badge>
              </CardHeader>
              <CardContent>
                <p className="muted">{editor.blurb}</p>
                <p className="mt-2 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{editor.milestoneId}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <div
        className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-white/8 pt-5 text-xs text-muted-foreground"
        data-reveal
      >
        <span className="inline-flex items-center gap-2">
          <span className="size-1.5 rounded-full bg-[var(--glow)]" />
          Durable drafts
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="size-1.5 rounded-full bg-[var(--glow)]" />
          Revision-safe apply
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="size-1.5 rounded-full bg-[var(--glow)]" />
          No public Editor ports
        </span>
      </div>
    </div>
  );
}
