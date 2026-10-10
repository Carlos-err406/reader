import { useState } from "react";
import { Check, Minus, Plus, Tag } from "lucide-react";
import { api, message, type Book, type Collection } from "./api";
import { Panel } from "@/components/Panel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  /** The books being filed; the sheet is open while there are any. */
  books: Book[];
  onClose: () => void;
  tags: Collection[];
  /** After any change, so the library shows it. */
  onChanged: () => void;
}

/**
 * Tags books or untags them, and makes new tags on the spot. With several books, a tag on only
 * some of them shows a dash; tapping it tags the rest. (Tags are stored as collections.)
 */
export function TagsSheet({ books, onClose, tags, onChanged }: Props) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const run = async (work: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await work();
    } catch (e) {
      setError(message(e));
    }
    onChanged();
  };
  const inside = (c: Collection) => books.filter((b) => c.books.includes(b.id)).length;
  const toggle = (c: Collection) => {
    const all = inside(c) === books.length;
    void run(async () => {
      for (const b of books) if (all || !c.books.includes(b.id)) await api.setInCollection(c.id, b.id, !all);
    });
  };
  const create = () =>
    void run(async () => {
      const made = await api.createCollection(name);
      for (const b of books) await api.setInCollection(made.id, b.id, true);
      setName("");
    });
  const subject = books.length === 1 ? books[0]!.title : `${books.length} books`;

  return (
    <Panel open={books.length > 0} onOpenChange={(open) => !open && onClose()} title="Tags" description={`Tags for ${subject}`}>
      {books.length > 0 && <p className="truncate text-sm text-muted-foreground">{subject}</p>}
      {tags.length > 0 ? (
        <ul className="-mx-2 grid gap-0.5" aria-label="Tags">
          {tags.map((c) => {
            const count = inside(c);
            const state = count === 0 ? false : count === books.length ? true : "mixed";
            return (
              <li key={c.id}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={state}
                  onClick={() => toggle(c)}
                  className="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring"
                >
                  <span
                    className={cn(
                      "grid size-5 shrink-0 place-items-center rounded-md border",
                      state && "border-primary bg-primary text-primary-foreground",
                    )}
                  >
                    {state === true && <Check className="size-3.5" strokeWidth={3} />}
                    {state === "mixed" && <Minus className="size-3.5" strokeWidth={3} />}
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
          Tags group books however you like: a series, a course, books to lend. A book can have several, and the library can show the books with all the tags you pick.
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
          placeholder="New tag"
          aria-label="New tag name"
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
