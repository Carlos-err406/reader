import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface Props {
  /** Position in the whole book, 0–1; null until the location index is ready. */
  fraction: number | null;
  onSeek: (fraction: number) => void;
  /** The book is scrolling: show the thumb for a moment. */
  activity: number;
}

const THUMB = 40;
const clamp = (n: number) => Math.min(1, Math.max(0, n));

/**
 * A book-wide scrollbar for reflowable books. epub.js only keeps the chapters around the
 * reader loaded, so the native scrollbar would measure a few chapters, not the book.
 */
export function Scrubber({ fraction, onSeek, activity }: Props) {
  const track = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!activity) return;
    setVisible(true);
    const hide = setTimeout(() => setVisible(false), 1200);
    return () => clearTimeout(hide);
  }, [activity]);

  if (fraction === null) return null;
  const at = drag ?? fraction;
  const position = (clientY: number) => {
    const rect = track.current!.getBoundingClientRect();
    return clamp((clientY - rect.top - THUMB / 2) / (rect.height - THUMB));
  };

  return (
    <div
      ref={track}
      role="slider"
      aria-label="Position in book"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(at * 100)}
      tabIndex={-1}
      className={cn(
        "group absolute top-16 right-0 bottom-20 z-10 w-5 cursor-pointer touch-none select-none transition-opacity duration-300",
        visible || drag !== null ? "opacity-100" : "opacity-0 hover:opacity-100",
      )}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag(position(e.clientY));
      }}
      onPointerMove={(e) => drag !== null && setDrag(position(e.clientY))}
      onPointerUp={() => {
        if (drag !== null) onSeek(drag);
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}
    >
      <div
        className={cn(
          "absolute right-1 w-1.5 rounded-full bg-muted-foreground/60 transition-[width] group-hover:w-2",
          drag !== null && "w-2 bg-primary",
        )}
        style={{ height: THUMB, top: `calc(${at} * (100% - ${THUMB}px))` }}
      />
      {drag !== null && (
        <span
          className="absolute right-5 -translate-y-1/2 rounded-full bg-foreground/85 px-2.5 py-1 text-xs font-medium whitespace-nowrap text-background tabular-nums shadow"
          style={{ top: `calc(${at} * (100% - ${THUMB}px) + ${THUMB / 2}px)` }}
        >
          {Math.round(at * 100)}%
        </span>
      )}
    </div>
  );
}
