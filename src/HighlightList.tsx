import { Copy, EllipsisVertical, Trash2 } from "lucide-react";
import type { Highlight, HighlightColor } from "./api";
import { SWATCHES, swatch } from "./highlights";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

export type ColorChoice = HighlightColor | "all";

interface ItemProps {
  highlight: Highlight;
  /** Opens the book at the highlight; left out when the book isn't on this device yet. */
  onOpen?: () => void;
  onRecolor: (color: HighlightColor) => void;
  onRemove: () => void;
  onCopy: () => void;
}

export function HighlightItem({ highlight, onOpen, onRecolor, onRemove, onCopy }: ItemProps) {
  return (
    <li className="flex items-start gap-1 rounded-lg hover:bg-accent/50">
      <button
        type="button"
        className="flex min-w-0 flex-1 gap-3 rounded-lg px-2 py-2.5 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring disabled:cursor-default"
        onClick={onOpen}
        disabled={!onOpen}
      >
        <span className="w-1 shrink-0 self-stretch rounded-full" style={{ background: swatch(highlight.color).solid }} />
        <span className="min-w-0">
          <span className="line-clamp-4 font-serif text-[15px] leading-snug">{highlight.text}</span>
          <span className="mt-1 block text-xs text-muted-foreground">{highlight.label}</span>
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="mt-2 mr-1 text-muted-foreground" aria-label="Highlight options">
            <EllipsisVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="bg-card">
          <DropdownMenuLabel className="text-xs text-muted-foreground">Colour</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={highlight.color} onValueChange={(c) => onRecolor(c as HighlightColor)}>
            {SWATCHES.map((s) => (
              <DropdownMenuRadioItem key={s.id} value={s.id}>
                <span className="size-3.5 rounded-full ring-1 ring-black/10 ring-inset" style={{ background: s.solid }} />
                {s.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onCopy}>
            <Copy />
            Copy text
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={onRemove}>
            <Trash2 />
            Delete highlight
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/** Narrows a list to one colour. Only colours in use are offered. */
export function ColorFilter({
  highlights,
  value,
  onChange,
}: {
  highlights: Highlight[];
  value: ColorChoice;
  onChange: (value: ColorChoice) => void;
}) {
  const used = SWATCHES.filter((s) => highlights.some((h) => h.color === s.id));
  if (used.length < 2) return null;
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(next) => onChange((next || "all") as ColorChoice)}
      aria-label="Show colour"
      className="flex-wrap gap-1"
    >
      <ToggleGroupItem value="all" className="h-8 rounded-full px-3 text-xs data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
        All
      </ToggleGroupItem>
      {used.map((s) => (
        <ToggleGroupItem
          key={s.id}
          value={s.id}
          aria-label={s.name}
          className={cn("size-8 min-w-8 rounded-full p-0 data-[state=on]:ring-2 data-[state=on]:ring-ring")}
        >
          <span className="size-4 rounded-full ring-1 ring-black/10 ring-inset" style={{ background: s.solid }} />
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export const withColor = (list: Highlight[], color: ColorChoice) =>
  color === "all" ? list : list.filter((h) => h.color === color);
