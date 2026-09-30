import type { Position } from "./api";
import type { Layout } from "./display";

export interface ViewerProps {
  /** The book id, for per-book caches. */
  id: string;
  data: ArrayBuffer;
  /** Where to open: the synced location, if any. */
  initial?: string;
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
}

/** Taps on links or while selecting text are for the book, not for the controls. */
export function isPageTap(event: MouseEvent): boolean {
  const target = event.target as Element | null;
  if (target?.closest?.("a, button, input, select, textarea")) return false;
  const selection = (target?.ownerDocument ?? document).getSelection();
  return !selection || selection.isCollapsed;
}

export interface ViewerHandle {
  next(): void;
  prev(): void;
  /** `save: false` when following another device, so its exact position is kept. */
  goTo(location: string, save?: boolean): void;
}
