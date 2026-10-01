import { useEffect, useRef, useState } from "react";
import { Bookmark as BookmarkIcon, Highlighter, ListTree, Trash2 } from "lucide-react";
import { currentEntry, type TocEntry } from "./viewer";
import { cn } from "@/lib/utils";
import type { Bookmark, Highlight, HighlightColor } from "./api";
import { Panel } from "@/components/Panel";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ColorFilter, HighlightItem, withColor, type ColorChoice } from "./HighlightList";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The book's title, for the panel's. */
  title: string;
  pdf: boolean;
  /** The table of contents; null while the book is still being read for it. */
  contents: TocEntry[] | null;
  /** The section (EPUB) or page (PDF) being read, to mark the current chapter. */
  place: number;
  bookmarks: Bookmark[];
  highlights: Highlight[];
  onJump: (location: string) => void;
  onRemoveBookmark: (id: string) => void;
  onRecolor: (id: string, color: HighlightColor) => void;
  onRemoveHighlight: (id: string) => void;
  onCopy: (text: string) => void;
}

/** This book's contents, highlights and bookmarks, in reading order. */
export function MarksPanel(props: Props) {
  const { bookmarks, highlights, contents } = props;
  const [tab, setTab] = useState<"contents" | "highlights" | "bookmarks">("contents");
  const current = contents ? currentEntry(contents, props.place) : -1;
  const reading = useRef<HTMLLIElement>(null);
  // Open at the chapter being read.
  useEffect(() => {
    if (!props.open || tab !== "contents") return;
    const frame = requestAnimationFrame(() => reading.current?.scrollIntoView({ block: "center", inline: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [props.open, tab]);
  const [color, setColor] = useState<ColorChoice>("all");
  const shown = withColor(highlights, color);
  return (
    <Panel open={props.open} onOpenChange={props.onOpenChange} title={props.title} description="Contents, highlights and bookmarks">
      <ToggleGroup
        type="single"
        variant="outline"
        value={tab}
        onValueChange={(next) => next && setTab(next as typeof tab)}
        aria-label="Show"
        // Stays put while the list scrolls (the contents open scrolled to the chapter being read).
        className="sticky top-0 z-10 w-full bg-card shadow-[0_6px_6px_-4px_var(--card)]"
      >
        <ToggleGroupItem value="contents" className="flex-1 px-1.5 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
          <ListTree />
          Contents
        </ToggleGroupItem>
        <ToggleGroupItem value="highlights" className="flex-1 px-1.5 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
          <Highlighter />
          Highlights
          {highlights.length > 0 && <span className="text-xs opacity-70">{highlights.length}</span>}
        </ToggleGroupItem>
        <ToggleGroupItem value="bookmarks" className="flex-1 px-1.5 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
          <BookmarkIcon />
          Bookmarks
          {bookmarks.length > 0 && <span className="text-xs opacity-70">{bookmarks.length}</span>}
        </ToggleGroupItem>
      </ToggleGroup>

      {tab === "contents" ? (
        contents === null ? (
          <p className="text-sm text-muted-foreground">Reading the table of contents…</p>
        ) : contents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {props.pdf ? "This PDF has no outline to list." : "This book has no table of contents."}
          </p>
        ) : (
          <ul className="-mx-2 grid" aria-label="Table of contents">
            {contents.map((e, i) => (
              <li key={`${e.location}-${i}`} ref={i === current ? reading : undefined}>
                <button
                  type="button"
                  aria-current={i === current ? "true" : undefined}
                  onClick={() => props.onJump(e.location)}
                  className={cn(
                    "flex w-full items-baseline gap-3 rounded-lg py-2 pr-2 text-left outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring",
                    i === current && "bg-accent",
                  )}
                  style={{ paddingLeft: 8 + Math.min(e.depth, 4) * 16 }}
                >
                  <span
                    className={cn(
                      "line-clamp-2 min-w-0 flex-1",
                      e.depth === 0 ? "text-[15px]" : "text-sm text-muted-foreground",
                      i === current && "font-semibold text-foreground",
                    )}
                  >
                    {e.label}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {e.page ? `p. ${e.page}` : `${Math.round(e.at * 100)}%`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : tab === "highlights" ? (
        highlights.length === 0 ? (
          <p className="text-sm text-muted-foreground">Select text in the book and pick a colour to highlight it.</p>
        ) : (
          <div className="grid gap-3">
            <ColorFilter highlights={highlights} value={color} onChange={setColor} />
            <ul className="-mx-2 grid gap-0.5">
              {shown.map((h) => (
                <HighlightItem
                  key={h.id}
                  highlight={h}
                  onOpen={() => props.onJump(h.location)}
                  onRecolor={(c) => props.onRecolor(h.id, c)}
                  onRemove={() => props.onRemoveHighlight(h.id)}
                  onCopy={() => props.onCopy(h.text)}
                />
              ))}
            </ul>
          </div>
        )
      ) : bookmarks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Tap <BookmarkIcon className="inline size-4 align-text-bottom" /> to bookmark where you are.
        </p>
      ) : (
        <ul className="-mx-2 grid">
          {bookmarks.map((b) => (
            <li key={b.id} className="flex items-center gap-1">
              <Button variant="ghost" className="min-w-0 flex-1 justify-start font-normal" onClick={() => props.onJump(b.location)}>
                <BookmarkIcon className="text-muted-foreground" />
                <span className="truncate">{b.label}</span>
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                aria-label={`Delete bookmark ${b.label}`}
                onClick={() => props.onRemoveBookmark(b.id)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
