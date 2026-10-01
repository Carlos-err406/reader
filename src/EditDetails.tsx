import { useEffect, useRef, useState } from "react";
import { ImagePlus, RotateCcw } from "lucide-react";
import { api, message, type Book } from "./api";
import { Cover, coverFrame, TitleCard } from "./BookCover";
import { coverFromImage } from "./covers";
import { Panel } from "@/components/Panel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  /** The book being edited; the sheet is open while there is one. */
  book: Book | undefined;
  onClose: () => void;
  onSaved: () => void;
}

/** A new cover picked, the book's own cover again, or no change to it. */
type CoverChange = { image: Uint8Array; url: string } | "own" | null;

/** Corrects a book's title and author, and chooses its cover. Nothing changes until saved. */
export function EditDetails({ book, onClose, onSaved }: Props) {
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [cover, setCover] = useState<CoverChange>(null);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!book) return;
    setTitle(book.title);
    setAuthor(book.author ?? "");
    setCover(null);
    setError(undefined);
  }, [book]);
  // A picked image's preview is released once replaced or saved.
  useEffect(() => () => void (cover && cover !== "own" && URL.revokeObjectURL(cover.url)), [cover]);

  const choose = async (picked: File | undefined) => {
    if (!picked) return;
    setError(undefined);
    try {
      const image = await coverFromImage(picked);
      setCover({ image, url: URL.createObjectURL(new Blob([image as BlobPart], { type: "image/jpeg" })) });
    } catch (e) {
      setError(message(e));
    }
    if (file.current) file.current.value = "";
  };

  const detailsChanged = !!book && (title.trim() !== book.title || author.trim() !== (book.author ?? ""));
  const save = async () => {
    if (!book) return;
    setSaving(true);
    setError(undefined);
    try {
      if (detailsChanged) await api.editBook(book.id, { title, author });
      if (cover === "own") await api.setBookCover(book.id, new Uint8Array());
      else if (cover) await api.setBookCover(book.id, cover.image);
      onSaved();
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setSaving(false);
    }
  };

  // Going back to the book's own cover: undo a pick, or drop a cover chosen before.
  const canRestore = (cover !== null && cover !== "own") || (!!book?.customCover && cover !== "own");
  const field =
    "h-11 w-full rounded-lg border bg-background px-3 text-base outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

  return (
    <Panel open={!!book} onOpenChange={(open) => !open && onClose()} title="Edit details" description="Title, author and cover">
      {book && (
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="flex items-end gap-4">
            {cover && cover !== "own" ? (
              <img src={cover.url} alt="New cover" className={cn(coverFrame(true), "object-cover")} />
            ) : cover === "own" ? (
              <TitleCard book={{ ...book, title: title.trim() || book.title }} large />
            ) : (
              <Cover book={book} large />
            )}
            <div className="grid justify-items-start gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => file.current?.click()}>
                <ImagePlus />
                Change cover
              </Button>
              {canRestore && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={() => setCover(book.customCover ? "own" : null)}
                >
                  <RotateCcw />
                  Use the book's cover
                </Button>
              )}
              {cover === "own" && <span className="text-xs text-muted-foreground">The book's own cover comes back when you save.</span>}
            </div>
            <input ref={file} type="file" accept="image/*" hidden onChange={(e) => void choose(e.target.files?.[0])} />
          </div>
          <label className="grid gap-1.5">
            <span className="text-sm font-medium">Title</span>
            <input className={field} value={title} maxLength={500} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="grid gap-1.5">
            <span className="text-sm font-medium">Author</span>
            <input className={field} value={author} maxLength={500} placeholder="Unknown" onChange={(e) => setAuthor(e.target.value)} />
          </label>
          <p className="text-xs text-muted-foreground">Changes sync to your other devices.</p>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !title.trim() || (!detailsChanged && cover === null)}>
              Save
            </Button>
          </div>
        </form>
      )}
    </Panel>
  );
}
