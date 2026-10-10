import type { Book, Collection } from "./api";
import { fold } from "./format";

export type Section = "all" | "reading" | "favorites" | "finished" | "unread";

/**
 * Tags are stored as collections (`collection` and `member` records), so they sync with
 * versions that call them that. The tags (ids) still in the library, in the library's order.
 */
export const pickedTags = (ids: string[], tags: Collection[]) => tags.filter((t) => ids.includes(t.id));

/** A book in the section, with every one of the tags. */
export const inView = (book: Book, section: Section, tags: Collection[]) =>
  inSection(book, section) && tags.every((t) => t.books.includes(book.id));

export type Sort = "recent" | "title" | "author" | "added" | "progress";

export const SECTIONS: { id: Section; name: string; empty: string }[] = [
  { id: "all", name: "All books", empty: "" },
  { id: "reading", name: "Reading", empty: "Books you've started and haven't finished show up here." },
  { id: "favorites", name: "Favorites", empty: "Star a book from its ⋯ menu, or from the reader, to keep it here." },
  {
    id: "finished",
    name: "Finished",
    empty: "Books you read to the end show up here. You can also mark one as finished from its ⋯ menu.",
  },
  { id: "unread", name: "Not started", empty: "You've opened every book in your library." },
];

export const SORTS: { id: Sort; name: string }[] = [
  { id: "recent", name: "Recently read" },
  { id: "title", name: "Title" },
  { id: "author", name: "Author" },
  { id: "added", name: "Date added" },
  { id: "progress", name: "Progress" },
];

export function inSection(book: Book, section: Section): boolean {
  switch (section) {
    case "all":
      return true;
    case "reading":
      return !!book.progress && !book.finishedAt;
    case "favorites":
      return book.favorite;
    case "finished":
      return !!book.finishedAt;
    case "unread":
      return !book.progress && !book.finishedAt;
  }
}

export const counts = (books: Book[]) =>
  Object.fromEntries(SECTIONS.map((s) => [s.id, books.filter((b) => inSection(b, s.id)).length])) as Record<Section, number>;

const recent = (b: Book) => b.progress?.updatedAt ?? b.addedAt;
const byTitle = (a: Book, b: Book) => a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true });

export function sortBooks(books: Book[], sort: Sort): Book[] {
  const list = [...books];
  switch (sort) {
    case "recent":
      return list.sort((a, b) => recent(b) - recent(a));
    case "title":
      return list.sort(byTitle);
    case "author":
      // Books without an author go last.
      return list.sort((a, b) =>
        a.author && b.author
          ? a.author.localeCompare(b.author, undefined, { sensitivity: "base" }) || byTitle(a, b)
          : a.author
            ? -1
            : b.author
              ? 1
              : byTitle(a, b),
      );
    case "added":
      return list.sort((a, b) => b.addedAt - a.addedAt);
    case "progress":
      // Finished books count as all the way through.
      return list.sort(
        (a, b) => (b.finishedAt ? 1 : (b.progress?.fraction ?? 0)) - (a.finishedAt ? 1 : (a.progress?.fraction ?? 0)) || recent(b) - recent(a),
      );
  }
}

/** Every word must appear in the title or the author. */
export function matches(book: Book, query: string): boolean {
  const haystack = fold(`${book.title} ${book.author ?? ""}`);
  return fold(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/** The book to pick up again: the last one read that isn't finished. */
export function continueReading(books: Book[]): Book | undefined {
  return sortBooks(
    books.filter((b) => b.progress && !b.finishedAt && b.available),
    "recent",
  )[0];
}

export interface LibraryView {
  section: Section;
  /** Ids of the tags a book must all have to show. */
  tags: string[];
  sort: Sort;
}

const KEY = "reader:library-view";

export function loadView(): LibraryView {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as
      | (Partial<Omit<LibraryView, "section">> & { section?: string })
      | null;
    // Before tags, a collection was shown on its own as the section `c:<id>`.
    const old = typeof saved?.section === "string" && saved.section.startsWith("c:") ? [saved.section.slice(2)] : [];
    const tags = Array.isArray(saved?.tags) ? saved.tags.filter((t): t is string => typeof t === "string") : old;
    return {
      section: SECTIONS.find((s) => s.id === saved?.section)?.id ?? "all",
      // Tags are checked against the library once it's loaded.
      tags,
      sort: SORTS.find((s) => s.id === saved?.sort)?.id ?? "recent",
    };
  } catch {
    return { section: "all", tags: [], sort: "recent" };
  }
}

export function saveView(view: LibraryView) {
  try {
    localStorage.setItem(KEY, JSON.stringify(view));
  } catch {}
}
