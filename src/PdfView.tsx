import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { pdfjs } from "./pdf";
import { pdfPage, pdfPosition } from "./format";
import { attachPinch, MAX_ZOOM, MIN_ZOOM, type Focal } from "./pinch";
import { isPageTap, type ViewerHandle, type ViewerProps } from "./viewer";

/** Keeps zoomed canvases within what phones can allocate. */
const MAX_CANVAS = 4096;

/** Renders one page into a canvas `width` CSS pixels wide (or fitted into width×height). */
function PageCanvas({ doc, number, width, height }: { doc: PDFDocumentProxy; number: number; width: number; height?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const target = canvas.current;
    if (!target || width <= 0) return;
    let task: RenderTask | undefined;
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
      target.style.width = `${Math.floor(cssWidth)}px`;
      target.style.height = `${Math.floor(base.height * scale)}px`;
      task = page.render({ canvas: target, viewport });
      task.promise.catch(() => {});
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, number, width, height]);
  return <canvas ref={canvas} className="pdf-page" />;
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
  { data, initial, layout, dark, zoom, onMove, onError, onTap, onPinch },
  ref,
) {
  const [doc, setDoc] = useState<PDFDocumentProxy>();
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

  if (!doc || !page) return <div className="pdf-frame" />;
  const shared = { doc, page, setPage, dark, zoom, handle: ref, onTap, onPinch };
  return layout === "scroll" ? <PdfScroll {...shared} aspects={aspects} /> : <PdfPages {...shared} />;
});

interface LayoutProps {
  doc: PDFDocumentProxy;
  page: number;
  setPage: React.Dispatch<React.SetStateAction<number>>;
  dark: boolean;
  zoom: number;
  handle: React.ForwardedRef<ViewerHandle>;
  onTap: () => void;
  onPinch: ViewerProps["onPinch"];
}

function PdfPages({ doc, page, setPage, dark, zoom, handle, onTap, onPinch }: LayoutProps) {
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
      goTo: (location) => setPage(pdfPage(location, pages)),
    }),
    [pages, setPage],
  );
  return (
    <div
      className={`pdf-frame ${dark ? "pdf-dark" : ""}`}
      ref={frame}
      onClick={(e) => isPageTap(e.nativeEvent) && onTap()}
    >
      <div
        className="pdf-fit"
        style={preview ? { transform: `scale(${preview.scale})`, transformOrigin: `${preview.focal.x}px ${preview.focal.y}px` } : undefined}
      >
        <PageCanvas doc={doc} number={page} width={size.width * zoom} height={size.height * zoom} />
      </div>
    </div>
  );
}

const GAP = 12;

/** A continuous column of pages. Only pages near the screen are rendered. */
function PdfScroll({ doc, page, setPage, dark, zoom, handle, aspects, onTap, onPinch }: LayoutProps & { aspects: number[] }) {
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
      goTo: (location) => {
        const target = pdfPage(location, doc.numPages);
        frame.current?.scrollTo({ top: tops[target - 1]! - GAP, behavior: "smooth" });
      },
    }),
    [doc, width, aspects],
  );

  const origin = preview && frame.current
    ? `${preview.focal.x + frame.current.scrollLeft}px ${preview.focal.y + frame.current.scrollTop}px`
    : undefined;
  return (
    <div className={`pdf-scroll ${dark ? "pdf-dark" : ""}`} ref={frame} onClick={(e) => isPageTap(e.nativeEvent) && onTap()}>
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
              {near.has(i + 1) && <PageCanvas doc={doc} number={i + 1} width={width} />}
            </div>
          ))}
      </div>
    </div>
  );
}
