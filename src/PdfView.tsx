import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask, TextLayer } from "pdfjs-dist";
import type { HighlightColor } from "./api";
import { pdfjs } from "./pdf";
import { pdfPage, pdfPosition } from "./format";
import { attachPinch, MAX_ZOOM, MIN_ZOOM, type Focal } from "./pinch";
import { GLIDE, isPageTap, type TocEntry, type ViewerHandle, type ViewerProps } from "./viewer";
import { attachTextLayer } from "./pdfText";
import { excerpt, foldQuery, matches, MAX_HITS, type OnFound, type SearchHit } from "./search";
import {
  byAge,
  SEARCH_MARK,
  mergeLines,
  pdfHighlightLocation,
  pdfHighlightRects,
  swatch,
  type PageRect,
  type Rect,
  type TextSelection,
} from "./highlights";

/** Keeps zoomed canvases within what phones can allocate. */
const MAX_CANVAS = 4096;

type Outline = Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>;

/** A page's text as PDF.js lays it out: its runs in order, a line break after each line. */
async function pageText(doc: PDFDocumentProxy, number: number): Promise<string> {
  const content = await (await doc.getPage(number)).getTextContent();
  return content.items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : "")).join("");
}

async function searchPdf(doc: PDFDocumentProxy, query: string, onFound: OnFound, signal: AbortSignal) {
  const folded = foldQuery(query);
  if (folded.length < 2) return onFound([], 1);
  let total = 0;
  for (let page = 1; page <= doc.numPages; page++) {
    if (signal.aborted) return;
    let hits: SearchHit[] = [];
    try {
      const text = await pageText(doc, page);
      hits = matches(text, folded)
        .slice(0, MAX_HITS - total)
        .map(([start, end], nth) => ({
          location: String(page),
          order: page,
          nth,
          fraction: page / doc.numPages,
          excerpt: excerpt(text, start, end),
        }));
    } catch {
      // An unreadable page: nothing found on it.
    }
    if (signal.aborted) return;
    total += hits.length;
    onFound(hits, page / doc.numPages);
    if (total >= MAX_HITS) return onFound([], 1);
  }
}

/**
 * Marks a search match in a page's text layer, whose text is the page's runs in the same order
 * (line breaks as <br>), and brings it into view.
 */
function markInLayer(layer: HTMLElement, query: string, nth: number) {
  const nodes: { node: Text | null; start: number }[] = [];
  let text = "";
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n instanceof Text && !n.parentElement?.closest(".endOfContent")) {
      nodes.push({ node: n, start: text.length });
      text += n.data;
    } else if (n instanceof HTMLBRElement) text += "\n";
  }
  const found = matches(text, foldQuery(query))[nth];
  const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const Highlight = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!found || !registry || !Highlight) return;
  const at = (pos: number): [Text, number] => {
    let i = nodes.length - 1;
    while (i > 0 && nodes[i]!.start > pos) i--;
    const { node, start } = nodes[i]!;
    return [node!, Math.min(pos - start, node!.length)];
  };
  const range = document.createRange();
  const [startNode, startOffset] = at(found[0]);
  const [endNode, endOffset] = at(found[1] - 1);
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, Math.min(endOffset + 1, endNode.length));
  registry.set(SEARCH_MARK, new Highlight(range));
  startNode.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
}

/** The document's outline (its bookmarks panel), each entry resolved to the page it opens. */
async function tableOfContents(doc: PDFDocumentProxy): Promise<TocEntry[]> {
  const entries: TocEntry[] = [];
  const pageOf = async (dest: unknown): Promise<number | undefined> => {
    try {
      const explicit = typeof dest === "string" ? await doc.getDestination(dest) : dest;
      const ref = Array.isArray(explicit) ? explicit[0] : undefined;
      if (ref == null) return undefined;
      const index = typeof ref === "number" ? ref : await doc.getPageIndex(ref);
      return index + 1;
    } catch {
      return undefined;
    }
  };
  const walk = async (items: Outline, depth: number) => {
    for (const item of items ?? []) {
      const page = await pageOf(item.dest);
      const label = item.title.replace(/\s+/g, " ").trim();
      if (page && label) entries.push({ label, location: String(page), depth, at: page / doc.numPages, page, order: page });
      await walk(item.items, depth + 1);
    }
  };
  await walk(await doc.getOutline(), 0);
  return entries;
}

/** One marked rectangle of a highlight on a page: x, y, width and height as fractions of it. */
interface Mark {
  id: string;
  color: HighlightColor;
  box: [number, number, number, number];
}

/** Whether a point is on a mark, counting the gap to the lines around it. */
const inside = ([x, y, w, h]: Mark["box"], px: number, py: number) =>
  px >= x - 0.005 && px <= x + w + 0.005 && py >= y - h * 0.4 && py <= y + h * 1.4;

/**
 * Renders one page into a canvas `width` CSS pixels wide (or fitted into width×height), with
 * its highlights over the image and PDF.js's transparent text on top for selecting.
 */
function PdfPage({
  doc,
  number,
  width,
  height,
  marks,
  dark,
  found,
}: {
  doc: PDFDocumentProxy;
  number: number;
  width: number;
  height?: number;
  marks: Mark[] | undefined;
  dark: boolean;
  /** The search match to mark, when it's on this page. */
  found?: { query: string; nth: number };
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ width: number; height: number }>();
  // Bumped each time the text layer finishes, so a search match can be marked in it.
  const [words, setWords] = useState(0);
  useEffect(() => {
    const target = canvas.current;
    const layer = text.current;
    if (!target || !layer || width <= 0) return;
    let task: RenderTask | undefined;
    let words: TextLayer | undefined;
    let detach = () => {};
    let cancelled = false;
    void doc.getPage(number).then((page) => {
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      const scale = height ? Math.min(width / base.width, height / base.height) : width / base.width;
      const cssWidth = base.width * scale;
      const ratio = Math.min(window.devicePixelRatio || 1, MAX_CANVAS / cssWidth, MAX_CANVAS / (base.height * scale));
      const viewport = page.getViewport({ scale: scale * ratio });
      target.width = Math.floor(viewport.width);
      target.height = Math.floor(viewport.height);
      setBox({ width: Math.floor(cssWidth), height: Math.floor(base.height * scale) });
      task = page.render({ canvas: target, viewport });
      task.promise.catch(() => {});
      layer.replaceChildren();
      layer.style.setProperty("--total-scale-factor", String(scale));
      words = new pdfjs.TextLayer({
        textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
        container: layer,
        viewport: page.getViewport({ scale }),
      });
      words.render().then(
        () => {
          if (cancelled) return;
          detach = attachTextLayer(layer);
          setWords((n) => n + 1);
        },
        () => {},
      );
    });
    return () => {
      cancelled = true;
      task?.cancel();
      words?.cancel();
      detach();
    };
  }, [doc, number, width, height]);
  useEffect(() => {
    if (found && words && text.current) markInLayer(text.current, found.query, found.nth);
  }, [found?.query, found?.nth, words]);
  return (
    <div className="pdf-page" data-page={number} style={box}>
      <canvas ref={canvas} />
      {marks?.map((m, i) => (
        <div
          key={`${m.id}-${i}`}
          className="pdf-mark"
          style={{
            left: `${m.box[0] * 100}%`,
            top: `${m.box[1] * 100}%`,
            width: `${m.box[2] * 100}%`,
            height: `${m.box[3] * 100}%`,
            background: dark ? swatch(m.color).dark : swatch(m.color).light,
          }}
        />
      ))}
      <div ref={text} className="textLayer" />
    </div>
  );
}

/** What part of the screen a range covers, and the same as rectangles on the pages it spans. */
function measure(range: Range): { rects: PageRect[]; rect: Rect } | null {
  const rects: PageRect[] = [];
  const rect: Rect = { top: Infinity, bottom: -Infinity, left: Infinity, right: -Infinity };
  const root = range.commonAncestorContainer;
  const nodes: Text[] = [];
  if (root.nodeType === Node.TEXT_NODE) nodes.push(root as Text);
  else {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (range.intersectsNode(n)) nodes.push(n as Text);
  }
  for (const node of nodes) {
    const page = node.parentElement?.closest<HTMLElement>(".pdf-page[data-page]");
    if (!page || !node.parentElement?.closest(".textLayer")) continue;
    const part = document.createRange();
    part.selectNodeContents(node);
    if (node === range.startContainer) part.setStart(node, range.startOffset);
    if (node === range.endContainer) part.setEnd(node, range.endOffset);
    const at = page.getBoundingClientRect();
    if (at.width <= 0 || at.height <= 0) continue;
    for (const r of part.getClientRects()) {
      if (r.width <= 0 || r.height <= 0) continue;
      rects.push([Number(page.dataset.page), (r.left - at.left) / at.width, (r.top - at.top) / at.height, r.width / at.width, r.height / at.height]);
      rect.top = Math.min(rect.top, r.top);
      rect.bottom = Math.max(rect.bottom, r.bottom);
      rect.left = Math.min(rect.left, r.left);
      rect.right = Math.max(rect.right, r.right);
    }
  }
  if (!rects.length) return null;
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  // Long selections are capped so the location stays a reasonable size to sync.
  const merged = mergeLines(rects)
    .slice(0, 300)
    .map(([p, x, y, w, h]): PageRect => [p, clamp(x), clamp(y), Math.min(w, 1 - clamp(x)), Math.min(h, 1 - clamp(y))]);
  return { rects: merged, rect };
}

function useSize(element: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = element.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, [element]);
  return size;
}

/** A pinch in progress, previewed with a CSS transform until it's committed and re-rendered. */
interface Preview {
  scale: number;
  focal: Focal;
}

function usePinch(
  frame: React.RefObject<HTMLElement | null>,
  onPinch: ViewerProps["onPinch"],
  focal: React.RefObject<Focal | null>,
  zoom: number,
) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const commit = useRef(onPinch);
  commit.current = onPinch;
  const current = useRef(zoom);
  current.current = zoom;
  // The preview stops at the zoom limits, so letting go never jumps.
  const bounded = (scale: number) => Math.min(MAX_ZOOM / current.current, Math.max(MIN_ZOOM / current.current, scale));
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    return attachPinch(el, {
      onChange: (scale, at) => setPreview({ scale: bounded(scale), focal: at }),
      onEnd: (scale, at) => {
        focal.current = at;
        const final = bounded(scale);
        if (Math.abs(final - 1) < 0.02) setPreview(null);
        commit.current(final);
      },
    });
  }, [frame, focal]);
  return [preview, setPreview] as const;
}

export const PdfView = forwardRef<ViewerHandle, ViewerProps>(function PdfView(
  { data, initial, layout, dark, zoom, onMove, onError, onTap, onPinch, highlights, onSelect, onHighlightTap, onContents, found },
  ref,
) {
  const [doc, setDoc] = useState<PDFDocumentProxy>();
  const root = useRef<HTMLDivElement>(null);
  // The query the current results came from, to find a match again in a page's text layer.
  const lastQuery = useRef("");
  const selected = useRef(onSelect);
  selected.current = onSelect;
  // Shared by both layouts, so switching keeps the page.
  const [page, setPage] = useState(0);
  const [aspects, setAspects] = useState<number[]>([]);

  useEffect(() => {
    let cancelled = false;
    const task = pdfjs.getDocument({ data: new Uint8Array(data) });
    task.promise.then(
      async (loaded) => {
        if (cancelled) return;
        // Page shapes up front, so the scrolling column has the right height before rendering.
        const first = (await loaded.getPage(1)).getViewport({ scale: 1 });
        const ratios = Array.from({ length: loaded.numPages }, () => first.height / first.width);
        setAspects(ratios);
        setDoc(loaded);
        setPage(pdfPage(initial, loaded.numPages));
        void tableOfContents(loaded).then((entries) => !cancelled && onContents(entries), () => !cancelled && onContents([]));
        let differs = false;
        for (let n = 2; n <= loaded.numPages && !cancelled; n++) {
          const v = (await loaded.getPage(n)).getViewport({ scale: 1 });
          differs ||= Math.abs(v.height / v.width - ratios[n - 1]!) > 0.001;
          ratios[n - 1] = v.height / v.width;
        }
        if (!cancelled && differs) setAspects([...ratios]);
      },
      (error) => !cancelled && onError(error),
    );
    return () => {
      cancelled = true;
      void task.destroy();
    };
    // The document loads once per book; later locations go through goTo.
  }, [data]);

  // PDF pages are identical on every device, so any page shown is exact and safe to save.
  useEffect(() => {
    if (doc && page) onMove(pdfPosition(page, doc.numPages), true);
  }, [doc, page]);

  const marks = useMemo(() => {
    const byPage = new Map<number, Mark[]>();
    for (const h of byAge(highlights)) {
      for (const [p, ...box] of pdfHighlightRects(h.location)) {
        byPage.set(p, [...(byPage.get(p) ?? []), { id: h.id, color: h.color, box }]);
      }
    }
    return byPage;
  }, [highlights]);

  // Selected text, offered for highlighting once the selection settles. The offer follows the
  // page as it scrolls, and goes away with the selection.
  useEffect(() => {
    if (!doc) return;
    let active: Range | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    const offer = (range: Range) => {
      const measured = measure(range);
      if (!measured) return false;
      const first = measured.rects[0]![0];
      // The selection's text keeps line breaks that the range's own text drops.
      const text = (document.getSelection()?.toString() || range.toString()).trim();
      if (!text) return false;
      const position = pdfPosition(first, doc.numPages);
      const selection: TextSelection = {
        location: pdfHighlightLocation(measured.rects),
        text,
        label: position.label,
        fraction: position.fraction,
        rect: measured.rect,
        clear: () => document.getSelection()?.removeAllRanges(),
      };
      selected.current(selection);
      return true;
    };
    const drop = () => {
      if (!active) return;
      active = null;
      selected.current(null);
    };
    const settle = () => {
      const current = document.getSelection();
      const range = current && current.rangeCount && !current.isCollapsed ? current.getRangeAt(0) : null;
      if (!range || !root.current?.contains(range.commonAncestorContainer)) return drop();
      active = range;
      if (!offer(range)) drop();
    };
    const change = () => {
      clearTimeout(timer);
      const current = document.getSelection();
      if (!current || current.isCollapsed) drop();
      else timer = setTimeout(settle, 250);
    };
    const follow = () => {
      if (active && !frame) frame = requestAnimationFrame(() => ((frame = 0), active && offer(active)));
    };
    const element = root.current;
    document.addEventListener("selectionchange", change);
    element?.addEventListener("scroll", follow, { capture: true, passive: true });
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", change);
      element?.removeEventListener("scroll", follow, { capture: true });
      drop();
    };
  }, [doc]);

  // A tap on a highlight opens its menu; anywhere else it shows or hides the controls.
  const onPageClick = (e: MouseEvent) => {
    if (!isPageTap(e)) return;
    const page = (e.target as Element | null)?.closest?.<HTMLElement>(".pdf-page[data-page]");
    if (page) {
      const at = page.getBoundingClientRect();
      const x = (e.clientX - at.left) / at.width;
      const y = (e.clientY - at.top) / at.height;
      const here = marks.get(Number(page.dataset.page)) ?? [];
      const hit = here.findLast((m) => inside(m.box, x, y));
      if (hit) {
        const boxes = here.filter((m) => m.id === hit.id).map((m) => m.box);
        onHighlightTap(hit.id, {
          top: at.top + Math.min(...boxes.map((b) => b[1])) * at.height,
          bottom: at.top + Math.max(...boxes.map((b) => b[1] + b[3])) * at.height,
          left: at.left + Math.min(...boxes.map((b) => b[0])) * at.width,
          right: at.left + Math.max(...boxes.map((b) => b[0] + b[2])) * at.width,
        });
        return;
      }
    }
    onTap();
  };

  // The match being looked at: cleared from the page it was on when another is chosen.
  useEffect(() => {
    if (!found) (CSS as unknown as { highlights?: Map<string, unknown> }).highlights?.delete(SEARCH_MARK);
  }, [found]);
  if (!doc || !page) return <div className="pdf-frame" />;
  const mark = found && found.nth !== undefined ? { page: found.order, query: lastQuery.current, nth: found.nth } : undefined;
  const shared = { doc, page, setPage, dark, zoom, handle: ref, onPageClick, onPinch, marks, mark, search: (q: string, f: OnFound, s: AbortSignal) => {
    lastQuery.current = q;
    return searchPdf(doc, q, f, s);
  } };
  return (
    <div ref={root} className="contents">
      {layout === "scroll" ? <PdfScroll {...shared} aspects={aspects} /> : <PdfPages {...shared} />}
    </div>
  );
});

interface LayoutProps {
  doc: PDFDocumentProxy;
  page: number;
  setPage: React.Dispatch<React.SetStateAction<number>>;
  dark: boolean;
  zoom: number;
  handle: React.ForwardedRef<ViewerHandle>;
  onPageClick: (e: MouseEvent) => void;
  onPinch: ViewerProps["onPinch"];
  marks: Map<number, Mark[]>;
  mark: { page: number; query: string; nth: number } | undefined;
  search: (query: string, onFound: OnFound, signal: AbortSignal) => Promise<void>;
}

function PdfPages({ doc, page, setPage, dark, zoom, handle, onPageClick, onPinch, marks, mark, search }: LayoutProps) {
  const frame = useRef<HTMLDivElement>(null);
  const focal = useRef<Focal | null>(null);
  const size = useSize(frame);
  const [preview, setPreview] = usePinch(frame, onPinch, focal, zoom);
  const pages = doc.numPages;
  useLayoutEffect(() => setPreview(null), [zoom, setPreview]);
  useImperativeHandle(
    handle,
    () => ({
      next: () => setPage((p) => Math.min(p + 1, pages)),
      prev: () => setPage((p) => Math.max(p - 1, 1)),
      glide: (forward) => setPage((p) => Math.min(Math.max(p + (forward ? 1 : -1), 1), pages)),
      goTo: (location) => setPage(pdfPage(location, pages)),
      apart: (a, b) => Math.abs(pdfPage(a, pages) - pdfPage(b, pages)),
      search,
    }),
    [pages, setPage, search],
  );
  return (
    <div
      className={`pdf-frame ${dark ? "pdf-dark" : ""}`}
      ref={frame}
      onClick={(e) => onPageClick(e.nativeEvent)}
    >
      <div
        className="pdf-fit"
        style={preview ? { transform: `scale(${preview.scale})`, transformOrigin: `${preview.focal.x}px ${preview.focal.y}px` } : undefined}
      >
        <PdfPage
          doc={doc}
          number={page}
          width={size.width * zoom}
          height={size.height * zoom}
          marks={marks.get(page)}
          dark={dark}
          found={mark?.page === page ? mark : undefined}
        />
      </div>
    </div>
  );
}

const GAP = 12;

/** A continuous column of pages. Only pages near the screen are rendered. */
function PdfScroll({
  doc,
  page,
  setPage,
  dark,
  zoom,
  handle,
  aspects,
  onPageClick,
  onPinch,
  marks,
  mark,
  search,
}: LayoutProps & { aspects: number[] }) {
  const frame = useRef<HTMLDivElement>(null);
  const focal = useRef<Focal | null>(null);
  const size = useSize(frame);
  const [preview, setPreview] = usePinch(frame, onPinch, focal, zoom);
  const fit = Math.min(size.width - 16, 900);
  const width = fit * zoom;
  const columnWidth = Math.max(size.width, width + 16);
  const [near, setNear] = useState<Set<number>>(() => new Set([page]));
  const current = useRef(page);
  const placed = useRef(false);

  const tops: number[] = [];
  let total = GAP;
  for (const aspect of aspects) {
    tops.push(total);
    total += aspect * width + GAP;
  }

  // Opens at the saved page once the column has a size, and keeps that page on resize.
  useEffect(() => {
    const el = frame.current;
    if (!el || fit <= 0 || !tops.length) return;
    el.scrollTop = tops[current.current - 1]! - GAP;
    placed.current = true;
  }, [fit, aspects]);

  // Zooming keeps the point under the fingers (or the middle of the screen) in place.
  const before = useRef({ width, columnWidth, tops });
  useLayoutEffect(() => {
    const el = frame.current;
    const old = before.current;
    before.current = { width, columnWidth, tops };
    setPreview(null);
    if (!el || !placed.current || old.width <= 0 || old.width === width) return;
    const at = focal.current ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 };
    focal.current = null;
    const y = el.scrollTop + at.y;
    const index = Math.max(0, old.tops.findLastIndex((top) => top <= y));
    const within = (y - old.tops[index]!) / (aspects[index]! * old.width);
    el.scrollTop = tops[index]! + within * aspects[index]! * width - at.y;
    const x = el.scrollLeft + at.x - (old.columnWidth - old.width) / 2;
    el.scrollLeft = (x * width) / old.width + (columnWidth - width) / 2 - at.x;
  }, [zoom]);

  useEffect(() => {
    const el = frame.current;
    if (!el || width <= 0) return;
    let frameId = 0;
    const update = () => {
      frameId = 0;
      const top = el.scrollTop;
      const height = el.clientHeight;
      // The page crossing the upper third of the screen is the one being read.
      const probe = top + height / 3;
      let reading = 1;
      const nearby = new Set<number>();
      tops.forEach((y, i) => {
        if (y <= probe) reading = i + 1;
        if (y + aspects[i]! * width > top - height && y < top + 2 * height) nearby.add(i + 1);
      });
      // Scrolled to the very end, the last pages can't reach the probe: the reader is on the last.
      if (top > 0 && top + height >= el.scrollHeight - 2) reading = tops.length;
      setNear((old) => (old.size === nearby.size && [...nearby].every((n) => old.has(n)) ? old : nearby));
      if (placed.current && reading !== current.current) {
        current.current = reading;
        setPage(reading);
      }
    };
    const scroll = () => (frameId ||= requestAnimationFrame(update));
    update();
    el.addEventListener("scroll", scroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", scroll);
      cancelAnimationFrame(frameId);
    };
  }, [width, aspects]);

  useImperativeHandle(
    handle,
    () => ({
      next: () => frame.current?.scrollBy({ top: frame.current.clientHeight * 0.9, behavior: "smooth" }),
      prev: () => frame.current?.scrollBy({ top: -frame.current.clientHeight * 0.9, behavior: "smooth" }),
      glide: (forward) =>
        frame.current?.scrollBy({ top: (forward ? 1 : -1) * frame.current.clientHeight * GLIDE, behavior: "smooth" }),
      goTo: (location) => {
        const target = pdfPage(location, doc.numPages);
        frame.current?.scrollTo({ top: tops[target - 1]! - GAP, behavior: "smooth" });
      },
      apart: (a, b) => Math.abs(pdfPage(a, doc.numPages) - pdfPage(b, doc.numPages)),
      search,
    }),
    [doc, width, aspects, search],
  );

  const origin = preview && frame.current
    ? `${preview.focal.x + frame.current.scrollLeft}px ${preview.focal.y + frame.current.scrollTop}px`
    : undefined;
  return (
    <div className={`pdf-scroll ${dark ? "pdf-dark" : ""}`} ref={frame} onClick={(e) => onPageClick(e.nativeEvent)}>
      <div
        className="pdf-column"
        style={{
          height: total,
          width: columnWidth,
          ...(preview ? { transform: `scale(${preview.scale})`, transformOrigin: origin } : {}),
        }}
      >
        {width > 0 &&
          tops.map((y, i) => (
            <div key={i} className="pdf-slot" style={{ top: y, width, height: aspects[i]! * width }}>
              {near.has(i + 1) && (
                <PdfPage
                  doc={doc}
                  number={i + 1}
                  width={width}
                  marks={marks.get(i + 1)}
                  dark={dark}
                  found={mark?.page === i + 1 ? mark : undefined}
                />
              )}
            </div>
          ))}
      </div>
    </div>
  );
}
