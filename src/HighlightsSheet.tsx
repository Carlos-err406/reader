import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { api, message, onChanged, type Book, type Highlight, type HighlightColor } from "./api";
import { Panel } from "@/components/Panel";
import { ColorFilter, HighlightItem, withColor, type ColorChoice } from "./HighlightList";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The library, most recently read first; highlights are grouped in this order. */
  books: Book[];
  onOpen: (book: Book, location: string) => void;
}

/** Ignores case and accents, so "codigo" finds "Código". */
const fold = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** Every highlight in the library, searchable, grouped by book. */
export function HighlightsSheet({ open, onOpenChange, books, onOpen }: Props) {
  const [highlights, setHighlights] = useState<Highlight[]>();
  const [query, setQuery] = useState("");
  const [color, setColor] = useState<ColorChoice>("all");
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    if (!open) return;
    const load = () => api.highlights().then(setHighlights, (e) => setNotice(message(e)));
    void load();
    const unlisten = onChanged((changed) => changed.some((c) => c.kind === "highlight" || c.kind === "book") && void load());
    return () => void unlisten.then((f) => f());
  }, [open]);
  useEffect(() => {
    if (!notice) return;
    const hide = setTimeout(() => setNotice(undefined), 2000);
    return () => clearTimeout(hide);
  }, [notice]);

  const groups = useMemo(() => {
    const words = fold(query).split(/\s+/).filter(Boolean);
    const titles = new Map(books.map((b) => [b.id, fold(`${b.title} ${b.author ?? ""}`)]));
    const matching = withColor(highlights ?? [], color).filter((h) => {
      const haystack = `${fold(h.text)} ${titles.get(h.bookId) ?? ""}`;
      return words.every((w) => haystack.includes(w));
    });
    return books
      .map((book) => ({ book, items: matching.filter((h) => h.bookId === book.id) }))
      .filter((g) => g.items.length > 0);
  }, [highlights, books, query, color]);

  const act = (work: Promise<unknown>) =>
    void work.then(
      () => api.highlights().then(setHighlights),
      (e) => setNotice(message(e)),
    );
  const recolor = (id: string, c: HighlightColor) => act(api.recolorHighlight(id, c));
  const remove = (id: string) => act(api.removeHighlight(id));
  const copy = (text: string) =>
    void navigator.clipboard.writeText(text).then(
      () => setNotice("Copied"),
      () => setNotice("Couldn't copy the text"),
    );

  const all = highlights ?? [];
  return (
    <Panel open={open} onOpenChange={onOpenChange} title="Highlights" description="Highlights across every book in the library">
      {all.length > 0 && (
        <div className="grid gap-3">
          <label className="flex h-10 items-center gap-2 rounded-md border bg-background px-3 focus-within:ring-[3px] focus-within:ring-ring/50">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search highlights"
              aria-label="Search highlights"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </label>
          <ColorFilter highlights={all} value={color} onChange={setColor} />
        </div>
      )}
      <p className="text-sm text-muted-foreground empty:hidden" role="status">
        {notice}
      </p>
      {highlights === undefined ? null : all.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No highlights yet. While reading, select text and pick a colour to highlight it.
        </p>
      ) : groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">No highlights match.</p>
      ) : (
        groups.map(({ book, items }) => (
          <section key={book.id} className="grid gap-1" aria-label={book.title}>
            <h3 className="flex items-baseline gap-2">
              <span className="min-w-0 truncate font-serif text-base font-semibold">{book.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{items.length}</span>
            </h3>
            {!book.available && (
              <p className="text-xs text-muted-foreground">This book is still downloading to this device.</p>
            )}
            <ul className="-mx-2 grid gap-0.5">
              {items.map((h) => (
                <HighlightItem
                  key={h.id}
                  highlight={h}
                  onOpen={book.available ? () => onOpen(book, h.location) : undefined}
                  onRecolor={(c) => recolor(h.id, c)}
                  onRemove={() => remove(h.id)}
                  onCopy={() => copy(h.text)}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </Panel>
  );
}
