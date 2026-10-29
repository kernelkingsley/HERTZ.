import { lazy, Suspense, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Search, Eraser, RefreshCw } from "lucide-react";
import { api } from "../api.js";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const ImageLightbox = lazy(() => import("../components/ImageLightbox.jsx"));

const PROVIDERS = [
  { id: "all", label: "All" },
  { id: "kenney", label: "Kenney" },
  { id: "sketchfab", label: "Sketchfab" },
];

const KENNEY_CATEGORIES = ["", "2D", "3D", "UI", "Audio", "Pixel", "Textures"];

const selectClass =
  "h-9 w-full rounded-xl border border-white/10 bg-black/30 px-3 text-sm text-foreground outline-none focus-visible:border-ring";

export default function FindAssets() {
  const navigate = useNavigate();
  const [provider, setProvider] = useState("all");
  const [draftQ, setDraftQ] = useState("");
  const [draftCategory, setDraftCategory] = useState("");
  const [applied, setApplied] = useState({ q: "", category: "", provider: "all", page: 1 });
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  const [lightbox, setLightbox] = useState(null);

  async function runSearch(next = applied) {
    setBusy(true);
    setError("");
    setSearched(true);
    try {
      const params = new URLSearchParams({
        provider: next.provider,
        q: next.q || "",
        page: String(next.page || 1),
        pageSize: "24",
      });
      if (next.provider === "kenney" && next.category) {
        params.set("category", next.category);
      }
      const data = await api(`/api/find/search?${params}`);
      setResult(data);
      if (data.error && !(data.results || []).length) {
        setError(data.error);
      }
    } catch (err) {
      setError(err.message);
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  function onSearchSubmit(e) {
    e?.preventDefault?.();
    const next = {
      q: draftQ.trim(),
      category: draftCategory,
      provider,
      page: 1,
    };
    setApplied(next);
    runSearch(next);
  }

  function onClear() {
    setDraftQ("");
    setDraftCategory("");
    setProvider("all");
    const empty = { q: "", category: "", provider: "all", page: 1 };
    setApplied(empty);
    setResult(null);
    setError("");
    setSearched(false);
  }

  function onPage(delta) {
    const next = { ...applied, page: Math.max(1, (applied.page || 1) + delta) };
    setApplied(next);
    runSearch(next);
  }

  function detailPath(item) {
    if (item.kind === "library" || item.provider === "upload" || item.id?.match?.(/^[0-9a-f-]{36}$/i)) {
      return `/assets/${item.id}/view`;
    }
    if (item.provider === "kenney" || item.id?.startsWith?.("kenney:")) {
      const id = (item.id || item.slug || "").replace(/^kenney:/, "");
      return `/find-assets/kenney/${encodeURIComponent(id)}`;
    }
    if (item.provider === "sketchfab" || item.uid) {
      return `/find-assets/sketchfab/${encodeURIComponent(item.uid || item.id)}`;
    }
    return "/find";
  }

  const listMode = useMemo(() => {
    if (!searched) return "idle";
    if (busy) return "loading";
    if (error && !(result?.results || []).length) {
      if (result?.offline || /offline|unavailable|network|ENOTFOUND|timeout/i.test(error)) {
        return "provider_offline";
      }
      return "error";
    }
    if (result?.offline && !(result?.results || []).length) return "provider_offline";
    if (result && !(result.results || []).length) return "no_results";
    if ((result?.results || []).length) return "results";
    return "idle";
  }, [searched, busy, error, result]);

  return (
    <div className="page-enter space-y-6" data-testid="find-assets-page">
      <div className="page-head">
        <div>
          <div className="eyebrow mb-3">Providers</div>
          <h1>
            Find assets across <span className="text-[var(--glow)]">Kenney</span> and Sketchfab.
          </h1>
          <p>
            Explicit Search only — no invented Kenney download API. Sketchfab needs a credential on Connections.
            Click a result for details before importing.
          </p>
        </div>
      </div>

      {error ? <p className="error" data-testid="find-error">{error}</p> : null}
      {result?.stale ? (
        <p className="text-sm text-[var(--glow)]" data-testid="find-stale">
          Showing cached Kenney index{result.indexedAt ? ` from ${result.indexedAt}` : ""}. Refresh may have failed
          {result.lastError ? `: ${result.lastError}` : "."}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Unified search</CardTitle>
          <CardDescription>
            Tabs filter providers. Library hits in All are labeled separately from official discovery results.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Provider" data-testid="provider-tabs">
            {PROVIDERS.map((p) => (
              <Button
                key={p.id}
                type="button"
                size="sm"
                variant={provider === p.id ? "default" : "outline"}
                role="tab"
                aria-selected={provider === p.id}
                data-testid={`provider-tab-${p.id}`}
                onClick={() => setProvider(p.id)}
              >
                {p.label}
              </Button>
            ))}
          </div>

          <form data-testid="find-search-form" onSubmit={onSearchSubmit} className="space-y-3">
            <div className="grid gap-3 md:grid-cols-[1fr_auto_auto]">
              <div className="space-y-1.5">
                <Label htmlFor="find-q">Keywords</Label>
                <Input
                  id="find-q"
                  value={draftQ}
                  onChange={(e) => setDraftQ(e.target.value)}
                  placeholder="Pack title, tags, model name…"
                  autoComplete="off"
                />
              </div>
              {provider === "kenney" || provider === "all" ? (
                <div className="space-y-1.5">
                  <Label htmlFor="find-cat">Kenney category</Label>
                  <select
                    id="find-cat"
                    className={selectClass}
                    value={draftCategory}
                    onChange={(e) => setDraftCategory(e.target.value)}
                    disabled={provider === "all"}
                    data-testid="kenney-category"
                  >
                    {KENNEY_CATEGORIES.map((c) => (
                      <option key={c || "any"} value={c}>
                        {c || "Any"}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" className="gap-2" disabled={busy} data-testid="find-search-button">
                <Search className="size-4" />
                Search
              </Button>
              <Button type="button" variant="outline" className="gap-2" onClick={onClear} data-testid="find-clear">
                <Eraser className="size-4" />
                Clear search
              </Button>
              {provider === "kenney" || provider === "all" ? (
                <Button
                  type="button"
                  variant="outline"
                  className="gap-2"
                  disabled={busy}
                  data-testid="find-refresh-kenney"
                  onClick={() => {
                    const next = { ...applied, provider, q: draftQ.trim(), category: draftCategory, page: 1 };
                    setApplied(next);
                    setBusy(true);
                    api(`/api/find/search?${new URLSearchParams({
                      provider: next.provider,
                      q: next.q,
                      page: "1",
                      refresh: "1",
                      ...(next.category ? { category: next.category } : {}),
                    })}`)
                      .then(setResult)
                      .catch((err) => setError(err.message))
                      .finally(() => setBusy(false));
                    setSearched(true);
                  }}
                >
                  <RefreshCw className="size-4" />
                  Refresh Kenney index
                </Button>
              ) : null}
            </div>
          </form>
        </CardContent>
      </Card>

      {listMode === "loading" ? (
        <p className="text-sm text-muted-foreground" data-testid="find-loading">
          Searching…
        </p>
      ) : null}

      {listMode === "provider_offline" ? (
        <Card data-testid="find-provider-offline">
          <CardHeader>
            <CardTitle>Provider unavailable</CardTitle>
            <CardDescription>
              {error || result?.message || "Could not reach this provider. Retry or check Connections for Sketchfab."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button type="button" onClick={() => runSearch(applied)} data-testid="find-retry">
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {listMode === "no_results" ? (
        <Card data-testid="find-no-results">
          <CardHeader>
            <CardTitle>No results</CardTitle>
            <CardDescription>Nothing matched this query for the selected provider.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button type="button" variant="outline" onClick={onClear}>
              Clear search
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {listMode === "results" ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="find-results">
            {(result?.results || []).map((item) => {
              const key = item.uid || item.id || item.slug || item.name;
              return (
                <Card
                  key={key}
                  className="cursor-pointer transition hover:border-white/20"
                  data-testid="find-result-card"
                  onClick={() => navigate(detailPath(item))}
                >
                  <CardContent className="space-y-3 pt-4">
                    {item.thumbnailUrl || item.thumbnails ? (
                      <button
                        type="button"
                        className="block w-full"
                        data-testid="find-card-image"
                        onClick={(e) => {
                          e.stopPropagation();
                          const src = item.thumbnailUrl || item.thumbnails;
                          setLightbox({
                            src,
                            alt: item.name || item.displayName || "Asset",
                            originalUrl: src,
                          });
                        }}
                      >
                        <img
                          src={item.thumbnailUrl || item.thumbnails}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          className="h-40 w-full rounded-xl object-contain bg-black/30"
                        />
                      </button>
                    ) : (
                      <div className="grid h-40 place-items-center rounded-xl bg-white/5 text-xs text-muted-foreground">
                        No thumb
                      </div>
                    )}
                    <div className="font-medium">{item.name || item.displayName}</div>
                    <div className="flex flex-wrap gap-1">
                      <Badge variant="outline" className="rounded-full text-[10px]">
                        {item.provider || "unknown"}
                      </Badge>
                      {item.kind === "library" ? (
                        <Badge className="rounded-full text-[10px]" data-testid="library-hit-badge">
                          In library
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="rounded-full text-[10px]">
                          Discovery
                        </Badge>
                      )}
                      {item.category ? (
                        <Badge variant="outline" className="rounded-full text-[10px]">
                          {item.category}
                        </Badge>
                      ) : null}
                      {item.license ? (
                        <Badge variant="outline" className="rounded-full text-[10px]">
                          {item.license}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="line-clamp-2 text-xs text-muted-foreground">
                      {item.note || item.description || item.author || ""}
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(detailPath(item));
                      }}
                    >
                      View details
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
          <div className="flex justify-center gap-2">
            <Button type="button" variant="outline" disabled={(applied.page || 1) <= 1 || busy} onClick={() => onPage(-1)}>
              Previous
            </Button>
            <span className="self-center text-xs text-muted-foreground">
              Page {result?.page || applied.page || 1}
              {result?.pageCount ? ` / ${result.pageCount}` : ""}
            </span>
            <Button
              type="button"
              variant="outline"
              disabled={busy || (result?.pageCount != null && (applied.page || 1) >= result.pageCount)}
              onClick={() => onPage(1)}
            >
              Next
            </Button>
          </div>
        </>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Prefer importing a downloaded Kenney ZIP on the{" "}
        <Link to="/assets" className={cn(buttonVariants({ variant: "link" }), "h-auto p-0")}>
          Asset Library
        </Link>
        . Direct Kenney ZIP URLs are never invented.
      </p>

      {lightbox ? (
        <Suspense fallback={null}>
          <ImageLightbox
            open
            src={lightbox.src}
            alt={lightbox.alt}
            originalUrl={lightbox.originalUrl}
            onClose={() => setLightbox(null)}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
