import { useState } from "react";
import { Check, Plus, Tag } from "lucide-react";
import { api, message, type Book, type Collection } from "./api";
import { Panel } from "@/components/Panel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  /** The book being filed; the sheet is open while there is one. */
  book: Book | undefined;
  onClose: () => void;
  collections: Collection[];
  /** After any change, so the library shows it. */
  onChanged: () => void;
}

/** Puts one book in or out of collections, and makes new ones on the spot. */
export function CollectionsSheet({ book, onClose, collections, onChanged }: Props) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const run = async (work: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await work();
      onChanged();
    } catch (e) {
      setError(message(e));
    }
  };
  const toggle = (c: Collection) => book && void run(() => api.setInCollection(c.id, book.id, !c.books.includes(book.id)));
  const create = () =>
    book &&
    void run(async () => {
      const made = await api.createCollection(name);
      await api.setInCollection(made.id, book.id, true);
      setName("");
    });

  return (
    <Panel
      open={!!book}
      onOpenChange={(open) => !open && onClose()}
      title="Collections"
      description={`Collections for ${book?.title ?? "this book"}`}
    >
      {book && <p className="truncate text-sm text-muted-foreground">{book.title}</p>}
      {collections.length > 0 ? (
        <ul className="-mx-2 grid gap-0.5" aria-label="Collections">
          {collections.map((c) => {
            const on = !!book && c.books.includes(book.id);
            return (
              <li key={c.id}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => toggle(c)}
                  className="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring"
                >
                  <span
                    className={cn(
                      "grid size-5 shrink-0 place-items-center rounded-md border",
                      on && "border-primary bg-primary text-primary-foreground",
                    )}
                  >
                    {on && <Check className="size-3.5" strokeWidth={3} />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{c.books.length}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          <Tag className="mr-1 inline size-4 align-text-bottom" />
          Collections group books however you like: a series, a course, books to lend. A book can be in several.
        </p>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <input
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          placeholder="New collection"
          aria-label="New collection name"
          className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        <Button type="submit" size="sm" className="h-9" disabled={!name.trim()}>
          <Plus />
          Add
        </Button>
      </form>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </Panel>
  );
}
