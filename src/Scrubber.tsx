import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  /** Position in the whole book, 0–1; null until the book's layout is known. */
  fraction: number | null;
  /** The reader is dragging to `fraction`; `final` when the pointer is released. */
  onDrag: (fraction: number, final: boolean) => void;
  /** Changes whenever the book scrolls, to show the thumb for a moment. */
  activity: number;
  /** A chapter is loading for this position: hold the thumb there and say so. */
  pending: number | null;
}

const THUMB = 40;
const clamp = (n: number) => Math.min(1, Math.max(0, n));

/**
 * A scrollbar for the whole book. epub.js only keeps nearby chapters loaded, so the native
 * scrollbar would measure a few chapters, not the book. Behaves like a native one: grabbing
 * the thumb doesn't move it, clicking the track jumps there, and the page follows the drag.
 */
export function Scrubber({ fraction, onDrag, activity, pending }: Props) {
  const track = useRef<HTMLDivElement>(null);
  const grab = useRef(THUMB / 2);
  const [drag, setDrag] = useState<number | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!activity) return;
    setVisible(true);
    const hide = setTimeout(() => setVisible(false), 1200);
    return () => clearTimeout(hide);
  }, [activity]);

  if (fraction === null) return null;
  const at = drag ?? pending ?? fraction;
  const busy = pending !== null;
  const rect = () => track.current!.getBoundingClientRect();
  const toFraction = (clientY: number) => {
    const r = rect();
    return clamp((clientY - r.top - grab.current) / (r.height - THUMB));
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
        visible || drag !== null || busy ? "opacity-100" : "opacity-0 hover:opacity-100",
      )}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const r = rect();
        const top = at * (r.height - THUMB);
        const y = e.clientY - r.top;
        // On the thumb: keep it under the pointer. On the track: centre it there and jump.
        grab.current = y >= top && y <= top + THUMB ? y - top : THUMB / 2;
        const f = toFraction(e.clientY);
        setDrag(f);
        onDrag(f, false);
      }}
      onPointerMove={(e) => {
        if (drag === null) return;
        const f = toFraction(e.clientY);
        setDrag(f);
        onDrag(f, false);
      }}
      onPointerUp={() => {
        if (drag !== null) onDrag(drag, true);
        setDrag(null);
      }}
      onPointerCancel={() => {
        if (drag !== null) onDrag(drag, true);
        setDrag(null);
      }}
    >
      <div
        className={cn(
          "absolute right-1 w-1.5 rounded-full bg-muted-foreground/60 transition-[width] group-hover:w-2",
          (drag !== null || busy) && "w-2 bg-primary",
        )}
        style={{ height: THUMB, top: `calc(${at} * (100% - ${THUMB}px))` }}
      />
      {(drag !== null || busy) && (
        <span
          className="absolute right-5 flex -translate-y-1/2 items-center gap-1.5 rounded-full bg-foreground/85 px-2.5 py-1 text-xs font-medium whitespace-nowrap text-background tabular-nums shadow"
          style={{ top: `calc(${at} * (100% - ${THUMB}px) + ${THUMB / 2}px)` }}
        >
          {busy && <LoaderCircle className="size-3.5 animate-spin" aria-label="Loading" />}
          {Math.round(at * 100)}%
        </span>
      )}
    </div>
  );
}
