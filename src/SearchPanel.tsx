import { useEffect, useRef } from "react";
import { LoaderCircle, Search, X } from "lucide-react";
import { Panel } from "@/components/Panel";
import { cn } from "@/lib/utils";
import { MAX_HITS, type SearchHit } from "./search";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQuery: (query: string) => void;
  hits: SearchHit[];
  /** How much of the book has been searched (0 to 1); 1 when done. */
  done: number;
  /** Which hit is being looked at, or -1. */
  active: number;
  onPick: (index: number) => void;
  /** Where a hit is, for its line under the text: its chapter or page. */
  placeOf: (hit: SearchHit) => string;
}

/** Find a word or phrase in the book: matches listed with the text around them. */
export function SearchPanel({ open, onOpenChange, query, onQuery, hits, done, active, onPick, placeOf }: Props) {
  const current = useRef<HTMLLIElement>(null);
  // Reopened while stepping through matches: show the one being looked at.
  useEffect(() => {
    if (!open || active < 0) return;
    const frame = requestAnimationFrame(() => current.current?.scrollIntoView({ block: "center" }));
    return () => cancelAnimationFrame(frame);
  }, [open, active]);

  const searching = done < 1;
  const typed = query.trim().length >= 2;
  return (
    <Panel open={open} onOpenChange={onOpenChange} title="Search in book" description="Find a word or phrase in this book" focusField>
      <div className="sticky top-0 z-10 grid gap-2 bg-card pb-1 shadow-[0_6px_6px_-4px_var(--card)]">
        <label className="flex h-11 items-center gap-2 rounded-lg border bg-background px-3 focus-within:ring-[3px] focus-within:ring-ring/50">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            type="search"
            enterKeyHint="search"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && hits.length > 0 && onPick(Math.max(0, active))}
            placeholder="Word or phrase"
            aria-label="Search in book"
            className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button type="button" className="text-muted-foreground" aria-label="Clear search" onClick={() => onQuery("")}>
              <X className="size-4" />
            </button>
          )}
        </label>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
          {!typed ? (
            "Case and accents don't matter."
          ) : searching ? (
            <>
              <LoaderCircle className="size-3.5 animate-spin" />
              {hits.length} {hits.length === 1 ? "match" : "matches"} so far · {Math.round(done * 100)}% searched
            </>
          ) : hits.length === 0 ? (
            "No matches."
          ) : (
            `${hits.length}${hits.length >= MAX_HITS ? "+" : ""} ${hits.length === 1 ? "match" : "matches"}`
          )}
        </p>
      </div>
      {hits.length > 0 && (
        <ul className="-mx-2 grid gap-0.5" aria-label="Matches">
          {hits.map((hit, i) => (
            <li key={`${hit.location}-${hit.nth ?? 0}-${i}`} ref={i === active ? current : undefined}>
              <button
                type="button"
                aria-current={i === active ? "true" : undefined}
                onClick={() => onPick(i)}
                className={cn(
                  "grid w-full gap-1 rounded-lg px-2 py-2 text-left outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring",
                  i === active && "bg-accent",
                )}
              >
                <span className="font-serif text-[15px] leading-snug">
                  {hit.excerpt.before}
                  <mark className="rounded-sm bg-amber-300/60 px-0.5 text-inherit dark:bg-amber-500/40">{hit.excerpt.match}</mark>
                  {hit.excerpt.after}
                </span>
                <span className="text-xs text-muted-foreground">{placeOf(hit)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
