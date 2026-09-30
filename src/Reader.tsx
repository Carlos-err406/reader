import { useCallback, useEffect, useRef, useState } from "react";
import { api, message, onChanged, type Book, type Bookmark, type Position, type Progress } from "./api";
import { EpubView } from "./EpubView";
import { PdfView } from "./PdfView";
import type { ViewerHandle } from "./viewer";
import { DisplaySheet } from "./DisplaySheet";
import { pageCss, SIZES, stepSize } from "./display";
import { clampZoom, stepZoom } from "./pinch";
import { useDisplay } from "./useDisplay";
import {
  Bookmark as BookmarkIcon,
  BookmarkCheck,
  ChevronLeft,
  List,
  Maximize2,
  Minimize2,
  Trash2,
  Type,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface Props {
  book: Book;
  onClose: () => void;
}

// Android hides its system bars instead; the desktop window can go fullscreen.
const desktop = !/android/i.test(navigator.userAgent);

async function setFullscreen(on: boolean) {
  try {
    await getCurrentWindow().setFullscreen(on);
  } catch {}
}

export function Reader({ book, onClose }: Props) {
  const [data, setData] = useState<ArrayBuffer>();
  const [initial, setInitial] = useState<Progress | null>();
  const [error, setError] = useState<string>();
  const [position, setPosition] = useState<Position>();
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [remote, setRemote] = useState<Progress>();
  const [panel, setPanel] = useState(false);
  const [showDisplay, setShowDisplay] = useState(false);
  // The header and progress bar float over the page; tapping the page shows or hides them.
  const [chrome, setChrome] = useState(true);
  const shownAt = useRef(Date.now());
  const zoomedAt = useRef(0);
  useEffect(() => {
    if (chrome) shownAt.current = Date.now();
  }, [chrome]);
  const [fullscreen, setFullscreenState] = useState(false);
  const fullscreenOn = useRef(false);
  const toggleFullscreen = useCallback(() => {
    fullscreenOn.current = !fullscreenOn.current;
    setFullscreenState(fullscreenOn.current);
    void setFullscreen(fullscreenOn.current);
  }, []);
  const { display, setDisplay, dark, palette } = useDisplay();
  // PDFs magnify; reflowable books zoom by changing their (saved) text size.
  const pdf = book.format === "pdf";
  const [zoom, setZoom] = useState(1);
  const [badge, setBadge] = useState<string>();
  const zoomLevel = pdf ? Math.round(zoom * 100) : display.size;
  const showBadge = (text: string) => setBadge(text);
  useEffect(() => {
    if (!badge) return;
    const hide = setTimeout(() => setBadge(undefined), 900);
    return () => clearTimeout(hide);
  }, [badge]);
  const applyZoom = useCallback(
    (next: { pdf?: number; size?: number }) => {
      zoomedAt.current = Date.now();
      if (next.pdf !== undefined) {
        setZoom(next.pdf);
        showBadge(`${Math.round(next.pdf * 100)}%`);
      }
      if (next.size !== undefined) {
        setDisplay({ size: next.size });
        showBadge(`Text ${next.size}%`);
      }
    },
    [setDisplay],
  );
  const zoomStep = useCallback(
    (direction: 1 | -1) =>
      pdf ? applyZoom({ pdf: stepZoom(zoom, direction) }) : applyZoom({ size: stepSize(display.size, direction) }),
    [pdf, zoom, display.size, applyZoom],
  );
  const zoomReset = useCallback(() => (pdf ? applyZoom({ pdf: 1 }) : applyZoom({ size: 100 })), [pdf, applyZoom]);
  const onPinch = useCallback((scale: number) => applyZoom({ pdf: clampZoom(zoom * scale) }), [zoom, applyZoom]);
  // The book resizes itself live while pinching; the setting is saved when the fingers lift.
  const onTextSize = useCallback(
    (size: number, final: boolean) => {
      zoomedAt.current = Date.now();
      if (final) applyZoom({ size });
      else setBadge(`Text ${size}%`);
    },
    [applyZoom],
  );
  const cssFor = useCallback((size: number) => pageCss({ ...display, size }, palette), [display, palette]);
  const css = pageCss(display, palette);
  const viewer = useRef<ViewerHandle>(null);
  // The position this device last saved (or opened at). Page starts shown on screen can
  // differ from it without the reader having moved.
  const saved = useRef<string | undefined>(undefined);
  const opened = useRef(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.readBook(book.id), api.progress(book.id), api.bookmarks(book.id)]).then(
      ([bytes, progress, marks]) => {
        if (cancelled) return;
        setInitial(progress);
        saved.current = progress?.location;
        setBookmarks(marks);
        setData(bytes);
      },
      (e) => !cancelled && setError(message(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [book.id]);

  // Another device moved on: offer its page rather than yanking the reader there.
  useEffect(() => {
    const unlisten = onChanged((changed) => {
      if (changed.some((c) => c.kind === "book" && c.id === book.id)) {
        void api.books().then((books) => !books.some((b) => b.id === book.id) && onClose());
      }
      if (changed.some((c) => c.kind === "progress" && c.id === book.id)) {
        void api.progress(book.id).then((p) => {
          if (p && p.location !== saved.current) setRemote(p);
        });
      }
      if (changed.some((c) => c.kind === "bookmark")) void api.bookmarks(book.id).then(setBookmarks);
    });
    return () => void unlisten.then((f) => f());
  }, [book.id, onClose]);

  // Android's status and navigation bars follow the reader's own controls.
  useEffect(() => {
    void api.setImmersive(!chrome).catch(() => {});
  }, [chrome]);
  useEffect(
    () => () => {
      void api.setImmersive(false).catch(() => {});
      void setFullscreen(false);
    },
    [],
  );

  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      // An open panel, popover or menu owns the keyboard (Escape closes it, not the book).
      if (e.target instanceof HTMLInputElement || document.querySelector('[role="dialog"], [role="menu"]')) return;
      if (["ArrowRight", "PageDown", " "].includes(e.key)) viewer.current?.next();
      else if (["ArrowLeft", "PageUp"].includes(e.key)) viewer.current?.prev();
      else if (e.key === "Escape" && fullscreen) toggleFullscreen();
      else if (e.key === "Escape") onClose();
      else if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "+")) zoomStep(1);
      else if ((e.metaKey || e.ctrlKey) && e.key === "-") zoomStep(-1);
      else if ((e.metaKey || e.ctrlKey) && e.key === "0") zoomReset();
      else if (desktop && (e.key === "f" || e.key === "F11")) toggleFullscreen();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, [onClose, fullscreen, toggleFullscreen, zoomStep, zoomReset]);

  const onMove = useCallback(
    (p: Position, save: boolean) => {
      setPosition(p);
      const opening = !opened.current;
      opened.current = true;
      if (!save) return;
      // Reading has started: get the controls out of the way. (A PDF's first page counts
      // as a saved position, so the very first report is only the book opening.)
      // Also ignore moves right after the controls appear: a trackpad's momentum keeps
      // scrolling after the tap that showed them.
      // Zooming re-anchors the scroll too; that isn't reading either.
      if (!opening && Date.now() - Math.max(shownAt.current, zoomedAt.current) > 2000) setChrome(false);
      saved.current = p.location;
      setRemote(undefined);
      api.setProgress(book.id, p).catch((e) => setError(message(e)));
    },
    [book.id],
  );

  const onError = useCallback((e: unknown) => setError(message(e)), []);
  const onTap = useCallback(() => setChrome((shown) => !shown), []);

  const marked = bookmarks.find((b) => b.location === position?.location);
  const toggleBookmark = async () => {
    if (!position) return;
    try {
      if (marked) await api.removeBookmark(marked.id);
      else await api.addBookmark(book.id, position);
      setBookmarks(await api.bookmarks(book.id));
    } catch (e) {
      setError(message(e));
    }
  };

  const jump = (location: string, save = true) => {
    if (!save) {
      saved.current = location;
      setRemote(undefined);
    }
    viewer.current?.goTo(location, save);
    setPanel(false);
  };

  const View = book.format === "pdf" ? PdfView : EpubView;

  const fraction = position?.fraction ?? initial?.fraction ?? 0;

  return (
    <div className="relative h-full overflow-hidden bg-card">
      <main className="absolute inset-x-0 top-[env(safe-area-inset-top)] bottom-[env(safe-area-inset-bottom)]">
        {error && <p className="m-4 mt-16 text-sm text-destructive">{error}</p>}
        {data && initial !== undefined && (
          <View
            ref={viewer}
            id={book.id}
            data={data}
            initial={initial?.location}
            layout={display.layout}
            css={css}
            dark={dark}
            onMove={onMove}
            onError={onError}
            onTap={onTap}
            zoom={zoom}
            onPinch={onPinch}
            cssFor={cssFor}
            textSize={display.size}
            onTextSize={onTextSize}
          />
        )}
        {display.layout === "pages" && (
          <>
            <button className="turn prev" onClick={() => viewer.current?.prev()} aria-label="Previous page" />
            <button className="turn next" onClick={() => viewer.current?.next()} aria-label="Next page" />
          </>
        )}
      </main>

      <header
        inert={!chrome}
        className={cn(
          "absolute inset-x-0 top-0 z-20 flex items-center gap-1 border-b bg-card/95 px-2 pt-[calc(env(safe-area-inset-top)+0.25rem)] pb-1 shadow-sm backdrop-blur transition-transform duration-200",
          !chrome && "-translate-y-full",
        )}
      >
        <Button variant="ghost" size="icon-lg" onClick={onClose} aria-label="Back to library">
          <ChevronLeft className="size-6" />
        </Button>
        <strong className="min-w-0 flex-1 truncate text-center">{book.title}</strong>
        <Button
          variant="ghost"
          size="icon-lg"
          className={cn(marked && "text-warm")}
          onClick={toggleBookmark}
          disabled={!position}
          aria-label={marked ? "Remove bookmark" : "Add bookmark"}
          aria-pressed={!!marked}
        >
          {marked ? <BookmarkCheck className="size-5 fill-current" /> : <BookmarkIcon className="size-5" />}
        </Button>
        <Button variant="ghost" size="icon-lg" onClick={() => setShowDisplay(true)} aria-label="Display settings">
          <Type className="size-5" />
        </Button>
        <Popover open={panel} onOpenChange={setPanel}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-lg" aria-label="Bookmarks">
              <List className="size-5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 bg-card p-0">
            <h2 className="border-b px-4 py-3 text-sm font-semibold">Bookmarks</h2>
            {bookmarks.length === 0 ? (
              <p className="px-4 py-4 text-sm text-muted-foreground">
                Tap <BookmarkIcon className="inline size-4 align-text-bottom" /> to bookmark where you are.
              </p>
            ) : (
              <ul className="max-h-80 overflow-y-auto py-1">
                {bookmarks.map((b) => (
                  <li key={b.id} className="flex items-center gap-1 px-2">
                    <Button variant="ghost" className="min-w-0 flex-1 justify-start font-normal" onClick={() => jump(b.location)}>
                      <span className="truncate">{b.label}</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground"
                      aria-label={`Delete bookmark ${b.label}`}
                      onClick={() => api.removeBookmark(b.id).then(() => api.bookmarks(book.id)).then(setBookmarks)}
                    >
                      <Trash2 />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </PopoverContent>
        </Popover>
        {desktop && (
          <Button
            variant="ghost"
            size="icon-lg"
            onClick={toggleFullscreen}
            aria-label={fullscreen ? "Exit full screen" : "Full screen"}
            aria-pressed={fullscreen}
          >
            {fullscreen ? <Minimize2 className="size-5" /> : <Maximize2 className="size-5" />}
          </Button>
        )}
      </header>

      {remote && (
        <div
          className={cn(
            "absolute inset-x-2 z-30 flex flex-wrap items-center gap-2 rounded-lg border bg-card/95 px-3 py-2 text-sm shadow-md backdrop-blur transition-[top] duration-200",
            chrome ? "top-[calc(env(safe-area-inset-top)+3.5rem)]" : "top-[calc(env(safe-area-inset-top)+0.5rem)]",
          )}
          role="status"
        >
          <span className="min-w-48 flex-1">Another device is at {remote.label}.</span>
          <Button size="sm" onClick={() => jump(remote.location, false)}>
            Go there
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setRemote(undefined)}>
            Stay
          </Button>
        </div>
      )}

      <footer
        inert={!chrome}
        className={cn(
          "absolute inset-x-0 bottom-0 z-20 border-t bg-card/95 px-4 pt-2.5 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] backdrop-blur transition-transform duration-200",
          !chrome && "translate-y-full",
        )}
      >
        <div className="mb-1.5 flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">
            {position?.label ?? initial?.label ?? "Opening…"}
            <span className="ml-2 tabular-nums">{Math.round(fraction * 100)}%</span>
          </span>
          <div className="flex shrink-0 items-center" role="group" aria-label={pdf ? "Zoom" : "Text size"}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={pdf ? "Zoom out" : "Smaller text"}
              disabled={pdf ? zoom <= 0.5 : display.size <= SIZES[0]}
              onClick={() => zoomStep(-1)}
            >
              <ZoomOut />
            </Button>
            <button
              className="w-12 rounded-md py-1 text-center tabular-nums hover:bg-accent"
              onClick={zoomReset}
              aria-label={pdf ? "Fit to screen" : "Reset text size"}
              title={pdf ? "Fit to screen" : "Reset text size"}
            >
              {zoomLevel}%
            </button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={pdf ? "Zoom in" : "Larger text"}
              disabled={pdf ? zoom >= 4 : display.size >= SIZES[SIZES.length - 1]!}
              onClick={() => zoomStep(1)}
            >
              <ZoomIn />
            </Button>
          </div>
        </div>
        <div className="meter">
          <div style={{ width: `${Math.round(fraction * 100)}%` }} />
        </div>
      </footer>

      {badge && (
        <div
          className="pointer-events-none absolute top-1/2 left-1/2 z-30 -translate-1/2 rounded-full bg-foreground/80 px-4 py-2 text-sm font-medium text-background tabular-nums shadow-lg"
          role="status"
        >
          {badge}
        </div>
      )}

      <DisplaySheet open={showDisplay} onOpenChange={setShowDisplay} reading />
    </div>
  );
}
