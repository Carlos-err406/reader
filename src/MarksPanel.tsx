import { useState } from "react";
import { Bookmark as BookmarkIcon, Highlighter, Trash2 } from "lucide-react";
import type { Bookmark, Highlight, HighlightColor } from "./api";
import { Panel } from "@/components/Panel";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ColorFilter, HighlightItem, withColor, type ColorChoice } from "./HighlightList";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bookmarks: Bookmark[];
  highlights: Highlight[];
  onJump: (location: string) => void;
  onRemoveBookmark: (id: string) => void;
  onRecolor: (id: string, color: HighlightColor) => void;
  onRemoveHighlight: (id: string) => void;
  onCopy: (text: string) => void;
}

/** This book's highlights and bookmarks, in reading order. */
export function MarksPanel(props: Props) {
  const { bookmarks, highlights } = props;
  const [tab, setTab] = useState<"highlights" | "bookmarks">("highlights");
  const [color, setColor] = useState<ColorChoice>("all");
  const shown = withColor(highlights, color);
  return (
    <Panel open={props.open} onOpenChange={props.onOpenChange} title="Notes" description="This book's highlights and bookmarks">
      <ToggleGroup
        type="single"
        variant="outline"
        value={tab}
        onValueChange={(next) => next && setTab(next as typeof tab)}
        aria-label="Show"
        className="w-full"
      >
        <ToggleGroupItem value="highlights" className="flex-1 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
          <Highlighter />
          Highlights{highlights.length > 0 && ` (${highlights.length})`}
        </ToggleGroupItem>
        <ToggleGroupItem value="bookmarks" className="flex-1 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
          <BookmarkIcon />
          Bookmarks{bookmarks.length > 0 && ` (${bookmarks.length})`}
        </ToggleGroupItem>
      </ToggleGroup>

      {tab === "highlights" ? (
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
