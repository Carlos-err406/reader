import type { Highlight, Position } from "./api";
import type { Layout } from "./display";
import type { Rect, TextSelection } from "./highlights";
import type { OnFound, SearchHit } from "./search";

/** A table-of-contents entry. */
export interface TocEntry {
  label: string;
  /** Where it goes, for `goTo`. */
  location: string;
  /** Nesting: 0 for chapters, 1 for their sections, and so on. */
  depth: number;
  /** Where it starts in the book (0 to 1), to show how far in it is. */
  at: number;
  /** The section (EPUB) or page (PDF) it starts in, to find the one being read. */
  order: number;
  /** PDFs: the page it starts on. */
  page?: number;
}

/**
 * The entry being read: the last one starting at or before the reader's section or page.
 * Entries in the same section share it, so the first of them (the chapter) stands for it.
 */
export function currentEntry(entries: TocEntry[], place: number): number {
  let best = -1;
  for (const e of entries) if (e.order <= place && e.order > best) best = e.order;
  return best < 0 ? -1 : entries.findIndex((e) => e.order === best);
}

export interface ViewerProps {
  /** The book id, for per-book caches. */
  id: string;
  data: ArrayBuffer;
  /** Where to open: the synced location, if any. */
  initial?: string;
  /** `initial` is the reading position, so its words are marked for finding one's place. */
  resume: boolean;
  layout: Layout;
  /** Page stylesheet for reflowable books (skin, font, size). */
  css: string;
  /** Dark reading: PDFs, which can't be restyled, get their pages inverted. */
  dark: boolean;
  /** PDF magnification (1 = fit). Reflowable books zoom through text size instead. */
  zoom: number;
  /** PDFs: a pinch finished with this scale relative to its start. */
  onPinch: (scale: number) => void;
  /** Reflowable books: page stylesheet at a given text size, for live pinch updates. */
  cssFor: (size: number) => string;
  textSize: number;
  /** Reflowable books: live text size during a pinch; `final` when the fingers lift. */
  onTextSize: (size: number, final: boolean) => void;
  /**
   * `save` is true only when the reader moved (turned a page, opened a bookmark).
   * Opening at the synced spot, resizing or jumping to another device's page must not save:
   * reflowable pages differ per screen, so the page start here is earlier than the synced
   * spot, and saving it would drift the position back a little on every device switch.
   */
  onMove: (position: Position, save: boolean) => void;
  onError: (error: unknown) => void;
  /** A tap on the page (not a drag, link or text selection): shows or hides the controls. */
  onTap: () => void;
  /** This book's highlights, drawn over the text. */
  highlights: Highlight[];
  /** Text was selected (or the selection moved or went away: `null`). */
  onSelect: (selection: TextSelection | null) => void;
  /** A tap landed on a highlight. `stacked`: others over the same words, which go with it. */
  onHighlightTap: (id: string, rect: Rect, stacked?: string[]) => void;
  /** The book's table of contents, once known (empty when it has none). */
  onContents: (entries: TocEntry[]) => void;
  /** The search match to mark on the page, if any. */
  found: SearchHit | null;
}

/** Taps on links or while selecting text are for the book, not for the controls. */
export function isPageTap(event: MouseEvent): boolean {
  const target = event.target as Element | null;
  if (target?.closest?.("a, button, input, select, textarea")) return false;
  const selection = (target?.ownerDocument ?? document).getSelection();
  return !selection || selection.isCollapsed;
}

/**
 * How far one press of a volume button moves the scroll layout, as a share of the screen:
 * less than a screen, so the last lines read stay in view to pick up from.
 */
export const GLIDE = 0.65;

export interface ViewerHandle {
  next(): void;
  prev(): void;
  /** The volume buttons' turn: in the scroll layout a smooth `GLIDE` of a screen; a page otherwise. */
  glide(forward: boolean): void;
  /** `save: false` when following another device, so its exact position is kept. */
  goTo(location: string, save?: boolean): void;
  /** Searches the whole book, reporting matches as it goes, until done or aborted. */
  search(query: string, onFound: OnFound, signal: AbortSignal): Promise<void>;
}
