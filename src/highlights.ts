import type { Highlight, HighlightColor } from "./api";

export interface Swatch {
  id: HighlightColor;
  name: string;
  /** Solid colour for buttons and list markers. */
  solid: string;
  /** Behind text on a light page. */
  light: string;
  /** Behind light text on a dark page. */
  dark: string;
}

export const SWATCHES: Swatch[] = [
  { id: "yellow", name: "Yellow", solid: "#f5c518", light: "rgb(250 204 21 / 0.4)", dark: "rgb(234 179 8 / 0.5)" },
  { id: "green", name: "Green", solid: "#4cc777", light: "rgb(74 222 128 / 0.36)", dark: "rgb(34 197 94 / 0.45)" },
  { id: "blue", name: "Blue", solid: "#5b9cf2", light: "rgb(96 165 250 / 0.36)", dark: "rgb(59 130 246 / 0.52)" },
  { id: "pink", name: "Pink", solid: "#ee6fb0", light: "rgb(244 114 182 / 0.36)", dark: "rgb(236 72 153 / 0.48)" },
  { id: "purple", name: "Purple", solid: "#a184f3", light: "rgb(167 139 250 / 0.4)", dark: "rgb(139 92 246 / 0.55)" },
];

export const swatch = (color: HighlightColor): Swatch => SWATCHES.find((s) => s.id === color) ?? SWATCHES[0]!;

/** The CSS Custom Highlight API name for a colour inside EPUB chapters. */
export const highlightName = (color: HighlightColor) => `reader-${color}`;

/** EPUB chapters paint highlights with `::highlight()`, so they reflow with the text. */
export function highlightCss(dark: boolean): string {
  return [
    ...SWATCHES.map((s) => `::highlight(${highlightName(s.id)}) { background-color: ${dark ? s.dark : s.light}; }`),
    `::highlight(${SEARCH_MARK}) { background-color: ${dark ? "rgb(255 150 30 / 0.6)" : "rgb(255 140 0 / 0.5)"}; }`,
  ].join("\n");
}

/** The CSS highlight marking the search match being looked at. */
export const SEARCH_MARK = "reader-search";

/** Where on the screen something is, in viewport pixels. */
export interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Text the reader selected, ready to become a highlight. */
export interface TextSelection {
  location: string;
  text: string;
  label: string;
  fraction: number;
  rect: Rect;
  /** Drops the selection once it's been highlighted. */
  clear: () => void;
  /**
   * EPUB: the selection runs into highlights already there. Highlighting it makes one highlight
   * covering them all (`location`, `text`, `label`, `fraction`) in place of those (`ids`).
   */
  joins?: { ids: string[]; location: string; text: string; label: string; fraction: number };
}

/**
 * Whether two ranges share some text (merely touching doesn't count): each starts before the
 * other ends. (END_TO_START compares a's start with b's end; START_TO_END, a's end with b's start.)
 */
export const overlaps = (a: Range, b: Range) =>
  a.compareBoundaryPoints(Range.END_TO_START, b) < 0 && a.compareBoundaryPoints(Range.START_TO_END, b) > 0;

/**
 * The range with its ends moved into text. A selection can start or end between elements (one
 * starting at an image does), and epub.js writes such an end as a spot in a text node that isn't
 * there: the highlight was saved, but could never be drawn.
 */
export function textBounded(range: Range): Range {
  const TEXT = 3;
  if (range.startContainer.nodeType === TEXT && range.endContainer.nodeType === TEXT) return range;
  const root = range.commonAncestorContainer;
  const walker = (root.ownerDocument ?? (root as Document)).createTreeWalker(root, 4 /* SHOW_TEXT */);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (range.intersectsNode(n) && /\S/.test((n as Text).data)) texts.push(n as Text);
  }
  const first = texts[0];
  const last = texts[texts.length - 1];
  if (!first || !last) return range;
  const bounded = range.cloneRange();
  if (range.startContainer.nodeType !== TEXT) bounded.setStart(first, 0);
  if (range.endContainer.nodeType !== TEXT) bounded.setEnd(last, last.length);
  return bounded;
}

/**
 * Other readings of a range CFI saved with a text step that isn't there (see `textBounded`):
 * without that step, it's the spot between elements the selection really had.
 */
export function cfiRepairs(cfi: string): string[] {
  const parts = cfi.match(/^epubcfi\(([^,]*),([^,]*),([^,]*)\)$/);
  if (!parts) return [];
  const [, base, start, end] = parts as unknown as [string, string, string, string];
  const drop = (part: string) => part.replace(/(.)\/1:(\d+)$/, "$1:$2");
  const tries = [`${base},${drop(start)},${end}`, `${base},${start},${drop(end)}`, `${base},${drop(start)},${drop(end)}`];
  return [...new Set(tries.map((t) => `epubcfi(${t})`))].filter((t) => t !== cfi);
}

/** One marked rectangle on a PDF page, as fractions of the page: page, x, y, width, height. */
export type PageRect = [number, number, number, number, number];

/**
 * PDF highlights are rectangles over the page image. The location starts with the first page
 * number, so jumping to it works like a page bookmark.
 */
export function pdfHighlightLocation(rects: PageRect[]): string {
  const round = (n: number) => Math.round(n * 10000) / 10000;
  const pages = rects.map(([page, ...box]) => [page, ...box.map(round)]);
  return `${rects[0]?.[0] ?? 1}:${JSON.stringify(pages)}`;
}

export function pdfHighlightRects(location: string): PageRect[] {
  const json = location.slice(location.indexOf(":") + 1);
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is PageRect => Array.isArray(r) && r.length === 5 && r.every((n) => typeof n === "number" && Number.isFinite(n)),
    );
  } catch {
    return [];
  }
}

/**
 * Selection rectangles from one text line come in pieces (one per text run), often overlapping.
 * Joins the pieces of each line so a highlight is one even band per line.
 */
export function mergeLines(rects: PageRect[]): PageRect[] {
  const sorted = [...rects].filter((r) => r[3] > 0 && r[4] > 0).sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[1] - b[1]);
  const out: PageRect[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    // Same page, vertically overlapping by most of the shorter one, and touching horizontally.
    if (last && last[0] === r[0]) {
      const overlap = Math.min(last[2] + last[4], r[2] + r[4]) - Math.max(last[2], r[2]);
      const gap = r[1] - (last[1] + last[3]);
      if (overlap > 0.6 * Math.min(last[4], r[4]) && gap < Math.max(last[4], r[4]) * 1.5) {
        const left = Math.min(last[1], r[1]);
        const top = Math.min(last[2], r[2]);
        const right = Math.max(last[1] + last[3], r[1] + r[3]);
        const bottom = Math.max(last[2] + last[4], r[2] + r[4]);
        out[out.length - 1] = [r[0], left, top, right - left, bottom - top];
        continue;
      }
    }
    out.push([...r]);
  }
  // Text boxes are taller than the line spacing; split the overlap between neighbouring lines so
  // the bands don't double up into darker stripes.
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1]!;
    const b = out[i]!;
    const sideBySide = a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
    if (a[0] !== b[0] || !sideBySide || b[2] <= a[2] || b[2] >= a[2] + a[4]) continue;
    const middle = (a[2] + a[4] + b[2]) / 2;
    a[4] = middle - a[2];
    b[4] = b[2] + b[4] - middle;
    b[2] = middle;
  }
  return out;
}

/** The highlights of a list, newest last, so taps on overlapping ones pick the newest. */
export const byAge = (list: Highlight[]) => [...list].sort((a, b) => a.createdAt - b.createdAt);
