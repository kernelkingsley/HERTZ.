import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/** Only one Studio audio audition plays at a time. */
let activeAudio = null;

/**
 * Lazy-loaded audio audition. Disposes the Audio element on unmount.
 * One active audition across the app.
 */
export default function AudioPreview({ asset }) {
  const audioRef = useRef(null);
  const [error, setError] = useState("");
  const [duration, setDuration] = useState(null);

  useEffect(() => {
    return () => {
      const el = audioRef.current;
      if (el) {
        if (activeAudio === el) activeAudio = null;
        el.pause();
        el.removeAttribute("src");
        el.load();
      }
    };
  }, []);

  if (!asset?.preview?.url) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="audio-preview-deferred">
        Audio clip indexed ({asset?.fileFormat}). Waveform preview deferred; Unity import uses the private source blob.
      </p>
    );
  }

  return (
    <div className="space-y-2" data-testid="audio-preview">
      <audio
        ref={audioRef}
        src={asset.preview.url}
        preload="metadata"
        controls
        className="w-full"
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onPlay={(e) => {
          const el = e.currentTarget;
          if (activeAudio && activeAudio !== el) {
            try {
              activeAudio.pause();
            } catch {
              /* ignore */
            }
          }
          activeAudio = el;
        }}
      />
      {duration != null && Number.isFinite(duration) ? (
        <p className="text-xs text-muted-foreground">Duration: {duration.toFixed(2)}s</p>
      ) : null}
      {error ? <p className="error text-xs">{error}</p> : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          try {
            audioRef.current?.pause();
            if (activeAudio === audioRef.current) activeAudio = null;
          } catch (err) {
            setError(err.message);
          }
        }}
      >
        Stop
      </Button>
    </div>
  );
}
