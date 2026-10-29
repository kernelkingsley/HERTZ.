import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Accessible full-resolution image lightbox: zoom/pan/fit/reset/fullscreen,
 * Escape/backdrop close, Open original when verified, load-error fallback.
 */
export default function ImageLightbox({
  open,
  src,
  alt = "",
  originalUrl = null,
  onClose,
}) {
  const titleId = useId();
  const dialogRef = useRef(null);
  const imgRef = useRef(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef(null);
  const [loadError, setLoadError] = useState("");
  const [fit, setFit] = useState(true);

  const resetView = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
    setFit(true);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    resetView();
    setLoadError("");
    const prev = document.activeElement;
    dialogRef.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (prev && typeof prev.focus === "function") prev.focus();
    };
  }, [open, onClose, resetView, src]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 p-4"
      role="presentation"
      data-testid="image-lightbox"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative flex max-h-[92vh] w-full max-w-5xl flex-col gap-3 rounded-2xl border border-white/10 bg-[#12151b] p-4 shadow-2xl outline-none"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id={titleId} className="text-sm font-medium">
            {alt || "Full image"}
          </h2>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => setScale((s) => Math.min(8, s * 1.25))} data-testid="lightbox-zoom-in">
              Zoom in
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setScale((s) => Math.max(0.25, s / 1.25))} data-testid="lightbox-zoom-out">
              Zoom out
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setFit(true);
                setScale(1);
                setOffset({ x: 0, y: 0 });
              }}
              data-testid="lightbox-fit"
            >
              Fit
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={resetView} data-testid="lightbox-reset">
              Reset
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="lightbox-fullscreen"
              onClick={() => {
                const el = dialogRef.current;
                if (!el) return;
                if (document.fullscreenElement) document.exitFullscreen?.();
                else el.requestFullscreen?.();
              }}
            >
              Fullscreen
            </Button>
            {originalUrl ? (
              <a
                href={originalUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 items-center rounded-md border border-white/10 px-3 text-xs"
                data-testid="lightbox-open-original"
              >
                Open original
              </a>
            ) : null}
            <Button type="button" size="sm" onClick={onClose} data-testid="lightbox-close">
              Close
            </Button>
          </div>
        </div>

        <div
          className="relative min-h-[40vh] flex-1 overflow-hidden rounded-xl bg-black/40"
          onWheel={(e) => {
            e.preventDefault();
            setFit(false);
            setScale((s) => Math.min(8, Math.max(0.25, s * (e.deltaY < 0 ? 1.1 : 0.9))));
          }}
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            setDragging(true);
            dragStart.current = { x: e.clientX - offset.x, y: e.clientY - offset.y };
          }}
          onMouseMove={(e) => {
            if (!dragging || !dragStart.current) return;
            setFit(false);
            setOffset({ x: e.clientX - dragStart.current.x, y: e.clientY - dragStart.current.y });
          }}
          onMouseUp={() => {
            setDragging(false);
            dragStart.current = null;
          }}
          onMouseLeave={() => {
            setDragging(false);
            dragStart.current = null;
          }}
        >
          {loadError ? (
            <div className="grid h-full place-items-center p-6 text-center text-sm text-muted-foreground" data-testid="lightbox-error">
              <p>{loadError}</p>
              <p className="mt-2">Try Open original, or reopen the provider page.</p>
            </div>
          ) : (
            <img
              ref={imgRef}
              src={src}
              alt={alt}
              loading="lazy"
              decoding="async"
              draggable={false}
              className="pointer-events-none mx-auto max-h-[70vh] select-none"
              style={{
                objectFit: fit ? "contain" : "none",
                width: fit ? "100%" : undefined,
                height: fit ? "100%" : undefined,
                transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
                transformOrigin: "center center",
              }}
              onError={() => setLoadError("Could not load the full-resolution image.")}
              data-testid="lightbox-image"
            />
          )}
        </div>
      </div>
    </div>
  );
}
