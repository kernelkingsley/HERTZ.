import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { getMilestoneStatus, statusBadgeVariant } from "../lib/milestoneStatus.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * W06 Analytics — aggregates from imported playtest captures (Unity off OK).
 * No raw event dump for charts. No personal identifiers.
 */
export default function Analytics() {
  const w06Status = getMilestoneStatus("W06");
  const [summary, setSummary] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [schema, setSchema] = useState(null);
  const [quest, setQuest] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [filters, setFilters] = useState({ buildId: "", levelId: "", from: "", to: "" });

  const query = useCallback(() => {
    const q = new URLSearchParams();
    if (filters.buildId) q.set("buildId", filters.buildId);
    if (filters.levelId) q.set("levelId", filters.levelId);
    if (filters.from) q.set("from", filters.from);
    if (filters.to) q.set("to", filters.to);
    const s = q.toString();
    return s ? `?${s}` : "";
  }, [filters]);

  async function refresh() {
    const q = query();
    const [sum, sess, sch, qt] = await Promise.all([
      api(`/api/analytics/summary${q}`),
      api(`/api/analytics/sessions${q}`),
      api("/api/analytics/schema"),
      api("/api/analytics/quest-transfer"),
    ]);
    setSummary(sum);
    setSessions(sess.sessions || []);
    setSchema(sch);
    setQuest(qt);
  }

  useEffect(() => {
    refresh().catch((e) => setError(String(e.message || e)));
  }, []);

  async function applyFilters() {
    setBusy(true);
    setError("");
    try {
      await refresh();
      setMessage("Filters applied — aggregates recomputed server-side.");
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function onImportFile(file) {
    if (!file) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const text = await file.text();
      const body = JSON.parse(text);
      const result = await api("/api/analytics/captures/import", {
        method: "POST",
        body: JSON.stringify(body),
      });
      await refresh();
      setMessage(
        result.imported > 0
          ? `Imported ${result.imported} events (${result.duplicates || 0} duplicates skipped).`
          : `No new events (${result.duplicates || 0} duplicates).`,
      );
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  function downloadExport(format) {
    const q = query();
    const sep = q ? "&" : "?";
    window.location.href = `/api/analytics/export${q}${sep}format=${format}`;
  }

  const combat = summary?.combat || {};
  const samples = summary?.sampleCounts || {};

  return (
    <div className="space-y-4 p-4" data-testid="analytics-page">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
          <p className="text-sm text-muted-foreground">
            Owner-private playtest readouts from imported captures. Values stay available with Unity off.
          </p>
        </div>
        <Badge variant={statusBadgeVariant(w06Status)} data-testid="analytics-milestone-badge">
          {w06Status}
        </Badge>
      </div>

      {error ? (
        <div className="error rounded-xl border border-red-500/40 px-3 py-2 text-sm" data-testid="analytics-error">
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="rounded-xl border border-white/10 px-3 py-2 text-sm" data-testid="analytics-message">
          {message}
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filters</CardTitle>
          <CardDescription>Server-side aggregates only — no unbounded raw event download for charts.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Label htmlFor="an-build">Build</Label>
            <Input
              id="an-build"
              data-testid="analytics-filter-build"
              value={filters.buildId}
              onChange={(e) => setFilters((f) => ({ ...f, buildId: e.target.value }))}
              placeholder="build id"
            />
          </div>
          <div>
            <Label htmlFor="an-level">Level</Label>
            <Input
              id="an-level"
              data-testid="analytics-filter-level"
              value={filters.levelId}
              onChange={(e) => setFilters((f) => ({ ...f, levelId: e.target.value }))}
              placeholder="level id"
            />
          </div>
          <div>
            <Label htmlFor="an-from">From (ISO)</Label>
            <Input
              id="an-from"
              data-testid="analytics-filter-from"
              value={filters.from}
              onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
            />
          </div>
          <div>
            <Label htmlFor="an-to">To (ISO)</Label>
            <Input
              id="an-to"
              data-testid="analytics-filter-to"
              value={filters.to}
              onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
            />
          </div>
          <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-4">
            <Button type="button" data-testid="analytics-apply-filters" disabled={busy} onClick={applyFilters}>
              Apply filters
            </Button>
            <Button type="button" variant="outline" data-testid="analytics-export-json" onClick={() => downloadExport("json")}>
              Export JSON
            </Button>
            <Button type="button" variant="outline" data-testid="analytics-export-csv" onClick={() => downloadExport("csv")}>
              Export CSV
            </Button>
            <label className="inline-flex cursor-pointer items-center">
              <span className="sr-only">Import capture</span>
              <input
                type="file"
                accept="application/json,.json"
                data-testid="analytics-import-file"
                className="text-xs"
                disabled={busy}
                onChange={(e) => onImportFile(e.target.files?.[0])}
              />
            </label>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4" data-testid="analytics-summary-cards">
        <StatCard label="Sessions" value={samples.sessions ?? "—"} hint={`${samples.incompleteSessions || 0} incomplete`} />
        <StatCard
          label="Accuracy"
          value={combat.accuracy != null ? `${(combat.accuracy * 100).toFixed(1)}%` : "—"}
          hint={`${combat.hits ?? 0}/${combat.shots ?? 0} hits/shots`}
        />
        <StatCard label="Enemy defeats" value={combat.enemyDefeats ?? "—"} hint={`${combat.frequencyFlips ?? 0} frequency flips`} />
        <StatCard
          label="Frame avg"
          value={summary?.frameTime?.avgMs != null ? `${summary.frameTime.avgMs.toFixed(2)} ms` : "—"}
          hint={`${summary?.frameTime?.sampleCount ?? 0} samples`}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sessions</CardTitle>
          <CardDescription>Duration, completion, weapon usage density per session.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto" data-testid="analytics-sessions-table">
            <table className="w-full text-left text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="p-2">Session</th>
                  <th className="p-2">Build</th>
                  <th className="p-2">Duration</th>
                  <th className="p-2">Completed</th>
                  <th className="p-2">Shots</th>
                  <th className="p-2">Accuracy</th>
                  <th className="p-2">Defeats</th>
                </tr>
              </thead>
              <tbody>
                {sessions.length === 0 ? (
                  <tr>
                    <td className="p-2 text-muted-foreground" colSpan={7}>
                      No sessions yet — import a Unity capture JSON.
                    </td>
                  </tr>
                ) : (
                  sessions.map((s) => (
                    <tr key={s.sessionId} className="border-t border-white/10" data-testid="analytics-session-row">
                      <td className="p-2 font-mono">{s.sessionId.slice(0, 12)}…</td>
                      <td className="p-2">{s.buildId}</td>
                      <td className="p-2">{s.durationMs != null ? `${(s.durationMs / 1000).toFixed(1)}s` : "—"}</td>
                      <td className="p-2">{s.completed ? "yes" : s.incomplete ? "incomplete" : "no"}</td>
                      <td className="p-2">{s.shots}</td>
                      <td className="p-2">{s.accuracy != null ? `${(s.accuracy * 100).toFixed(0)}%` : "—"}</td>
                      <td className="p-2">{s.enemyDefeats}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {summary?.weaponUsage?.length ? (
            <div className="mt-4 text-xs" data-testid="analytics-weapon-usage">
              <p className="mb-1 font-medium">Weapon usage</p>
              <ul className="list-inside list-disc text-muted-foreground">
                {summary.weaponUsage.map((w) => (
                  <li key={`${w.weaponId}-${w.weaponRole}`}>
                    {w.weaponId} ({w.weaponRole || "—"}): {w.shots} shots, {w.hits} hits
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Quest capture transfer</CardTitle>
          <CardDescription>Documented only — device collection unverified in W06.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-muted-foreground" data-testid="analytics-quest-guide">
          {(quest?.steps || []).map((step) => (
            <p key={step}>• {step}</p>
          ))}
          {schema?.questTransferNote ? <p className="pt-2">{schema.questTransferNote}</p> : null}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ label, value, hint }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">{hint}</CardContent>
    </Card>
  );
}
