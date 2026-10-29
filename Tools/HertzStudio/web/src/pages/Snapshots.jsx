import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { getMilestoneStatus, statusBadgeVariant } from "../lib/milestoneStatus.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

/** W11 named snapshots / diffs / restore plans — no git reset. */
export default function Snapshots() {
  const status = getMilestoneStatus("W11");
  const [list, setList] = useState(null);
  const [name, setName] = useState("w11-proof");
  const [diff, setDiff] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setList(await api("/api/snapshots"));
  }, []);

  useEffect(() => {
    refresh().catch((e) => setError(String(e.message || e)));
  }, []);

  async function createSnap(content = "surface=A") {
    setBusy(true);
    setError("");
    try {
      const snap = await api("/api/snapshots", {
        method: "POST",
        body: JSON.stringify({
          name,
          scenePath: "Assets/Scenes/HertzStudioTest.unity",
          entries: [
            {
              path: "Assets/HertzStudio/Materials/TestFloor.mat",
              kind: "material",
              content,
            },
          ],
        }),
      });
      await refresh();
      setMessage(`Snapshot ${snap.id} · hash ${snap.manifestHash.slice(0, 12)}…`);
      return snap;
    } catch (e) {
      setError(String(e.message || e));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function compareLatest() {
    const snaps = list?.snapshots || [];
    if (snaps.length < 2) {
      setError("Need at least two snapshots to diff.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const d = await api(`/api/snapshots/diff?a=${snaps[1].id}&b=${snaps[0].id}`);
      setDiff(d);
      setMessage(`Diff: +${d.added.length} ~${d.changed.length} -${d.removed.length}`);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function restorePlan(id) {
    setBusy(true);
    setError("");
    try {
      const plan = await api(`/api/snapshots/${id}/restore-plan`, {
        method: "POST",
        body: JSON.stringify({ confirm: true }),
      });
      setMessage(`Restore plan ready (${plan.steps?.length || 0} steps). No automatic write.`);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-enter space-y-6">
      <div className="page-head">
        <div>
          <div className="eyebrow mb-3">History</div>
          <h1>Snapshots</h1>
          <p>
            Named local Unity snapshots with hashed manifests outside Assets. Studio draft rollback ≠ Unity file
            restore.
          </p>
        </div>
        <Badge variant={statusBadgeVariant(status)} className="rounded-full">
          W11: {status}
        </Badge>
      </div>

      {error ? <p className="error">{error}</p> : null}
      {message ? <p className="muted">{message}</p> : null}
      {list?.storageRoot ? <p className="muted text-sm">Storage: {list.storageRoot}</p> : null}

      <Card>
        <CardHeader>
          <CardTitle>Capture</CardTitle>
          <CardDescription>Excludes Library, Temp, secrets, SampleScene</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} className="max-w-xs" />
          <Button type="button" disabled={busy} onClick={() => createSnap("surface=A")}>
            Snapshot A
          </Button>
          <Button type="button" disabled={busy} onClick={() => createSnap("surface=B")}>
            Snapshot B
          </Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={compareLatest}>
            Diff latest two
          </Button>
        </CardContent>
      </Card>

      {diff ? (
        <Card>
          <CardHeader>
            <CardTitle>Diff</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <pre className="whitespace-pre-wrap">{JSON.stringify(diff, null, 2)}</pre>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm">
            {(list?.snapshots || []).map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded border px-3 py-2">
                <span>
                  {s.name} · {s.entryCount} entries · {s.totalBytes} B
                </span>
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => restorePlan(s.id)}>
                  Restore plan
                </Button>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
