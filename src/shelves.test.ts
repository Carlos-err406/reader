import { describe, expect, it, vi } from "vitest";
import type { Book } from "./api";
import { continueReading, counts, inSection, inView, loadView, matches, pickedTags, sortBooks } from "./shelves";

const book = (patch: Partial<Book>): Book => ({
  id: patch.title ?? "x",
  title: "Untitled",
  author: null,
  format: "epub",
  size: 1,
  addedAt: 1,
  available: true,
  progress: null,
  cover: null,
  favorite: false,
  finishedAt: null,
  customCover: null,
  ...patch,
});
const read = (fraction: number, updatedAt: number) => ({ location: "x", label: "x", fraction, updatedAt });

const dune = book({ title: "Dune", author: "Frank Herbert", addedAt: 3, progress: read(0.6, 50), favorite: true });
const emma = book({ title: "Emma", author: "Jane Austen", addedAt: 2, progress: read(1, 40), finishedAt: 40 });
const codigo = book({ title: "El código Da Vinci", author: "Dan Brown", addedAt: 5 });
const notes = book({ title: "notes 10", addedAt: 4, progress: read(0.1, 60), available: false });
const notes2 = book({ title: "notes 9", addedAt: 6 });
const all = [dune, emma, codigo, notes, notes2];

describe("library sections", () => {
  it("sort books into reading, finished, not started and favorites", () => {
    expect(all.filter((b) => inSection(b, "reading"))).toEqual([dune, notes]);
    expect(all.filter((b) => inSection(b, "finished"))).toEqual([emma]);
    expect(all.filter((b) => inSection(b, "unread"))).toEqual([codigo, notes2]);
    expect(counts(all)).toEqual({ all: 5, reading: 2, favorites: 1, finished: 1, unread: 2 });
  });

  it("continue with the last book read that's unfinished and on this device", () => {
    expect(continueReading(all)).toBe(dune);
  });

  it("search titles and authors, ignoring case and accents", () => {
    expect(all.filter((b) => matches(b, "codigo"))).toEqual([codigo]);
    expect(all.filter((b) => matches(b, "austen emma"))).toEqual([emma]);
    expect(all.filter((b) => matches(b, "  "))).toEqual(all);
  });

  it("sort by title naturally, authors before unknown ones, and progress with finished first", () => {
    expect(sortBooks(all, "title").map((b) => b.title)).toEqual(["Dune", "El código Da Vinci", "Emma", "notes 9", "notes 10"]);
    expect(sortBooks(all, "author").map((b) => b.title)).toEqual(["El código Da Vinci", "Dune", "Emma", "notes 9", "notes 10"]);
    expect(sortBooks(all, "progress")[0]).toBe(emma);
    expect(sortBooks(all, "recent").map((b) => b.title)).toEqual(["notes 10", "Dune", "Emma", "notes 9", "El código Da Vinci"]);
    expect(sortBooks(all, "added")[0]).toBe(notes2);
  });
});

describe("tags", () => {
  const scifi = { id: "s", name: "Sci-fi", createdAt: 1, books: [dune.id, notes.id] };
  const classic = { id: "c", name: "Classic", createdAt: 1, books: [dune.id, emma.id] };
  const tags = [classic, scifi];

  it("show the books with every tag picked, within the section", () => {
    expect(all.filter((b) => inView(b, "all", [scifi]))).toEqual([dune, notes]);
    expect(all.filter((b) => inView(b, "all", [scifi, classic]))).toEqual([dune]);
    expect(all.filter((b) => inView(b, "finished", [classic]))).toEqual([emma]);
    expect(all.filter((b) => inView(b, "unread", []))).toEqual([codigo, notes2]);
  });

  it("leave out tags that were deleted", () => {
    expect(pickedTags(["s", "gone"], tags)).toEqual([scifi]);
    expect(pickedTags([], tags)).toEqual([]);
  });

  it("carry over a collection that was open before tags", () => {
    const view = (saved: unknown) => {
      vi.stubGlobal("localStorage", { getItem: () => JSON.stringify(saved) });
      return loadView();
    };
    expect(view({ section: "c:s", sort: "title" })).toEqual({ section: "all", tags: ["s"], sort: "title" });
    expect(view({ section: "reading", tags: ["s", "c", 3] })).toEqual({ section: "reading", tags: ["s", "c"], sort: "recent" });
    expect(view({ section: "nope", tags: "s" })).toEqual({ section: "all", tags: [], sort: "recent" });
    vi.unstubAllGlobals();
  });
});
