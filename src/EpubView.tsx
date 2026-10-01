import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import ePub, { EpubCFI, type Book, type Contents, type NavItem, type Rendition } from "epubjs";
import type { Highlight } from "./api";
import { byAge, highlightCss, highlightName, SWATCHES, type Rect, type TextSelection } from "./highlights";
import { epubLabel } from "./format";
import { isPageTap, type ViewerHandle, type ViewerProps } from "./viewer";
import { stripActiveContent } from "./sanitize";
import { attachPinch, type Focal } from "./pinch";
import { clampSize } from "./display";
import { Scrubber } from "./Scrubber";
import { LoaderCircle } from "lucide-react";
import { fromBook, sectionSpans, toBook, type Span } from "./bookmap";

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

/** Where a range inside a chapter's frame is on the screen. */
function viewportRect(range: Range): Rect {
  const r = range.getBoundingClientRect();
  const frame = range.startContainer.ownerDocument?.defaultView?.frameElement?.getBoundingClientRect();
  const dx = frame?.left ?? 0;
  const dy = frame?.top ?? 0;
  return { top: r.top + dy, bottom: r.bottom + dy, left: r.left + dx, right: r.right + dx };
}

interface Painted {
  id: string;
  range: Range;
}
/** Each chapter's highlight ranges, newest last, for finding which one a tap landed on. */
const painted = new WeakMap<Document, Painted[]>();

type HighlightWindow = Window & {
  CSS?: { highlights?: Map<string, unknown> };
  Highlight?: new (...ranges: Range[]) => unknown;
};

/**
 * Colours a chapter's highlights with the CSS Custom Highlight API: the text itself is painted,
 * so highlights reflow with font and size changes and never cover anything.
 */
function paint(contents: Contents, list: Highlight[], dark: boolean) {
  const doc = contents.document;
  let style = doc.getElementById("reader-highlights");
  if (!style) {
    style = doc.createElement("style");
    style.id = "reader-highlights";
    doc.head.appendChild(style);
  }
  const css = highlightCss(dark);
  if (style.textContent !== css) style.textContent = css;
  const here: (Painted & { color: Highlight["color"] })[] = [];
  for (const h of byAge(list)) {
    if (!h.location.startsWith("epubcfi(")) continue;
    try {
      if (new EpubCFI(h.location).spinePos !== contents.sectionIndex) continue;
      const range = contents.range(h.location);
      if (range && !range.collapsed) here.push({ id: h.id, range, color: h.color });
    } catch {
      // A highlight from a different edition of the book; nothing to paint.
    }
  }
  painted.set(doc, here);
  const win = doc.defaultView as HighlightWindow | null;
  const registry = win?.CSS?.highlights;
  if (!registry || !win?.Highlight) return;
  for (const s of SWATCHES) {
    const ranges = here.filter((p) => p.color === s.id).map((p) => p.range);
    if (ranges.length) registry.set(highlightName(s.id), new win.Highlight(...ranges));
    else registry.delete(highlightName(s.id));
  }
}

function hitHighlight(doc: Document, x: number, y: number): Painted | undefined {
  const list = painted.get(doc) ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    for (const r of list[i]!.range.getClientRects()) {
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return list[i];
    }
  }
  return undefined;
}

export const EpubView = forwardRef<ViewerHandle, ViewerProps>(function EpubView(
  { id, data, initial, resume, layout, css, cssFor, textSize, dark, onMove, onError, onTap, onTextSize, highlights, onSelect, onHighlightTap },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const rendition = useRef<Rendition>(undefined);
  // Scroll layout: where the reader is in the whole book, for the book-wide scrubber.
  const [fraction, setFraction] = useState<number | null>(null);
  const [scrolled, setScrolled] = useState(0);
  // The scrubber asked for a place whose chapter is still loading.
  const [seeking, setSeeking] = useState<number | null>(null);
  // Only dim the page for loads long enough to notice; quick ones would just flicker.
  const [slow, setSlow] = useState(false);
  const isSeeking = seeking !== null;
  useEffect(() => {
    if (!isSeeking) return setSlow(false);
    const timer = setTimeout(() => setSlow(true), 150);
    return () => clearTimeout(timer);
  }, [isSeeking]);
  const spans = useRef<Span[]>([]);
  // The scrubber drives the scroll position while dragging; this runs the drag inside the effect.
  const drag = useRef<(fraction: number, final: boolean) => void>(() => {});
  const move = useRef(onMove);
  move.current = onMove;
  const tap = useRef(onTap);
  tap.current = onTap;
  const marks = useRef(highlights);
  marks.current = highlights;
  const darkPage = useRef(dark);
  darkPage.current = dark;
  const selected = useRef(onSelect);
  selected.current = onSelect;
  const tappedMark = useRef(onHighlightTap);
  tappedMark.current = onHighlightTap;
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

    // A stage is one epub.js rendition in its own layer. Far seeks render into a hidden stage
    // while the visible one stays usable, then swap: the page is never blank, a newer seek or
    // the reader scrolling simply discards the hidden one, and a load that epub.js never
    // finishes can't block anything after it.
    interface LoadedView {
      section: { index: number; href: string };
      element: HTMLElement;
    }
    interface Stage {
      view: Rendition;
      layer: HTMLDivElement;
      index?: number;
      destroy: () => void;
    }
    let active: Stage;
    let pending: Stage | null = null;
    const views = (stage: Stage) =>
      ((stage.view as unknown as { manager?: { views?: { all: () => LoadedView[] } } }).manager?.views?.all() ?? []);
    const box = (stage: Stage) => stage.layer.querySelector<HTMLElement>(".epub-container");
    const probe = (b: HTMLElement) => b.clientHeight / 3;

    // Pinching resizes the text live, keeping the words under the fingers where they were.
    interface Anchor {
      range: Range;
      frame: Element | null;
      y: number;
      cfi?: string;
    }
    const top = (a: Anchor) => a.range.getBoundingClientRect().top + (a.frame?.getBoundingClientRect().top ?? 0);
    const reanchor = (a: Anchor | undefined) => {
      const b = box(active);
      if (a && b) b.scrollTop += top(a) - a.y;
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
      const contents = (active.view.getContents() as unknown as Contents[]).find((c) => c.document === doc);
      const anchor: Anchor = { range, frame: doc.defaultView?.frameElement ?? null, y: 0 };
      anchor.y = top(anchor);
      try {
        anchor.cfi = contents?.cfiFromRange(range);
      } catch {}
      return anchor;
    };
    let live: { base: number; size: number; anchor?: Anchor } | null = null;
    let pinchFrame = 0;
    const pinchInto = (doc: Document | null) => ({
      onChange: (scale: number, at: Focal) => {
        live ??= { base: size.current, size: size.current, anchor: anchorAt(doc, at) };
        const next = clampSize(live.base * scale);
        if (next === live.size) return;
        live.size = next;
        sizeChanged.current(next, false);
        const anchor = live.anchor;
        cancelAnimationFrame(pinchFrame);
        pinchFrame = requestAnimationFrame(() => {
          (active.view.getContents() as unknown as Contents[]).forEach((c) => applyLook(c.document, styleFor.current(next)));
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
        else if (anchor?.cfi) setTimeout(() => void active.view.display(anchor.cfi), 80);
      },
    });

    // Where the reader is, continuously: the chapter crossing the upper third of the screen and
    // how far into it, mapped onto the whole book.
    const liveFraction = () => {
      const b = box(active);
      if (!b || !spans.current.length) return null;
      const y0 = b.getBoundingClientRect().top;
      for (const v of views(active)) {
        const r = v.element.getBoundingClientRect();
        const y = r.top - y0;
        if (y <= probe(b) && y + r.height > probe(b)) return toBook(spans.current, v.section.index, (probe(b) - y) / r.height);
      }
      return null;
    };
    // The selection being offered for highlighting, so its toolbar can follow the scroll.
    let selection: { range: Range; offer: Omit<TextSelection, "rect"> } | null = null;
    const follow = () => selection && selected.current({ ...selection.offer, rect: viewportRect(selection.range) });
    let dragging = false;
    let frame = 0;
    const onScroll = () => {
      setScrolled(Date.now());
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        follow();
        if (dragging) return;
        const f = liveFraction();
        if (f !== null) setFraction(f);
      });
    };

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
      if (layout === "scroll") {
        const f = liveFraction();
        if (f !== null && !dragging) setFraction(f);
      }
      unsaved = false;
    };

    // Seeking: a hidden stage loads the target chapter, then replaces the visible one.
    interface Target {
      index: number;
      within: number;
    }
    let target: Target | null = null;
    let schedule: ReturnType<typeof setTimeout> | undefined;
    const placeIn = (stage: Stage, t: Target) => {
      const b = box(stage);
      const v = views(stage).find((x) => x.section.index === t.index);
      if (!b || !v) return false;
      const r = v.element.getBoundingClientRect();
      const y = r.top - b.getBoundingClientRect().top + b.scrollTop;
      b.scrollTop = y + t.within * r.height - probe(b);
      return true;
    };
    const dropPending = () => {
      clearTimeout(schedule);
      pending?.destroy();
      pending = null;
      setSeeking(null);
    };
    const swapIn = (stage: Stage) => {
      const old = active;
      active = stage;
      pending = null;
      rendition.current = stage.view;
      stage.layer.style.visibility = "";
      old.destroy();
      setSeeking(null);
      // Report the new place as the reader's own move, so it's saved.
      forced.current = true;
      (stage.view as unknown as { reportLocation: () => void }).reportLocation();
      const f = liveFraction();
      if (f !== null && !dragging) setFraction(f);
    };
    const loadInBackground = (t: Target) => {
      pending?.destroy();
      const stage = mountStage(true);
      stage.index = t.index;
      pending = stage;
      const section = book.spine.get(t.index);
      if (!section) return dropPending();
      // epub.js can leave a display unfinished; don't wait on it forever.
      const giveUp = setTimeout(() => pending === stage && dropPending(), 15000);
      void stage.view
        .display(section.href)
        .then(() => new Promise((done) => setTimeout(done, 50)))
        .then(() => {
          clearTimeout(giveUp);
          if (pending !== stage) return;
          placeIn(stage, target && target.index === stage.index ? target : t);
          if (!dragging) target = null;
          swapIn(stage);
        })
        .catch(() => pending === stage && dropPending());
    };
    drag.current = (to, final) => {
      if (!spans.current.length) return;
      dragging = !final;
      // A drag is the reader moving: the new place is saved.
      inputUntil.current = Date.now() + 1500;
      const t = fromBook(spans.current, to);
      target = t;
      // In chapters already on screen the page follows the pointer directly. Dragging back
      // into them also cancels a load that's no longer wanted.
      if (placeIn(active, t)) {
        if (pending) dropPending();
        if (final) target = null;
        return;
      }
      setSeeking(to);
      if (pending?.index === t.index) return;
      // Further away: load when the pointer pauses or lets go, not for every chapter it passes.
      clearTimeout(schedule);
      schedule = setTimeout(() => target && loadInBackground(target), final ? 0 : 180);
    };

    // Scrolling saves only when the reader scrolled; loading and reflowing don't. Scrolling the
    // visible page while a seek is loading means the reader changed their mind: cancel it.
    const touched = () => {
      inputUntil.current = Date.now() + 1500;
      if (pending && !dragging) {
        target = null;
        dropPending();
      }
    };
    const inputs = ["wheel", "touchmove", "keydown", "pointerdown"] as const;

    const mountStage = (hidden: boolean): Stage => {
      const layer = document.createElement("div");
      layer.className = "epub-stage";
      if (hidden) layer.style.visibility = "hidden";
      element.appendChild(layer);
      const view = book.renderTo(layer, {
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
      const stage: Stage = {
        view,
        layer,
        destroy: () => {
          try {
            view.destroy();
          } catch {}
          layer.remove();
        },
      };
      if (layout === "scroll") {
        // epub.js trims chapters out of view and re-inserts them when the reader comes back,
        // each time correcting the scroll from code. With many short sections that churn
        // fights trackpad momentum and the page lurches. Keep what's loaded for the session.
        void view.started.then(() => {
          const manager = (view as unknown as { manager?: { trim: () => Promise<void> } }).manager;
          if (manager) manager.trim = () => Promise.resolve();
        });
      }
      view.hooks.content.register((contents: Contents) => {
        applyLook(contents.document, look.current);
        paint(contents, marks.current, darkPage.current);
        // A selection that collapses (tapped away, highlighted, copied) takes its toolbar with it.
        contents.document.addEventListener("selectionchange", () => {
          if (!selection || selection.range.startContainer.ownerDocument !== contents.document) return;
          const current = contents.document.getSelection();
          if (current && !current.isCollapsed) return;
          selection = null;
          selected.current(null);
        });
        // Justified text hyphenates by language; some books only declare it in their metadata.
        const html = contents.document.documentElement;
        const language = book.packaging?.metadata?.language;
        if (!html.lang && !html.getAttribute("xml:lang") && language) html.lang = language;
        inputs.forEach((type) => contents.document.addEventListener(type, () => stage === active && touched(), { passive: true }));
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
      view.on("relocated", (location: Relocated) => {
        // A hidden stage is still loading; it reports once it's shown.
        if (stage !== active) return;
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
      // Taps inside the chapter arrive from its iframe. One on a highlight opens its menu.
      view.on("click", (e: MouseEvent) => {
        if (stage !== active || !isPageTap(e)) return;
        const doc = (e.target as Node | null)?.ownerDocument;
        const hit = doc ? hitHighlight(doc, e.clientX, e.clientY) : undefined;
        if (hit) tappedMark.current(hit.id, viewportRect(hit.range));
        else tap.current();
      });
      // epub.js reports a selection once it settles.
      view.on("selected", (cfiRange: string, contents: Contents) => {
        if (stage !== active) return;
        const current = contents.document.getSelection();
        if (!current || current.isCollapsed || !current.rangeCount) return;
        const range = current.getRangeAt(0);
        // The selection's text keeps paragraph breaks that the range's own text drops.
        const text = (current.toString() || range.toString()).trim();
        if (!text) return;
        const index = contents.sectionIndex;
        const located = book.locations.length() ? book.locations.percentageFromCfi(cfiRange) : -1;
        const fraction = Math.min(1, Math.max(0, located >= 0 ? located : spans.current.length ? toBook(spans.current, index, 0) : 0));
        const href = book.spine.get(index)?.href;
        const offer = {
          location: cfiRange,
          text,
          label: epubLabel(fraction, href ? chapterOf(book, href) : undefined),
          fraction,
          clear: () => contents.document.getSelection()?.removeAllRanges(),
        };
        selection = { range, offer };
        follow();
      });
      if (layout === "pages") {
        const turn = (forward: boolean) => {
          forced.current = true;
          void (forward ? view.next() : view.prev());
        };
        // Swipes arrive from inside the book's iframe.
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
      return stage;
    };

    active = mountStage(false);
    rendition.current = active.view;
    element.addEventListener("scroll", onScroll, { capture: true, passive: true });
    inputs.forEach((type) => element.addEventListener(type, touched, { capture: true, passive: true }));
    // Taps in the margins hit the host rather than a chapter.
    const marginTap = (e: MouseEvent) => (e.target === element || (e.target as Element).classList?.contains("epub-stage")) && tap.current();
    element.addEventListener("click", marginTap);
    const detachPinch = attachPinch(element, pinchInto(null));

    // The first open marks the synced spot; a layout switch just returns to where the reader was.
    const start = shown.current;
    const first = !opened.current;
    opened.current = true;
    forced.current = false;
    const opening = active;
    opening.view
      .display(start || undefined)
      .then(() => first && initial && resume && mark(opening.view, initial))
      .catch(() => opening.view.display())
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
        spans.current = sectionSpans(
          JSON.parse(book.locations.save()) as string[],
          (book.spine as unknown as { length: number }).length,
        );
        report(false);
      })
      .catch(onError);

    return () => {
      inputs.forEach((type) => element.removeEventListener(type, touched, { capture: true }));
      element.removeEventListener("click", marginTap);
      element.removeEventListener("scroll", onScroll, { capture: true });
      clearTimeout(schedule);
      setSeeking(null);
      setFraction(null);
      detachPinch();
      clearMark.current = () => {};
      if (selection) selected.current(null);
      rendition.current = undefined;
      pending?.destroy();
      active.destroy();
      try {
        book.destroy();
      } catch {}
    };
    // The book loads once per layout; later locations go through goTo.
  }, [data, layout]);

  // Skin, font and size changes restyle the open chapters in place.
  useEffect(() => {
    (rendition.current?.getContents() as unknown as Contents[] | undefined)?.forEach((c) => applyLook(c.document, css));
  }, [css]);
  useEffect(() => {
    (rendition.current?.getContents() as unknown as Contents[] | undefined)?.forEach((c) => paint(c, highlights, dark));
  }, [highlights, dark]);

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

  return (
    <>
      <div className={`epub-frame ${layout}`} ref={host} />
      {slow && (
        // The text on screen is about to be replaced: dim it and say what's happening.
        <div className="pointer-events-none absolute inset-0 z-[5] grid place-items-center bg-card/55 backdrop-blur-[1px]">
          <span className="flex items-center gap-2 rounded-full bg-foreground/85 px-4 py-2 text-sm font-medium text-background shadow-lg">
            <LoaderCircle className="size-4 animate-spin" />
            Loading…
          </span>
        </div>
      )}
      {layout === "scroll" && <Scrubber
          fraction={fraction}
          onDrag={(f, final) => drag.current(f, final)}
          activity={scrolled}
          pending={seeking}
        />}
    </>
  );
});
