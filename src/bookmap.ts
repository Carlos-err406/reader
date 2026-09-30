/**
 * Maps a position in the whole book (0–1) to a chapter and a position within it, and back.
 * Each spine section gets a share proportional to its length, measured by how many epub.js
 * locations (~1200 characters each) start in it. Short sections such as image pages still get
 * a small share, so every section is reachable and the thumb never jumps over one.
 */
export interface Span {
  start: number;
  end: number;
}

const MIN_WEIGHT = 0.25;

/** The spine index an EPUB CFI points into: `epubcfi(/6/8!…)` is spine item 3. */
export function spineIndex(cfi: string): number | null {
  const step = /^epubcfi\(\/6\/(\d+)/.exec(cfi)?.[1];
  return step ? Number(step) / 2 - 1 : null;
}

export function sectionSpans(locations: string[], sections: number): Span[] {
  const weights = Array.from({ length: sections }, () => 0);
  for (const cfi of locations) {
    const index = spineIndex(cfi);
    if (index !== null && index >= 0 && index < sections) weights[index]! += 1;
  }
  const sized = weights.map((w) => Math.max(w, MIN_WEIGHT));
  const total = sized.reduce((a, b) => a + b, 0) || 1;
  let start = 0;
  return sized.map((w) => {
    const span = { start, end: start + w / total };
    start = span.end;
    return span;
  });
}

const clamp = (n: number) => Math.min(1, Math.max(0, n));

export function toBook(spans: Span[], index: number, within: number): number {
  const span = spans[index];
  return span ? clamp(span.start + clamp(within) * (span.end - span.start)) : 0;
}

export function fromBook(spans: Span[], fraction: number): { index: number; within: number } {
  const f = clamp(fraction);
  let index = spans.findIndex((s) => f < s.end);
  if (index < 0) index = spans.length - 1;
  const span = spans[index] ?? { start: 0, end: 1 };
  return { index, within: span.end > span.start ? (f - span.start) / (span.end - span.start) : 0 };
}
