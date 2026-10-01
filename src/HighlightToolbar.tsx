import { useLayoutEffect, useRef, useState } from "react";
import { Check, Copy, Trash2 } from "lucide-react";
import type { HighlightColor } from "./api";
import { SWATCHES, type Rect } from "./highlights";
import { useMedia } from "@/hooks/useMedia";
import { cn } from "@/lib/utils";

interface Props {
  /** The text it acts on, in viewport pixels. */
  rect: Rect;
  /** The colour of the highlight being edited; none while offering a new one. */
  current?: HighlightColor;
  onPick: (color: HighlightColor) => void;
  onCopy: () => void;
  onRemove?: () => void;
}

const GAP = 10;
/** Room for the selection handles a touch screen draws under the text. */
const HANDLES = 30;

/**
 * Colours for selected text, or for a highlight that was tapped. Floats next to the text: on
 * touch screens below it, clear of the system's own selection menu above.
 */
export function HighlightToolbar({ rect, current, onPick, onCopy, onRemove }: Props) {
  const touch = useMedia("(pointer: coarse)");
  const bar = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number }>();
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const room = { top: 64, bottom: window.innerHeight - 16 };
    const above = rect.top - GAP - height;
    const below = rect.bottom + (touch && !current ? HANDLES : GAP);
    let top = touch ? below : above;
    if (top < room.top) top = below;
    if (top + height > room.bottom) top = above >= room.top ? above : Math.min(room.bottom - height, Math.max(room.top, rect.top + GAP));
    const center = (rect.left + rect.right) / 2;
    const left = Math.min(Math.max(8, center - width / 2), window.innerWidth - width - 8);
    setPlace({ top, left });
  }, [rect, touch]);

  // Buttons act without taking focus, so the selection they act on stays selected.
  const keep = (e: React.PointerEvent | React.MouseEvent) => e.preventDefault();
  return (
    <div
      ref={bar}
      role="toolbar"
      aria-label={current ? "Highlight" : "Highlight selection"}
      className={cn(
        "fixed z-40 flex items-center gap-1 rounded-full border bg-popover p-1 text-popover-foreground shadow-lg transition-opacity",
        !place && "opacity-0",
      )}
      style={place}
      onPointerDown={keep}
      onMouseDown={keep}
    >
      {SWATCHES.map((s) => (
        <button
          key={s.id}
          type="button"
          className="grid size-9 place-items-center rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
          aria-label={`${s.name}${current === s.id ? " (current)" : ""}`}
          aria-pressed={current === s.id}
          onClick={() => onPick(s.id)}
        >
          <span
            className="grid size-6 place-items-center rounded-full ring-1 ring-black/10 ring-inset"
            style={{ background: s.solid }}
          >
            {current === s.id && <Check className="size-4 text-black/70" strokeWidth={3} />}
          </span>
        </button>
      ))}
      <span className="mx-0.5 h-6 w-px bg-border" aria-hidden="true" />
      <button
        type="button"
        className="grid size-9 place-items-center rounded-full text-muted-foreground outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring"
        aria-label="Copy text"
        onClick={onCopy}
      >
        <Copy className="size-[18px]" />
      </button>
      {onRemove && (
        <button
          type="button"
          className="grid size-9 place-items-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-destructive focus-visible:ring-[3px] focus-visible:ring-ring"
          aria-label="Remove highlight"
          onClick={onRemove}
        >
          <Trash2 className="size-[18px]" />
        </button>
      )}
    </div>
  );
}
