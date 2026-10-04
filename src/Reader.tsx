import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  message,
  onChanged,
  type Book,
  type Bookmark,
  type Highlight,
  type HighlightColor,
  type Paces,
  type Position,
  type Progress,
} from "./api";
import { EpubView, sectionOf } from "./EpubView";
import { PdfView } from "./PdfView";
import type { Jump, TocEntry, ViewerHandle } from "./viewer";
import { DisplaySheet } from "./DisplaySheet";
import { pageCss, SIZES, stepSize } from "./display";
import { clampZoom, stepZoom } from "./pinch";
import { useDisplay } from "./useDisplay";
import type { Rect, TextSelection } from "./highlights";
import { HighlightToolbar } from "./HighlightToolbar";
import { MarksPanel } from "./MarksPanel";
import { SearchPanel } from "./SearchPanel";
import type { SearchHit } from "./search";
import { currentEntry } from "./viewer";
import { add, amount, follow, rate, timeLeft, timeLeftLine, total, type Stretch } from "./pace";
import {
  Bookmark as BookmarkIcon,
  BookmarkCheck,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Search,
  X,
  List,
  Maximize2,
  Minimize2,
  Star,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Channel } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  book: Book;
  /** Open here instead of at the saved position, e.g. a highlight picked in the library. */
  at?: string;
  onClose: () => void;
}

// Android hides its system bars instead; the desktop window can go fullscreen.
const desktop = !/android/i.test(navigator.userAgent);

/** Reading on this many screens (EPUB) or pages (PDF) from a place looked at makes it the reader's. */
const READ_ON = 3;

/** How long the screen stays on without the reader touching the book. */
const AWAKE_FOR = 10 * 60 * 1000;

async function setFullscreen(on: boolean) {
  try {
    await getCurrentWindow().setFullscreen(on);
  } catch {}
}

export function Reader({ book, at, onClose }: Props) {
  const [data, setData] = useState<ArrayBuffer>();
  const [initial, setInitial] = useState<Progress | null>();
  const [error, setError] = useState<string>();
  const [position, setPosition] = useState<Position>();
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [favorite, setFavorite] = useState(book.favorite);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  // The table of contents: null until the book has been read for it.
  const [contents, setContents] = useState<TocEntry[] | null>(null);
  // Selected text offered for highlighting, or a highlight that was tapped.
  const [selection, setSelection] = useState<TextSelection | null>(null);
  const [menu, setMenu] = useState<{ id: string; rect: Rect; stacked?: string[] } | null>(null);
  const [remote, setRemote] = useState<Progress>();
  // Looking at a highlight, bookmark or search match: the reader's place (`back`) stays the saved
  // one until they read on from where they looked, choose to stay there, or go back.
  const look = useRef<{ back: Position; to: string; arrived: boolean } | null>(null);
  const [back, setBack] = useState<Position>();
  // Reading speed, for the time left: every device's, synced. `stretch` is the reading going on.
  const kind = book.format === "pdf" ? "pdf" : "epub";
  const [paces, setPaces] = useState<Paces>({ mine: null, others: [] });
  useEffect(() => void api.paces().then(setPaces, () => {}), []);
  const stretch = useRef<{ now: Stretch; size: number } | null>(null);
  const finish = useCallback(
    (done: Stretch, size: number) => {
      const { units, minutes } = amount(done, size);
      void (async () => {
        const latest = await api.paces();
        const before = latest.mine?.[kind] ?? undefined;
        const after = add(before, units, minutes, kind);
        // Not reading after all (a skim, a moment): nothing to save.
        if (after === before || (!before && !after.minutes)) return;
        const mine = { ...latest.mine, at: Date.now(), [kind]: after };
        await api.setPace(mine);
        setPaces({ ...latest, mine });
      })().catch(() => {});
    },
    [kind],
  );
  useEffect(
    () => () => {
      if (stretch.current) finish(stretch.current.now, stretch.current.size);
    },
    [finish],
  );
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
    Promise.all([api.readBook(book.id), api.progress(book.id), api.bookmarks(book.id), api.highlights(book.id)]).then(
      ([bytes, progress, marks, colored]) => {
        if (cancelled) return;
        setInitial(progress);
        saved.current = progress?.location;
        // A highlight picked in the library is a look too, if the book has a place to go back to.
        if (at && progress) setBack((look.current = { back: progress, to: at, arrived: false }).back);
        setBookmarks(marks);
        setHighlights(colored);
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
      if (changed.some((c) => c.kind === "favorite" && c.id === book.id)) {
        void api.books().then((books) => setFavorite(!!books.find((b) => b.id === book.id)?.favorite));
      }
      if (changed.some((c) => c.kind === "highlight")) void api.highlights(book.id).then(setHighlights);
      if (changed.some((c) => c.kind === "pace")) void api.paces().then(setPaces);
    });
    return () => void unlisten.then((f) => f());
  }, [book.id, onClose]);

  // Android: the screen stays on while reading, until the book goes untouched for a while (a
  // phone left on the table still sleeps). Touches, keys, scrolling and page turns count.
  const stir = useRef<() => void>(() => {});
  useEffect(() => {
    if (desktop || !display.keepAwake) return;
    let on = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wake = () => {
      if (!on) {
        on = true;
        void api.keepAwake(true).catch(() => {});
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        on = false;
        void api.keepAwake(false).catch(() => {});
      }, AWAKE_FOR);
    };
    stir.current = wake;
    wake();
    const events = ["pointerdown", "keydown", "wheel"] as const;
    events.forEach((type) => window.addEventListener(type, wake, { capture: true, passive: true }));
    return () => {
      events.forEach((type) => window.removeEventListener(type, wake, { capture: true }));
      clearTimeout(timer);
      stir.current = () => {};
      void api.keepAwake(false).catch(() => {});
    };
  }, [display.keepAwake]);

  // Android: the volume buttons turn pages, down forward and up back, while the book is open.
  useEffect(() => {
    if (desktop || !display.volumeKeys) return;
    const keys = new Channel<{ turn: "next" | "previous" }>((e) => {
      stir.current();
      viewer.current?.glide(e.turn === "next");
    });
    void api.volumeKeys(true, keys).catch(() => {});
    return () => void api.volumeKeys(false, keys).catch(() => {});
  }, [display.volumeKeys]);

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

  // A highlight's menu stays next to it only until the page moves.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    document.addEventListener("scroll", close, { capture: true, passive: true });
    return () => document.removeEventListener("scroll", close, { capture: true });
  }, [menu]);
  const floating = useRef(false);
  floating.current = !!selection || !!menu;

  // Searching the book: matches arrive as it's read through; one of them may be on screen.
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [done, setDone] = useState(1);
  const [active, setActive] = useState(-1);
  useEffect(() => {
    setHits([]);
    setActive(-1);
    if (query.trim().length < 2) return setDone(1);
    setDone(0);
    const stop = new AbortController();
    // Wait for typing to pause before reading the whole book.
    const start = setTimeout(() => {
      void viewer.current
        ?.search(
          query,
          (batch, progress) => {
            if (stop.signal.aborted) return;
            if (batch.length) setHits((old) => [...old, ...batch]);
            setDone(progress);
          },
          stop.signal,
        )
        .catch(() => setDone(1));
    }, 300);
    return () => {
      clearTimeout(start);
      stop.abort();
    };
  }, [query]);
  const showHit = (index: number) => {
    const hit = hits[index];
    if (!hit) return;
    setActive(index);
    setSearchOpen(false);
    jump(hit.location, "look");
  };
  const step = (by: 1 | -1) => hits.length && showHit((active + by + hits.length) % hits.length);
  const stepping = useRef<{ active: number; step: typeof step }>({ active, step });
  stepping.current = { active, step };

  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      // An open panel, popover or menu owns the keyboard (Escape closes it, not the book).
      if (e.target instanceof HTMLInputElement || document.querySelector('[role="dialog"], [role="menu"]')) return;
      if (e.key === "Escape" && floating.current) {
        e.preventDefault();
        setMenu(null);
        setSelection((s) => (s?.clear(), null));
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      // Stepping through matches: ⌘G and ⇧⌘G, as in other apps; Escape stops showing them.
      if (stepping.current.active >= 0 && ((mod && e.key.toLowerCase() === "g") || e.key === "Escape")) {
        e.preventDefault();
        if (e.key === "Escape") setActive(-1);
        else stepping.current.step(e.shiftKey ? -1 : 1);
        return;
      }
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
    (p: Position, moved: boolean) => {
      setPosition(p);
      stir.current();
      const opening = !opened.current;
      opened.current = true;
      // How far the reader gets in how long, from the moves they make themselves.
      const size = viewer.current?.length();
      if (size) {
        const next = follow(stretch.current?.now ?? null, p.fraction, Date.now(), size, moved);
        if (next.ended && stretch.current) finish(next.ended, stretch.current.size);
        stretch.current = { now: next.stretch, size };
      }
      // Opening at a highlight from the library is the reader going there.
      const save = moved || (opening && !!at);
      const visit = look.current;
      if (visit) {
        const apart = viewer.current?.apart(visit.to, p.location) ?? null;
        // Reports from the way there don't count, only reading on from the place itself.
        if (!visit.arrived) visit.arrived = apart !== null && apart < READ_ON;
        else if (moved && apart !== null && apart >= READ_ON) {
          look.current = null;
          setBack(undefined);
        }
      }
      if (!save) return;
      // Reading has started: get the controls out of the way. (A PDF's first page counts
      // as a saved position, so the very first report is only the book opening.)
      // Also ignore moves right after the controls appear: a trackpad's momentum keeps
      // scrolling after the tap that showed them.
      // Zooming re-anchors the scroll too; that isn't reading either.
      if (!opening && Date.now() - Math.max(shownAt.current, zoomedAt.current) > 2000) setChrome(false);
      if (look.current) return;
      saved.current = p.location;
      setRemote(undefined);
      api.setProgress(book.id, p).catch((e) => setError(message(e)));
    },
    [book.id, at, finish],
  );

  const onError = useCallback((e: unknown) => setError(message(e)), []);
  const onTap = useCallback(() => {
    stir.current();
    if (floating.current) {
      setMenu(null);
      return;
    }
    setChrome((shown) => !shown);
  }, []);
  const onSelect = useCallback((s: TextSelection | null) => {
    setSelection(s);
    if (s) setMenu(null);
  }, []);
  const onHighlightTap = useCallback((id: string, rect: Rect, stacked?: string[]) => setMenu({ id, rect, stacked }), []);
  const onContents = useCallback((entries: TocEntry[]) => setContents(entries), []);

  const refreshHighlights = () => api.highlights(book.id).then(setHighlights);
  const attempt = async (work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (e) {
      setError(message(e));
    }
  };
  const highlightSelection = (color: HighlightColor) => {
    const s = selection;
    if (!s) return;
    void attempt(async () => {
      const { location, text, label, fraction } = s.joins ?? s;
      const added = await api.addHighlight(book.id, { location, text, color, label, fraction });
      // The highlights it was drawn over are part of it now.
      for (const id of s.joins?.ids ?? []) if (id !== added.id) await api.removeHighlight(id);
      s.clear();
      setSelection(null);
      await refreshHighlights();
    });
  };
  const recolor = (id: string, color: HighlightColor) =>
    void attempt(async () => {
      await api.recolorHighlight(id, color);
      await refreshHighlights();
    });
  const removeHighlight = (id: string, stacked: string[] = []) =>
    void attempt(async () => {
      for (const one of [id, ...stacked]) await api.removeHighlight(one);
      setMenu(null);
      await refreshHighlights();
    });
  const copy = (text: string) =>
    void navigator.clipboard.writeText(text).then(
      () => showBadge("Copied"),
      () => setError("Couldn't copy the text"),
    );
  const tapped = menu ? highlights.find((h) => h.id === menu.id) : undefined;

  const toggleFavorite = () => {
    const next = !favorite;
    setFavorite(next);
    showBadge(next ? "Added to favorites" : "Removed from favorites");
    api.setFavorite(book.id, next).catch((e) => {
      setFavorite(!next);
      setError(message(e));
    });
  };

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

  const jump = (location: string, how: Jump = "read") => {
    if (how === "look") {
      // However many places the reader looks at, the way back is to where they were reading.
      const here = position ?? initial;
      if (look.current) look.current = { ...look.current, to: location, arrived: false };
      else if (here) setBack((look.current = { back: { ...here, location: saved.current ?? here.location }, to: location, arrived: false }).back);
    } else {
      look.current = null;
      setBack(undefined);
    }
    if (how === "follow") {
      saved.current = location;
      setRemote(undefined);
    }
    viewer.current?.goTo(location, how);
    setPanel(false);
  };
  const goBack = () => {
    const place = look.current?.back;
    look.current = null;
    setBack(undefined);
    if (place) viewer.current?.goTo(place.location, "look");
  };
  const stay = () => {
    look.current = null;
    setBack(undefined);
    if (!position) return;
    saved.current = position.location;
    api.setProgress(book.id, position).catch((e) => setError(message(e)));
  };

  const View = book.format === "pdf" ? PdfView : EpubView;

  const fraction = position?.fraction ?? initial?.fraction ?? 0;
  const length = position ? viewer.current?.length() : null;
  const reading = stretch.current && amount(stretch.current.now, stretch.current.size);
  const pace = reading ? add(total(paces, kind), reading.units, reading.minutes, kind) : total(paces, kind);
  const left = length ? timeLeftLine(timeLeft(fraction, length, contents, rate(pace, kind))) : null;
  // The page (PDF) or section (EPUB) being read, to mark the chapter in the contents.
  const here = position?.location ?? initial?.location;
  const place = !here ? 0 : pdf ? Number.parseInt(here, 10) || 1 : sectionOf(here);

  return (
    <div className="relative h-full overflow-hidden bg-card">
      <main className="absolute inset-x-0 top-[env(safe-area-inset-top)] bottom-[env(safe-area-inset-bottom)]">
        {error && <p className="m-4 mt-16 text-sm text-destructive">{error}</p>}
        {data && initial !== undefined && (
          <View
            ref={viewer}
            id={book.id}
            data={data}
            initial={at ?? initial?.location}
            resume={!at}
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
            highlights={highlights}
            onSelect={onSelect}
            onHighlightTap={onHighlightTap}
            onContents={onContents}
            found={active >= 0 ? (hits[active] ?? null) : null}
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
        <Button
          variant="ghost"
          size="icon-lg"
          className={cn(favorite && "text-amber-500")}
          onClick={toggleFavorite}
          aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
          aria-pressed={favorite}
        >
          <Star className={cn("size-5", favorite && "fill-current")} />
        </Button>
        <Button variant="ghost" size="icon-lg" onClick={() => setShowDisplay(true)} aria-label="Display settings">
          <Type className="size-5" />
        </Button>
        <Button variant="ghost" size="icon-lg" onClick={() => setSearchOpen(true)} aria-label="Search in book">
          <Search className="size-5" />
        </Button>
        <Button variant="ghost" size="icon-lg" onClick={() => setPanel(true)} aria-label="Contents, highlights and bookmarks">
          <List className="size-5" />
        </Button>
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
          <Button size="sm" onClick={() => jump(remote.location, "follow")}>
            Go there
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setRemote(undefined)}>
            Stay
          </Button>
        </div>
      )}

      {back && !remote && (
        <div
          role="toolbar"
          aria-label="Your place"
          className={cn(
            "absolute left-1/2 z-30 flex -translate-x-1/2 items-center gap-0.5 rounded-full border bg-popover/95 p-1 text-sm shadow-lg backdrop-blur transition-[top] duration-200",
            chrome ? "top-[calc(env(safe-area-inset-top)+3.75rem)]" : "top-[calc(env(safe-area-inset-top)+0.5rem)]",
          )}
        >
          <Button variant="ghost" size="sm" className="rounded-full" onClick={goBack}>
            <Undo2 />
            Back to {pdf ? `page ${Number.parseInt(back.location, 10) || 1}` : `${Math.round(back.fraction * 100)}%`}
          </Button>
          <Button variant="ghost" size="sm" className="rounded-full text-muted-foreground" onClick={stay}>
            Stay here
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
            {/* EPUB places already end in their percentage ("Chapter 3 · 37%"). */}
            {pdf && <span className="ml-2 tabular-nums">{Math.round(fraction * 100)}%</span>}
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
        {left && <p className="mt-1.5 truncate text-xs text-muted-foreground">{left}</p>}
      </footer>

      {badge && (
        <div
          className="pointer-events-none absolute top-1/2 left-1/2 z-30 -translate-1/2 rounded-full bg-foreground/80 px-4 py-2 text-sm font-medium text-background tabular-nums shadow-lg"
          role="status"
        >
          {badge}
        </div>
      )}

      {selection && !menu && (
        <HighlightToolbar
          rect={selection.rect}
          onPick={highlightSelection}
          onCopy={() => {
            copy(selection.text);
            selection.clear();
          }}
        />
      )}
      {menu && tapped && (
        <HighlightToolbar
          rect={menu.rect}
          current={tapped.color}
          onPick={(color) => {
            recolor(tapped.id, color);
            setMenu(null);
          }}
          onCopy={() => {
            copy(tapped.text);
            setMenu(null);
          }}
          onRemove={() => removeHighlight(tapped.id, menu.stacked)}
        />
      )}

      <SearchPanel
        open={searchOpen}
        onOpenChange={setSearchOpen}
        query={query}
        onQuery={setQuery}
        hits={hits}
        done={done}
        active={active}
        onPick={showHit}
        placeOf={(hit) => {
          if (pdf) return `Page ${hit.order}`;
          const percent = `${Math.round(hit.fraction * 100)}%`;
          const chapter = contents ? contents[currentEntry(contents, hit.order)]?.label : undefined;
          return chapter ? `${chapter} · ${percent}` : percent;
        }}
      />
      {active >= 0 && !searchOpen && (
        <div
          role="toolbar"
          aria-label="Search matches"
          className={cn(
            "absolute left-1/2 z-30 flex -translate-x-1/2 items-center gap-0.5 rounded-full border bg-popover/95 p-1 text-sm shadow-lg backdrop-blur transition-[bottom] duration-200",
            chrome ? "bottom-[calc(env(safe-area-inset-bottom)+5.5rem)]" : "bottom-[calc(env(safe-area-inset-bottom)+1rem)]",
          )}
        >
          <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Previous match" onClick={() => step(-1)}>
            <ChevronUp />
          </Button>
          <span className="min-w-16 px-1 text-center tabular-nums" aria-live="polite">
            {active + 1} of {hits.length}
          </span>
          <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Next match" onClick={() => step(1)}>
            <ChevronDown />
          </Button>
          <button
            type="button"
            className="max-w-36 truncate rounded-full px-2 py-1 text-muted-foreground hover:bg-accent"
            onClick={() => setSearchOpen(true)}
            aria-label={`Search: ${query}`}
          >
            “{query.trim()}”
          </button>
          <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Stop showing matches" onClick={() => setActive(-1)}>
            <X />
          </Button>
        </div>
      )}
      <MarksPanel
        open={panel}
        onOpenChange={setPanel}
        title={book.title}
        pdf={pdf}
        contents={contents}
        place={place}
        bookmarks={bookmarks}
        highlights={highlights}
        onJump={jump}
        onRemoveBookmark={(id) => void attempt(() => api.removeBookmark(id).then(() => api.bookmarks(book.id)).then(setBookmarks))}
        onRecolor={recolor}
        onRemoveHighlight={removeHighlight}
        onCopy={copy}
      />
      <DisplaySheet open={showDisplay} onOpenChange={setShowDisplay} reading />
    </div>
  );
}
