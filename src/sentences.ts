/** Reading aloud goes a sentence at a time: each is spoken on its own and marked while it is. */

/** A sentence to read aloud, and where it is, for the viewer to mark and show. */
export interface Sentence {
  text: string;
  location: string;
}

/** Longer than this (in characters), a sentence is spoken in pieces: engines cap an utterance. */
const LONGEST = 600;

type Segmenter = { segment: (text: string) => Iterable<{ segment: string; index: number }> };
type SegmenterClass = new (lang: string | undefined, options: { granularity: "sentence" }) => Segmenter;

function segmenter(lang?: string): Segmenter | null {
  const Class = (Intl as unknown as { Segmenter?: SegmenterClass }).Segmenter;
  if (!Class) return null;
  try {
    return new Class(lang, { granularity: "sentence" });
  } catch {
    // A language tag the browser doesn't take.
    return new Class(undefined, { granularity: "sentence" });
  }
}

/**
 * Where the sentences in `text` are, as [start, end) with the space around them left out.
 * A line break always ends a sentence, so headings and paragraphs don't run together. Pieces
 * with nothing to say (ornaments, page numbers' dots) are skipped.
 */
export function sentences(text: string, lang?: string): [number, number][] {
  const out: [number, number][] = [];
  const space = (i: number) => /\s/.test(text[i]!);
  const push = (start: number, end: number) => {
    while (start < end && space(start)) start++;
    while (end > start && space(end - 1)) end--;
    if (!/[\p{L}\p{N}]/u.test(text.slice(start, end))) return;
    while (end - start > LONGEST) {
      const cut = text.lastIndexOf(" ", start + LONGEST);
      const at = cut > start ? cut : start + LONGEST;
      out.push([start, at]);
      start = at;
      while (start < end && space(start)) start++;
    }
    out.push([start, end]);
  };
  const split = segmenter(lang);
  for (const line of text.matchAll(/[^\n]+/g)) {
    const offset = line.index;
    if (split) for (const s of split.segment(line[0])) push(offset + s.index, offset + s.index + s.segment.length);
    else for (const s of line[0].matchAll(/[^.!?…]+(?:[.!?…]+["'”’»)\]]*)?\s*|[.!?…]+\s*/gu)) push(offset + s.index, offset + s.index + s[0].length);
  }
  return out;
}

/** A sentence as it's spoken: one space between words, and words broken across lines joined. */
export const spoken = (text: string) => text.replace(/(\p{L})-\n(?=\p{Ll})/gu, "$1").replace(/\s+/g, " ").trim();
