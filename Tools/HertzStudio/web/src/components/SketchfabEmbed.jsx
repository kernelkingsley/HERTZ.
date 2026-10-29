import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Lazy official Sketchfab embed for pre-import preview.
 * Does not load Three.js; uses Sketchfab's viewer when the model permits embedding.
 */
export default function SketchfabEmbed({ uid, fallbackThumb, fallbackMessage }) {
  const [enabled, setEnabled] = useState(false);
  const [failed, setFailed] = useState(false);
  const iframeRef = useRef(null);

  useEffect(() => {
    return () => {
      if (iframeRef.current) {
        iframeRef.current.src = "about:blank";
      }
    };
  }, [uid]);

  if (!uid) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="sketchfab-embed-missing">
        Missing Sketchfab model id.
      </p>
    );
  }

  if (failed || !enabled) {
    return (
      <div className="space-y-3" data-testid="sketchfab-embed-fallback">
        {fallbackThumb ? (
          <img
            src={fallbackThumb}
            alt=""
            loading="lazy"
            className="max-h-72 w-full rounded-2xl object-contain bg-black/30"
          />
        ) : (
          <div className="grid h-48 place-items-center rounded-2xl bg-white/5 text-xs text-muted-foreground">
            No thumbnail
          </div>
        )}
        <p className="text-sm text-muted-foreground">
          {fallbackMessage ||
            (failed
              ? "Interactive Sketchfab embed unavailable for this model."
              : "Load the official Sketchfab viewer to orbit, zoom, and pan before importing.")}
        </p>
        {!failed ? (
          <Button type="button" onClick={() => setEnabled(true)} data-testid="sketchfab-load-viewer">
            Load interactive preview
          </Button>
        ) : (
          <a
            href={`https://sketchfab.com/3d-models/${uid}`}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-[var(--glow)] underline"
            data-testid="sketchfab-open-source"
          >
            Open on Sketchfab
          </a>
        )}
      </div>
    );
  }

  const src = `https://sketchfab.com/models/${encodeURIComponent(uid)}/embed?autostart=1&ui_theme=dark&ui_infos=0&ui_controls=1&ui_stop=0&ui_watermark=0`;

  return (
    <div className="space-y-2" data-testid="sketchfab-embed">
      <div className="relative aspect-video w-full overflow-hidden rounded-2xl border border-white/10 bg-black/40">
        <iframe
          ref={iframeRef}
          title="Sketchfab model preview"
          src={src}
          className="absolute inset-0 h-full w-full"
          allow="autoplay; fullscreen; xr-spatial-tracking"
          allowFullScreen
          loading="lazy"
          onError={() => setFailed(true)}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Official Sketchfab embed — orbit / zoom / pan with their viewer controls. Reset via their UI. Studio does not
        load Three.js on this provider details route.
      </p>
      <Button type="button" size="sm" variant="outline" onClick={() => setEnabled(false)}>
        Unload preview
      </Button>
    </div>
  );
}
