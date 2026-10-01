import { useEffect, useState } from "react";
import { Star } from "lucide-react";
import type { Book } from "./api";
import { cachedCover, loadCover, makeCover } from "./covers";
import { cn } from "@/lib/utils";

const hue = (id: string) => parseInt(id.slice(0, 6), 16) % 360;

const frameFor = (large: boolean) =>
  cn(
    "shrink-0 overflow-hidden rounded-[3px_6px_6px_3px] shadow-[0_1px_4px_rgba(0,0,0,0.25)]",
    large ? "h-[150px] w-[100px]" : "h-[108px] w-[72px]",
  );

/** The book's cover (chosen, or drawn from its file once rendered); without one, a title card. */
export function Cover({ book, large = false }: { book: Book; large?: boolean }) {
  const [url, setUrl] = useState(() => cachedCover(book));
  useEffect(() => {
    let live = true;
    setUrl(cachedCover(book));
    if (book.cover === true) void loadCover(book).then((u) => live && setUrl(u));
    // Rendered here the first time: books imported elsewhere arrive without one.
    else if (book.cover === null && book.available) void makeCover(book).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [book.id, book.cover, book.available, book.customCover]);

  if (url) return <img src={url} alt="" className={cn(frameFor(large), "object-cover")} />;
  return <TitleCard book={book} large={large} />;
}

/** A coloured card with the title, for books without a cover. */
export function TitleCard({ book, large = false }: { book: Pick<Book, "id" | "title" | "format">; large?: boolean }) {
  return (
    <div
      className={cn(
        frameFor(large),
        "flex flex-col justify-between p-2 text-white shadow-[inset_4px_0_0_rgba(0,0,0,0.18),0_1px_4px_rgba(0,0,0,0.25)]",
      )}
      style={{ background: `hsl(${hue(book.id)} 35% 38%)` }}
    >
      <span className="line-clamp-5 font-serif text-[0.65rem] leading-tight">{book.title}</span>
      <em className="text-[0.55rem] tracking-widest not-italic opacity-80">{book.format.toUpperCase()}</em>
    </div>
  );
}

/** The cover, with a star on favorites. */
export function BadgedCover({ book, large }: { book: Book; large?: boolean }) {
  return (
    <span className="relative block shrink-0 self-start">
      <Cover book={book} large={large} />
      {book.favorite && (
        <span className="absolute -top-1.5 -right-1.5 grid size-6 place-items-center rounded-full bg-card shadow-sm">
          <Star className="size-3.5 fill-amber-400 text-amber-500" aria-label="Favorite" />
        </span>
      )}
    </span>
  );
}

export { frameFor as coverFrame };
