import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Gallery of Unity avatar body-test screenshots (FP / third-person).
 * Images are served from /api/avatar-previews (owner session).
 */
export default function AvatarPreviews() {
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const res = await api("/api/avatar-previews");
      const list = Array.isArray(res?.previews) ? res.previews : [];
      setItems(list);
      setSelected((prev) => {
        if (prev && list.some((p) => p.name === prev)) return prev;
        return list[0]?.name || null;
      });
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const active = items.find((p) => p.name === selected) || null;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">Avatar previews</h1>
          <Badge variant="secondary">Body / XR test</Badge>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Screenshots from <code className="text-xs">HertzAvatarBodyTest</code> — first-person arms and
          third-person body while controllers drive the Humanoid hands. SampleScene is untouched.
        </p>
      </header>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" disabled={busy} onClick={() => refresh()}>
          Refresh
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
        <Card className="border-white/10 bg-black/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Shots</CardTitle>
            <CardDescription>{items.length} file{items.length === 1 ? "" : "s"}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            {items.length === 0 ? (
              <p className="text-sm text-muted-foreground">No previews yet.</p>
            ) : (
              items.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  className={`block w-full rounded-lg px-3 py-2 text-left text-sm transition ${
                    selected === p.name ? "bg-white/15 text-foreground" : "text-muted-foreground hover:bg-white/5"
                  }`}
                  onClick={() => setSelected(p.name)}
                >
                  <div className="font-medium text-foreground">{p.label || p.name}</div>
                  <div className="text-xs opacity-70">{p.kb} KB</div>
                </button>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-black/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{active?.label || active?.name || "Preview"}</CardTitle>
            <CardDescription>
              {active
                ? "Captured from Unity Play Mode. Headset check still required for final grip feel."
                : "Select a shot."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {active ? (
              <a href={active.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-xl bg-black/40">
                <img
                  src={active.url}
                  alt={active.label || active.name}
                  className="max-h-[70vh] w-full object-contain"
                  data-testid="avatar-preview-image"
                />
              </a>
            ) : (
              <p className="text-sm text-muted-foreground">Nothing selected.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
