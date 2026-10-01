/** Searching inside a book: matching that ignores case and accents, and the text around a match. */

/**
 * Text folded for matching (lower case, accents dropped), with where each folded character
 * came from in the original, so a match can be pointed at in the book's own text.
 */
export function foldWithMap(text: string): { folded: string; from: number[] } {
  let folded = "";
  const from: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const piece = text[i]!.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
    for (const c of piece) {
      folded += c;
      from.push(i);
    }
  }
  return { folded, from };
}

/** The query as it's matched: folded, with runs of spaces as one. */
export const foldQuery = (query: string) => foldWithMap(query.trim().replace(/\s+/g, " ")).folded;

/** Where `query` (already folded) occurs in `text`, as [start, end) in the original text. */
export function matches(text: string, query: string): [number, number][] {
  if (!query) return [];
  // Line breaks and other runs of white space match a single space in the query.
  const plain = text.replace(/\s/g, " ");
  const { folded, from } = foldWithMap(plain);
  const out: [number, number][] = [];
  for (let at = folded.indexOf(query); at >= 0; at = folded.indexOf(query, at + query.length)) {
    out.push([from[at]!, from[at + query.length - 1]! + 1]);
  }
  return out;
}

export interface Excerpt {
  before: string;
  match: string;
  after: string;
}

/** The match with some words either side of it, cut at word boundaries. */
export function excerpt(text: string, start: number, end: number, around = 48): Excerpt {
  const squash = (s: string) => s.replace(/\s+/g, " ");
  let from = Math.max(0, start - around);
  let to = Math.min(text.length, end + around);
  if (from > 0) from = text.indexOf(" ", from) + 1 || from;
  if (to < text.length) to = text.lastIndexOf(" ", to) > end ? text.lastIndexOf(" ", to) : to;
  return {
    before: (from > 0 ? "…" : "") + squash(text.slice(from, start)).trimStart(),
    match: squash(text.slice(start, end)),
    after: squash(text.slice(end, to)).trimEnd() + (to < text.length ? "…" : ""),
  };
}

/** A match in the book. */
export interface SearchHit {
  /** Where it is, for `goTo`: an EPUB CFI range, or a PDF page. */
  location: string;
  /** Its section (EPUB) or page (PDF). */
  order: number;
  /** PDFs: which match on its page it is (0 first), to mark it there. */
  nth?: number;
  /** How far into the book it is (0 to 1). */
  fraction: number;
  excerpt: Excerpt;
}

/** Results come in batches as the book is searched, with how much of it is done (0 to 1). */
export type OnFound = (hits: SearchHit[], done: number) => void;

/** Results are capped: past this many, a more specific search is more useful. */
export const MAX_HITS = 500;
