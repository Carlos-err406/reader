import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import ePub, { type Book, type Contents, type NavItem, type Rendition } from "epubjs";
import { epubLabel } from "./format";
import { isPageTap, type ViewerHandle, type ViewerProps } from "./viewer";
import { stripActiveContent } from "./sanitize";
import { attachPinch, type Focal } from "./pinch";
import { clampSize } from "./display";
import { Scrubber } from "./Scrubber";

interface Relocated {
  start: { cfi: string; href: string; percentage: number };
}

const flatten = (items: NavItem[]): NavItem[] => items.flatMap((i) => [i, ...flatten(i.subitems ?? [])]);

function chapterOf(book: Book, href: string): string | undefined {
  const path = href.split("#")[0];
  return flatten(book.navigation?.toc ?? []).find((item) => {
    const target = item.href.split("#")[0];
    return target === path || path.endsWith(target) || target.endsWith(path);
  })?.label;
}

/** The text starting at `start`, about `length` characters long, ending on a word boundary. */
function phrase(start: Range, length = 80): Range {
  const doc = start.startContainer.ownerDocument!;
  const range = doc.createRange();
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  let offset = 0;
  if (start.startContainer.nodeType === Node.TEXT_NODE) {
    node = walker.currentNode = start.startContainer;
    offset = start.startOffset;
  } else {
    walker.currentNode = start.startContainer;
    node = walker.nextNode();
  }
  if (!node) return start;
  range.setStart(node, offset);
  let taken = 0;
  while (node) {
    const text = node.textContent ?? "";
    if (taken + text.length - offset >= length) {
      const space = text.indexOf(" ", offset + (length - taken));
      range.setEnd(node, space === -1 ? text.length : space);
      return range;
    }
    taken += text.length - offset;
    range.setEnd(node, text.length);
    node = walker.nextNode();
    offset = 0;
  }
  return range;
}

/**
 * Another screen size paginates differently, so the page holding a synced spot can start well
 * before it, with the spot anywhere on the page. Highlight the words the other device's page
 * began with until the reader turns the page. Annotations draw an overlay; the book is untouched.
 * Returns a function that removes the highlight.
 */
function markResume(view: Rendition, cfi: string): () => void {
  try {
    const start = view.getRange(cfi);
    const contents = (view.getContents() as unknown as Contents[]).find(
      (c) => c.document === start.startContainer.ownerDocument,
    );
    if (!contents) return () => {};
    const range = contents.cfiFromRange(phrase(start));
    view.annotations.highlight(range, {}, () => {}, "reader-resume", {
      fill: "#e0703a",
      "fill-opacity": "0.4",
      "mix-blend-mode": "normal",
    });
    return () => view.annotations.remove(range, "highlight");
  } catch {
    return () => {};
  }
}

function applyLook(doc: Document, css: string) {
  let style = doc.getElementById("reader-look");
  if (!style) {
    style = doc.createElement("style");
    style.id = "reader-look";
    doc.head.appendChild(style);
  }
  if (style.textContent !== css) style.textContent = css;
}

const locationsKey = (id: string) => `reader:epub-locations:${id}`;

export const EpubView = forwardRef<ViewerHandle, ViewerProps>(function EpubView(
  { id, data, initial, layout, css, cssFor, textSize, onMove, onError, onTap, onTextSize },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const rendition = useRef<Rendition>(undefined);
  const loaded = useRef<Book>(undefined);
  // Scroll layout: where the reader is in the whole book, for the book-wide scrubber.
  const [fraction, setFraction] = useState<number | null>(null);
  const [scrolled, setScrolled] = useState(0);
  const move = useRef(onMove);
  move.current = onMove;
  const tap = useRef(onTap);
  tap.current = onTap;
  const sizeChanged = useRef(onTextSize);
  sizeChanged.current = onTextSize;
  const size = useRef(textSize);
  size.current = textSize;
  const styleFor = useRef(cssFor);
  styleFor.current = cssFor;
  const look = useRef(css);
  look.current = css;
  // Whether the next relocation should be saved: set by navigation the reader asked for
  // (turn, bookmark) or not (following another device). Otherwise recent input decides.
  const forced = useRef<boolean | null>(null);
  const inputUntil = useRef(0);
  // Where the reader is, so switching layout reopens at the same spot.
  const shown = useRef<string | undefined>(initial);
  const opened = useRef(false);
  const clearMark = useRef<() => void>(() => {});
  const mark = (view: Rendition, cfi: string) => {
    clearMark.current();
    clearMark.current = markResume(view, cfi);
  };

  useEffect(() => {
    if (!host.current) return;
    const element = host.current;
    const book = ePub(data.slice(0));
    book.spine.hooks.content.register((doc: Document) => stripActiveContent(doc));
    const view = book.renderTo(element, {
      width: "100%",
      height: "100%",
      // Needed for WebKit to deliver events into chapters; book scripts are stripped instead.
      allowScriptedContent: true,
      ...(layout === "scroll"
        ? // Load neighbouring chapters two screens ahead, so they're in place before the reader
          // gets there instead of being inserted (and scroll-corrected) right at the edge.
          { flow: "scrolled", manager: "continuous", offset: Math.max(1500, element.clientHeight * 2) }
        : { flow: "paginated", spread: "none" }),
    });
    if (layout === "scroll") {
      // epub.js trims chapters out of view and re-inserts them when the reader comes back, each
      // time correcting the scroll from code. With many short sections (front matter, image pages)
      // that churn fights trackpad momentum and the page lurches. Keep what's loaded for the
      // session; a jump (scrubber, bookmark, another device) resets the loaded chapters anyway.
      void view.started.then(() => {
        const manager = (view as unknown as { manager?: { trim: () => Promise<void> } }).manager;
        if (manager) manager.trim = () => Promise.resolve();
      });
    }
    rendition.current = view;
    loaded.current = book;

    // Pinching resizes the text live, keeping the words under the fingers where they were.
    interface Anchor {
      range: Range;
      frame: Element | null;
      y: number;
      cfi?: string;
    }
    const top = (a: Anchor) => a.range.getBoundingClientRect().top + (a.frame?.getBoundingClientRect().top ?? 0);
    const reanchor = (a: Anchor | undefined) => {
      const box = element.querySelector<HTMLElement>(".epub-container");
      if (a && box) box.scrollTop += top(a) - a.y;
    };
    const anchorAt = (doc: Document | null, at: Focal): Anchor | undefined => {
      if (!doc) return undefined;
      const caret = doc as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
      let range = caret.caretRangeFromPoint?.(at.x, at.y) ?? null;
      if (!range) {
        const position = doc.caretPositionFromPoint?.(at.x, at.y);
        if (!position) return undefined;
        range = doc.createRange();
        range.setStart(position.offsetNode, position.offset);
      }
      const contents = (view.getContents() as unknown as Contents[]).find((c) => c.document === doc);
      const anchor: Anchor = { range, frame: doc.defaultView?.frameElement ?? null, y: 0 };
      anchor.y = top(anchor);
      try {
        anchor.cfi = contents?.cfiFromRange(range);
      } catch {}
      return anchor;
    };
    let live: { base: number; size: number; anchor?: Anchor } | null = null;
    let pending = 0;
    const pinchInto = (doc: Document | null) => ({
      onChange: (scale: number, at: Focal) => {
        live ??= { base: size.current, size: size.current, anchor: anchorAt(doc, at) };
        const next = clampSize(live.base * scale);
        if (next === live.size) return;
        live.size = next;
        sizeChanged.current(next, false);
        const anchor = live.anchor;
        cancelAnimationFrame(pending);
        pending = requestAnimationFrame(() => {
          (view.getContents() as unknown as Contents[]).forEach((c) => applyLook(c.document, styleFor.current(next)));
          if (layout === "scroll") requestAnimationFrame(() => reanchor(anchor));
        });
      },
      onEnd: () => {
        if (!live) return;
        const { size: final, anchor } = live;
        live = null;
        sizeChanged.current(final, true);
        // Chapters finish resizing a little later; pin the spot again as they do.
        if (layout === "scroll") [80, 250, 600].forEach((ms) => setTimeout(() => reanchor(anchor), ms));
        else if (anchor?.cfi) setTimeout(() => void view.display(anchor.cfi), 80);
      },
    });

    // Scrolling saves only when the reader scrolled; loading and reflowing don't.
    const touched = () => (inputUntil.current = Date.now() + 1500);
    const onScroll = () => setScrolled(Date.now());
    element.addEventListener("scroll", onScroll, { capture: true, passive: true });
    const inputs = ["wheel", "touchmove", "keydown", "pointerdown"] as const;
    inputs.forEach((type) => element.addEventListener(type, touched, { capture: true, passive: true }));
    view.hooks.content.register((contents: Contents) => {
      applyLook(contents.document, look.current);
      // Justified text hyphenates by language; some books only declare it in their metadata.
      const html = contents.document.documentElement;
      const language = book.packaging?.metadata?.language;
      if (!html.lang && !html.getAttribute("xml:lang") && language) html.lang = language;
      inputs.forEach((type) => contents.document.addEventListener(type, touched, { passive: true }));
      // Pinching a reflowable book changes its text size.
      attachPinch(contents.document, pinchInto(contents.document));
      // Focus moves into the chapter on click, so pass keys on to the reader's shortcuts.
      contents.document.addEventListener("keydown", (e) => {
        const copy = new KeyboardEvent("keydown", {
          key: e.key,
          code: e.code,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          cancelable: true,
        });
        window.dispatchEvent(copy);
        if (copy.defaultPrevented) e.preventDefault();
      });
    });

    // Percentages come from a location index. Until it exists epub.js reports 0%, and saving
    // that would overwrite the synced progress, so positions are held back until it's ready.
    let indexed = false;
    let last: Relocated | undefined;
    let unsaved = false;
    const report = (save: boolean) => {
      unsaved ||= save;
      if (!last || !indexed) return;
      const { cfi, href, percentage } = last.start;
      const fraction = book.locations.length() ? book.locations.percentageFromCfi(cfi) : percentage;
      const position = { location: cfi, label: epubLabel(fraction || 0, chapterOf(book, href)), fraction: fraction || 0 };
      move.current(position, unsaved);
      setFraction(position.fraction);
      unsaved = false;
    };
    view.on("relocated", (location: Relocated) => {
      last = location;
      shown.current = location.start.cfi;
      const save = forced.current ?? Date.now() < inputUntil.current;
      forced.current = null;
      // The reader moved on from the highlighted spot.
      if (save) {
        clearMark.current();
        clearMark.current = () => {};
      }
      report(save);
    });

    // Taps inside the chapter arrive from its iframe; taps in the margins hit the host.
    view.on("click", (e: MouseEvent) => isPageTap(e) && tap.current());
    const marginTap = (e: MouseEvent) => e.target === element && tap.current();
    element.addEventListener("click", marginTap);
    const detachPinch = attachPinch(element, pinchInto(null));

    if (layout === "pages") {
      const turn = (forward: boolean) => {
        forced.current = true;
        void (forward ? view.next() : view.prev());
      };
      // Swipe and arrow keys arrive from inside the book's iframe.
      let startX = 0;
      let pinching = false;
      view.on("touchstart", (e: TouchEvent) => {
        if (e.touches.length > 1) pinching = true;
        else if (!pinching) startX = e.changedTouches[0]?.clientX ?? 0;
      });
      view.on("touchend", (e: TouchEvent) => {
        // A pinch isn't a swipe; wait for every finger to lift before listening again.
        if (pinching) {
          if (e.touches.length === 0) pinching = false;
          return;
        }
        const dx = (e.changedTouches[0]?.clientX ?? 0) - startX;
        if (Math.abs(dx) > 50) turn(dx < 0);
      });
    }

    // The first open marks the synced spot; a layout switch just returns to where the reader was.
    const start = shown.current;
    const first = !opened.current;
    opened.current = true;
    forced.current = false;
    view
      .display(start || undefined)
      .then(() => first && initial && mark(view, initial))
      .catch(() => view.display())
      .catch(onError);
    // Building the index takes a few seconds on a long book, so it's cached per device.
    book.ready
      .then(async () => {
        let cached: string | null = null;
        try {
          cached = localStorage.getItem(locationsKey(id));
        } catch {}
        if (cached) book.locations.load(cached);
        else {
          await book.locations.generate(1200);
          try {
            localStorage.setItem(locationsKey(id), book.locations.save());
          } catch {}
        }
        indexed = true;
        report(false);
      })
      .catch(onError);

    return () => {
      inputs.forEach((type) => element.removeEventListener(type, touched, { capture: true }));
      element.removeEventListener("click", marginTap);
      element.removeEventListener("scroll", onScroll, { capture: true });
      setFraction(null);
      detachPinch();
      clearMark.current = () => {};
      rendition.current = undefined;
      book.destroy();
    };
    // The book loads once per layout; later locations go through goTo.
  }, [data, layout]);

  // Skin, font and size changes restyle the open chapters in place.
  useEffect(() => {
    (rendition.current?.getContents() as unknown as Contents[] | undefined)?.forEach((c) => applyLook(c.document, css));
  }, [css]);

  useImperativeHandle(ref, () => {
    const navigate = (save: boolean, go: (view: Rendition) => Promise<void>) => {
      if (!rendition.current) return;
      forced.current = save;
      void go(rendition.current);
    };
    return {
      next: () => navigate(true, (v) => v.next()),
      prev: () => navigate(true, (v) => v.prev()),
      // Following another device: show where it is, like opening at a synced spot.
      goTo: (location, save = true) =>
        navigate(save, (v) => v.display(location).then(() => void (!save && mark(v, location)))),
    };
  });

  // Seeking with the scrubber is the reader moving, so the new place is saved.
  const seek = (to: number) => {
    const book = loaded.current;
    if (!book?.locations.length() || !rendition.current) return;
    forced.current = true;
    void rendition.current.display(book.locations.cfiFromPercentage(to));
  };

  return (
    <>
      <div className={`epub-frame ${layout}`} ref={host} />
      {layout === "scroll" && <Scrubber fraction={fraction} onSeek={seek} activity={scrolled} />}
    </>
  );
});
