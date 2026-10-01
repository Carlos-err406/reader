import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpDown,
  Check,
  BookDashed,
  BookOpen,
  CircleCheck,
  EllipsisVertical,
  FileDown,
  Highlighter,
  Info,
  Library as Library_,
  Plus,
  RotateCcw,
  Search,
  Star,
  StarOff,
  Pencil,
  ChevronDown,
  SquareCheck,
  Tag,
  Trash2,
  Type,
  X,
} from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useMedia } from "@/hooks/useMedia";
import { cn } from "@/lib/utils";
import { api, message, onChanged as onRecordsChanged, type Book, type Collection, type Status } from "./api";
import { ago, day, size, statusLine } from "./format";
import {
  collectionShelf,
  continueReading,
  counts,
  loadView,
  onShelf,
  shelfCollection,
  matches,
  saveView,
  SECTIONS,
  sortBooks,
  SORTS,
  type LibraryView,
  type Section,
  type Shelf,
  type Sort,
} from "./shelves";
import { CollectionsSheet } from "./CollectionsSheet";
import { NameDialog } from "@/components/NameDialog";
import { Panel, useBackCloses } from "@/components/Panel";
import { readMetadata } from "./metadata";
import { cachedCover, loadCover, makeCover } from "./covers";
import { SyncPanel } from "./SyncPanel";
import { DisplaySheet } from "./DisplaySheet";
import { UpdateBanner } from "./UpdateBanner";
import { AboutSheet } from "./AboutSheet";
import { HighlightsSheet } from "./HighlightsSheet";
import { usePullToSync } from "./usePullToSync";
import { PullIndicator } from "./PullIndicator";

interface Props {
  books: Book[];
  status?: Status;
  onStatus: (status: Status) => void;
  onOpen: (book: Book, at?: string) => void;
  onChanged: () => void;
}

const hue = (id: string) => parseInt(id.slice(0, 6), 16) % 360;

/** The book's own cover once rendered; until then (or without one) a coloured title card. */
function Cover({ book, large = false }: { book: Book; large?: boolean }) {
  const [url, setUrl] = useState(() => cachedCover(book.id));
  useEffect(() => {
    let live = true;
    if (book.cover === true) void loadCover(book.id).then((u) => live && setUrl(u));
    // Rendered here the first time: books imported elsewhere arrive without one.
    else if (book.cover === null && book.available) void makeCover(book).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [book.id, book.cover, book.available]);

  const frame = cn(
    "shrink-0 overflow-hidden rounded-[3px_6px_6px_3px] shadow-[0_1px_4px_rgba(0,0,0,0.25)]",
    large ? "h-[150px] w-[100px]" : "h-[108px] w-[72px]",
  );
  if (url) return <img src={url} alt="" className={cn(frame, "object-cover")} />;
  return (
    <div
      className={cn(frame, "flex flex-col justify-between p-2 text-white shadow-[inset_4px_0_0_rgba(0,0,0,0.18),0_1px_4px_rgba(0,0,0,0.25)]")}
      style={{ background: `hsl(${hue(book.id)} 35% 38%)` }}
    >
      <span className="line-clamp-5 font-serif text-[0.65rem] leading-tight">{book.title}</span>
      <em className="text-[0.55rem] tracking-widest not-italic opacity-80">{book.format.toUpperCase()}</em>
    </div>
  );
}

export function Library({ books, status, onStatus, onOpen, onChanged }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState<string>();
  const [error, setError] = useState<string>();
  const [showSync, setShowSync] = useState(false);
  const [showDisplay, setShowDisplay] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showHighlights, setShowHighlights] = useState(false);
  const [removing, setRemoving] = useState<Book>();
  const [refreshing, setRefreshing] = useState(false);
  const [dropping, setDropping] = useState(false);
  const wide = useMedia("(min-width: 768px)");
  const [view, setViewState] = useState<LibraryView>(loadView);
  const setView = (patch: Partial<LibraryView>) =>
    setViewState((old) => {
      const next = { ...old, ...patch };
      saveView(next);
      return next;
    });
  const [query, setQuery] = useState("");

  // Collections, kept fresh as this or the other device changes them.
  const [collections, setCollections] = useState<Collection[]>();
  const loadCollections = useCallback(() => {
    api.collections().then(setCollections, (e) => setError(message(e)));
  }, []);
  useEffect(() => {
    loadCollections();
    const unlisten = onRecordsChanged((changed) => {
      if (changed.some((c) => ["collection", "member", "book"].includes(c.kind))) loadCollections();
    });
    return () => void unlisten.then((f) => f());
  }, [loadCollections]);
  const [filing, setFiling] = useState<Book[]>([]);
  // Selecting books for one action on all of them; null when not selecting.
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const selecting = selected !== null;
  useBackCloses(selecting, (on) => !on && setSelected(null));
  const [removingMany, setRemovingMany] = useState<Book[]>([]);
  // Phones keep everything but the books in one sheet, and search behind a button.
  const [showMenu, setShowMenu] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [naming, setNaming] = useState<{ rename?: Collection } | null>(null);
  const [deleting, setDeleting] = useState<Collection>();

  // A collection deleted (here or elsewhere) while open falls back to all books.
  const opened = shelfCollection(view.section, collections ?? []);
  const section: Shelf = view.section.startsWith("c:") && collections && !opened ? "all" : view.section;
  const builtIn = SECTIONS.find((s) => s.id === section);
  const current = builtIn ?? {
    id: section,
    name: opened?.name ?? "Collection",
    empty: "No books here yet. Add one from its ⋯ menu, under Collections.",
  };
  const sortName = SORTS.find((s) => s.id === view.sort)!.name;
  const tally = counts(books);
  const searching = query.trim().length > 0;
  // Continue reading leads All and Reading, unless searching; it isn't repeated in the list.
  const resume = !searching && (section === "all" || section === "reading") ? continueReading(books) : undefined;
  const shown = sortBooks(
    books.filter((b) => onShelf(b, section, collections ?? []) && matches(b, query) && b.id !== resume?.id),
    view.sort,
  );
  const actionsFor = (book: Book): BookActions => ({
    onCollections: () => setFiling([book]),
    onFavorite: (on) => void mark(api.setFavorite(book.id, on)),
    onFinished: (on) => void mark(api.setFinished(book.id, on)),
    onRemove: () => setRemoving(book),
  });
  const tagsOf = (book: Book) => (collections ?? []).filter((c) => c.books.includes(book.id)).map((c) => c.name);
  const picked = books.filter((b) => selected?.has(b.id));
  const toggleSelected = (book: Book) =>
    setSelected((old) => {
      const next = new Set(old ?? []);
      if (next.has(book.id)) next.delete(book.id);
      else next.add(book.id);
      return next;
    });
  // The continue-reading book stays put while selecting (nothing jumps under the finger), and
  // can be selected like the rest.
  const selectable = resume ? [resume, ...shown] : shown;
  const allPicked = selectable.length > 0 && selectable.every((b) => selected?.has(b.id));
  const favoritePicked = picked.length > 0 && picked.every((b) => b.favorite);
  const favoriteMany = () => void mark(Promise.all(picked.map((b) => api.setFavorite(b.id, !favoritePicked))).then(() => {}));
  const removeMany = async (list: Book[]) => {
    for (const b of list) await remove(b);
    setSelected(null);
  };
  useEffect(() => {
    if (!selecting) return;
    const keys = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      setSelected(null);
    };
    // Capturing runs before an open sheet's own Escape handling, while it's still on screen.
    window.addEventListener("keydown", keys, { capture: true });
    return () => window.removeEventListener("keydown", keys, { capture: true });
  }, [selecting]);
  // Long press, then drag without lifting: every book between the pressed one and the finger
  // is selected, as in photo galleries. Near the top or bottom of the screen the list scrolls.
  const latestShown = useRef(shown);
  latestShown.current = shown;
  const latestSelected = useRef(selected);
  latestSelected.current = selected;
  const sweep = useRef<{ anchor: number; last: number; base: Set<string>; x: number; y: number; moved: boolean } | null>(null);
  const sweepTo = (index: number) => {
    const s = sweep.current;
    if (!s) return;
    const [from, to] = s.anchor < index ? [s.anchor, index] : [index, s.anchor];
    const next = new Set(s.base);
    for (const b of latestShown.current.slice(from, to + 1)) next.add(b.id);
    setSelected(next);
  };
  const startSweep = (book: Book, x: number, y: number) => {
    const anchor = latestShown.current.findIndex((b) => b.id === book.id);
    if (anchor < 0) return;
    sweep.current = { anchor, last: anchor, base: new Set(latestSelected.current ?? []), x, y, moved: false };
    sweepTo(anchor);
  };
  useEffect(() => {
    let frame = 0;
    const under = (x: number, y: number) => {
      const card = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-book-id]");
      return card ? latestShown.current.findIndex((b) => b.id === card.dataset.bookId) : -1;
    };
    // The selection bar covers the bottom of the screen: the list ends at its top.
    const bottom = () =>
      document.querySelector('[role="toolbar"][aria-label="Selected books"]')?.getBoundingClientRect().top ?? window.innerHeight;
    const follow = () => {
      const s = sweep.current;
      if (!s) return;
      const index = under(s.x, Math.min(s.y, bottom() - 8));
      if (index >= 0 && index !== s.last) {
        s.last = index;
        sweepTo(index);
      }
    };
    const scroll = () => {
      frame = 0;
      const s = sweep.current;
      if (!s) return;
      const edge = 96;
      const end = bottom();
      const speed = s.y < edge ? -(edge - s.y) : s.y > end - edge ? Math.min(edge, s.y - (end - edge)) : 0;
      if (!speed) return;
      window.scrollBy(0, (speed / edge) * 18);
      follow();
      frame = requestAnimationFrame(scroll);
    };
    const move = (e: TouchEvent) => {
      const s = sweep.current;
      if (!s || !e.touches[0]) return;
      // The finger selects instead of scrolling the page.
      e.preventDefault();
      s.x = e.touches[0].clientX;
      s.y = e.touches[0].clientY;
      s.moved = true;
      follow();
      if (!frame) frame = requestAnimationFrame(scroll);
    };
    const end = () => {
      const s = sweep.current;
      if (!s) return;
      sweep.current = null;
      cancelAnimationFrame(frame);
      frame = 0;
      // Lifting the finger over another book mustn't also tap it.
      if (s.moved) {
        const swallow = (e: MouseEvent) => {
          e.stopPropagation();
          e.preventDefault();
        };
        window.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 400);
      }
    };
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", end);
    window.addEventListener("touchcancel", end);
    return () => {
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", end);
      window.removeEventListener("touchcancel", end);
      cancelAnimationFrame(frame);
    };
  }, []);

  const attention = status && ["warn", "error"].includes(statusLine(status).tone);
  const pick = (shelf: Shelf) => {
    setView({ section: shelf });
    setShowMenu(false);
  };

  const saveName = async (name: string) => {
    if (naming?.rename) await api.renameCollection(naming.rename.id, name);
    else setView({ section: collectionShelf((await api.createCollection(name)).id) });
    loadCollections();
  };

  const pullSync = useCallback(() => {
    setRefreshing(true);
    api.syncNow().then(onStatus, (e) => setError(message(e)));
  }, [onStatus]);
  const pull = usePullToSync(pullSync, !!status?.enabled && !showSync && !showDisplay && !selecting);
  // Like native pull-to-refresh: the page stays lowered, spinner in the gap, until the sync ends.
  const offset = pull || (refreshing ? 56 : 0);

  // Keep the pill up until the sync it started finishes (and at least briefly, so it registers).
  const syncing = !!status?.syncing;
  useEffect(() => {
    if (!refreshing || syncing) return;
    const done = setTimeout(() => setRefreshing(false), 900);
    return () => clearTimeout(done);
  }, [refreshing, syncing]);

  const importFiles = async (files: FileList | File[] | null) => {
    setError(undefined);
    for (const file of Array.from(files ?? [])) {
      setImporting(file.name);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const book = await api.importBook(bytes, await readMetadata(file, bytes));
        if (book.cover === null) void makeCover(book, bytes).then(onChanged);
      } catch (e) {
        setError(`${file.name}: ${message(e)}`);
      }
    }
    setImporting(undefined);
    if (input.current) input.current.value = "";
    onChanged();
  };

  // Books dragged in from Finder (or any file manager) are imported like picked ones.
  const latestImport = useRef(importFiles);
  latestImport.current = importFiles;
  useEffect(() => {
    const files = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    // Entering and leaving child elements fire in pairs; only the outermost pair counts.
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      depth++;
      setDropping(true);
    };
    const over = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const leave = (e: DragEvent) => {
      if (!files(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDropping(false);
    };
    const drop = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      depth = 0;
      setDropping(false);
      if (e.dataTransfer?.files.length) void latestImport.current(Array.from(e.dataTransfer.files));
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);

  const mark = async (work: Promise<void>) => {
    try {
      await work;
      onChanged();
    } catch (e) {
      setError(message(e));
    }
  };

  const remove = async (book: Book) => {
    try {
      await api.removeBook(book.id);
      onChanged();
    } catch (e) {
      setError(message(e));
    }
  };

  const nav = (onPicked: (shelf: Shelf) => void, then: (open: () => void) => void) => (
    <ShelfNav
      section={section}
      tally={tally}
      collections={collections}
      highlights={status?.library.highlights ?? 0}
      onPick={onPicked}
      onNewCollection={() => then(() => setNaming({}))}
      onHighlights={() => then(() => setShowHighlights(true))}
    />
  );
  // From the phone's sheet: close it, then open what was picked in its place.
  const fromMenu = (open: () => void) => {
    setShowMenu(false);
    open();
  };

  return (
    <>
      {dropping && (
        <div className="pointer-events-none fixed inset-3 z-50 grid place-items-center rounded-2xl border-2 border-dashed border-primary bg-background/85 backdrop-blur-sm">
          <div className="grid justify-items-center gap-2 text-center">
            <FileDown className="size-10 text-primary" />
            <strong className="font-serif text-xl">Drop to add to your library</strong>
            <span className="text-sm text-muted-foreground">PDF and EPUB books</span>
          </div>
        </div>
      )}
      {(pull > 0 || refreshing) && (
        <PullIndicator
          pull={pull}
          syncing={refreshing && !pull}
          top={`calc(env(safe-area-inset-top) + ${Math.max(4, offset - 44)}px)`}
        />
      )}
      <div
        className={cn(
          "library mx-auto max-w-6xl px-4 pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-[calc(env(safe-area-inset-bottom)+2rem)]",
          !pull && "settling",
          selecting && "pb-[calc(env(safe-area-inset-bottom)+6rem)]",
        )}
        style={offset ? { transform: `translateY(${offset}px)` } : undefined}
      >
        <div className="md:flex md:gap-8">
          {wide && (
            <aside className="sticky top-4 w-52 shrink-0 self-start pt-2" aria-label="Library sections">
              <h1 className="mb-4 px-3 font-serif text-3xl font-semibold">Library</h1>
              {nav((shelf) => setView({ section: shelf }), (open) => open())}
            </aside>
          )}

          <div className="min-w-0 flex-1">
            <header className="flex items-center gap-2 pt-2 pb-3">
              {wide ? (
                <div className="flex min-w-0 flex-1 items-center gap-1">
                  <h2 className="truncate font-serif text-2xl font-semibold">{current.name}</h2>
                  {opened && <CollectionMenu collection={opened} onRename={() => setNaming({ rename: opened })} onDelete={() => setDeleting(opened)} />}
                </div>
              ) : (
                <div className="flex min-w-0 flex-1 items-center">
                  <button
                    type="button"
                    onClick={() => setShowMenu(true)}
                    aria-haspopup="dialog"
                    aria-label={`${section === "all" ? "Library" : current.name}: sections, collections and settings${attention ? " (sync needs attention)" : ""}`}
                    className="relative flex min-w-0 items-center gap-1 rounded-md text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
                  >
                    <h1 className="truncate font-serif text-[1.55rem] font-semibold">{section === "all" ? "Library" : current.name}</h1>
                    <ChevronDown className="size-5 shrink-0 text-muted-foreground" />
                    {attention && status && <span className={cn("dot absolute -top-0.5 -right-2", statusLine(status).tone)} />}
                  </button>
                  {opened && <CollectionMenu collection={opened} onRename={() => setNaming({ rename: opened })} onDelete={() => setDeleting(opened)} />}
                </div>
              )}
              {wide ? (
                <Button
                  variant="outline"
                  size="icon"
                  className="rounded-full bg-card"
                  onClick={() => setShowDisplay(true)}
                  aria-label="Display settings"
                >
                  <Type />
                </Button>
              ) : (
                books.length > 0 && (
                  <Button
                    variant="outline"
                    size="icon"
                    className="rounded-full bg-card"
                    onClick={() => {
                      if (searchOpen) setQuery("");
                      setSearchOpen(!searchOpen);
                    }}
                    aria-label="Search books"
                    aria-pressed={searchOpen}
                  >
                    {searchOpen ? <X /> : <Search />}
                  </Button>
                )
              )}
              <Button
                className="rounded-full max-sm:size-9 max-sm:px-0"
                onClick={() => input.current?.click()}
                disabled={!!importing}
                aria-label={importing ? "Adding book" : "Add book"}
              >
                <Plus />
                <span className="max-sm:sr-only">{importing ? "Adding…" : "Add book"}</span>
              </Button>
              <input
                ref={input}
                type="file"
                hidden
                multiple
                accept=".pdf,.epub,application/pdf,application/epub+zip"
                onChange={(e) => void importFiles(e.target.files)}
              />
            </header>

            {books.length > 0 && (wide || searchOpen) && (
              <div className="mb-4 flex items-center gap-2">
                <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full border bg-card px-3 focus-within:ring-[3px] focus-within:ring-ring/50">
                  <Search className="size-4 shrink-0 text-muted-foreground" />
                  <input
                    type="search"
                    value={query}
                    autoFocus={!wide}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search titles and authors"
                    aria-label="Search books"
                    className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
                  />
                  {query && (
                    <button type="button" className="text-muted-foreground" aria-label="Clear search" onClick={() => setQuery("")}>
                      <X className="size-4" />
                    </button>
                  )}
                </label>
                {wide && (
                  <>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" className="h-9 shrink-0 rounded-full bg-card" aria-label={`Sort: ${sortName}`}>
                          <ArrowUpDown />
                          {sortName}
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="bg-card">
                        <DropdownMenuLabel className="text-xs text-muted-foreground">Sort by</DropdownMenuLabel>
                        <DropdownMenuRadioGroup value={view.sort} onValueChange={(sort) => setView({ sort: sort as Sort })}>
                          {SORTS.map((s) => (
                            <DropdownMenuRadioItem key={s.id} value={s.id}>
                              {s.name}
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <Button
                      variant="outline"
                      className="h-9 shrink-0 rounded-full bg-card"
                      aria-pressed={selecting}
                      onClick={() => setSelected(selecting ? null : new Set())}
                    >
                      <SquareCheck />
                      {selecting ? "Done" : "Select"}
                    </Button>
                  </>
                )}
              </div>
            )}

            {!wide && (
              <Panel open={showMenu} onOpenChange={setShowMenu} title="Library" description="Sections, collections, sorting and settings">
                {nav(pick, fromMenu)}
                {books.length > 0 && (
                  <section className="grid gap-1.5" aria-label="Sort by">
                    <h3 className="px-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Sort by</h3>
                    <div className="flex flex-wrap gap-1.5 px-1">
                      {SORTS.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          aria-pressed={view.sort === s.id}
                          onClick={() => setView({ sort: s.id })}
                          className={cn(
                            "h-8 rounded-full border bg-card px-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring",
                            view.sort === s.id && "border-primary bg-primary text-primary-foreground",
                          )}
                        >
                          {s.name}
                        </button>
                      ))}
                    </div>
                  </section>
                )}
                <div className="-mx-1 grid gap-0.5 border-t pt-3">
                  {books.length > 0 && (
                    <MenuRow icon={<SquareCheck className="size-4" />} onClick={() => fromMenu(() => setSelected(new Set()))}>
                      Select books
                    </MenuRow>
                  )}
                  <MenuRow icon={<Type className="size-4" />} onClick={() => fromMenu(() => setShowDisplay(true))}>
                    Display settings
                  </MenuRow>
                  {status && (
                    <MenuRow
                      icon={<span className={cn("dot", statusLine(status).tone)} />}
                      detail={statusLine(status).text}
                      onClick={() => fromMenu(() => setShowSync(true))}
                    >
                      Sync
                    </MenuRow>
                  )}
                  <MenuRow icon={<Info className="size-4" />} onClick={() => fromMenu(() => setShowAbout(true))}>
                    About Reader
                  </MenuRow>
                </div>
              </Panel>
            )}
            {status && <SyncPanel open={showSync} onOpenChange={setShowSync} status={status} onStatus={onStatus} />}
            <DisplaySheet open={showDisplay} onOpenChange={setShowDisplay} reading={false} />
            <HighlightsSheet
              open={showHighlights}
              onOpenChange={setShowHighlights}
              books={books}
              onOpen={(book, at) => {
                setShowHighlights(false);
                onOpen(book, at);
              }}
            />
            {status && <AboutSheet open={showAbout} onOpenChange={setShowAbout} platform={status.platform} />}
            <CollectionsSheet books={filing} onClose={() => setFiling([])} collections={collections ?? []} onChanged={loadCollections} />
            <NameDialog
              open={!!naming}
              onOpenChange={(open) => !open && setNaming(null)}
              title={naming?.rename ? "Rename collection" : "New collection"}
              description={naming?.rename ? "Books in it stay where they are." : "Then add books from their ⋯ menu, under Collections."}
              initial={naming?.rename?.name ?? ""}
              confirm={naming?.rename ? "Rename" : "Create"}
              onSave={saveName}
            />
            <ConfirmDialog
              open={!!deleting}
              onOpenChange={(open) => !open && setDeleting(undefined)}
              title={`Delete “${deleting?.name ?? ""}”?`}
              description="The collection is deleted on every synced device. Its books stay in your library."
              confirm="Delete"
              onConfirm={() => deleting && void mark(api.deleteCollection(deleting.id).then(loadCollections))}
            />
            <ConfirmDialog
              open={!!removing}
              onOpenChange={(open) => !open && setRemoving(undefined)}
              title={`Remove “${removing?.title ?? ""}”?`}
              description="It's removed from your library on every synced device, along with its bookmarks and highlights."
              confirm="Remove"
              onConfirm={() => removing && void remove(removing)}
            />
            <ConfirmDialog
              open={removingMany.length > 0}
              onOpenChange={(open) => !open && setRemovingMany([])}
              title={`Remove ${removingMany.length} ${removingMany.length === 1 ? "book" : "books"}?`}
              description="They're removed from your library on every synced device, along with their bookmarks and highlights."
              confirm="Remove"
              onConfirm={() => void removeMany(removingMany)}
            />
            {status && <UpdateBanner platform={status.platform} />}
            {error && <p className="mb-3 text-sm text-destructive">{error}</p>}

            {resume && (
              <ContinueCard
                book={resume}
                tags={tagsOf(resume)}
                onOpen={() => onOpen(resume)}
                actions={actionsFor(resume)}
                selection={selecting ? !!selected?.has(resume.id) : undefined}
                onToggle={() => toggleSelected(resume)}
              />
            )}

            {books.length === 0 ? (
              <div className="px-4 py-16 text-center">
                <p className="mb-1 text-xl">No books yet.</p>
                <p className="text-muted-foreground">
                  Add a PDF or EPUB{status?.platform === "desktop" && ", or drop one here"}. With sync on, it will appear on your
                  other device too.
                </p>
              </div>
            ) : shown.length === 0 ? (
              !resume && (
                <p className="px-4 py-12 text-center text-muted-foreground">
                  {query.trim() ? `No books match “${query.trim()}”.` : current.empty}
                </p>
              )
            ) : (
              <>
                {resume && <h2 className="mb-2 text-sm font-semibold text-muted-foreground">{current.id === "all" ? "All books" : current.name}</h2>}
                <ul className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
                  {shown.map((book) => (
                    <BookCard
                      key={book.id}
                      book={book}
                      tags={tagsOf(book)}
                      onOpen={() => (selecting ? toggleSelected(book) : onOpen(book))}
                      actions={actionsFor(book)}
                      selection={selecting ? !!selected?.has(book.id) : undefined}
                      onLongPress={(x, y) => startSweep(book, x, y)}
                    />
                  ))}
                </ul>
              </>
            )}
            {wide && (
              <footer className="mt-8 flex flex-wrap items-center justify-center gap-x-1 gap-y-2">
                {status && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="max-w-full min-w-0 text-muted-foreground"
                    onClick={() => setShowSync(true)}
                    aria-haspopup="dialog"
                    aria-label={`Sync: ${statusLine(status).text}`}
                  >
                    <span className={cn("dot", statusLine(status).tone)} />
                    <span className="truncate">{statusLine(status).text}</span>
                  </Button>
                )}
                {status && (
                  <span className="text-muted-foreground" aria-hidden="true">
                    ·
                  </span>
                )}
                <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setShowAbout(true)}>
                  <Info />
                  About Reader
                </Button>
              </footer>
            )}
          </div>
        </div>
      </div>

      {selecting && (
        <div
          role="toolbar"
          aria-label="Selected books"
          className="fixed inset-x-0 bottom-0 z-30 border-t bg-card/95 px-2 pt-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] shadow-[0_-4px_16px_rgba(0,0,0,0.08)] backdrop-blur"
        >
          <div className="mx-auto flex max-w-3xl items-center gap-1">
            <Button variant="ghost" size="icon" aria-label="Done selecting" onClick={() => setSelected(null)}>
              <X />
            </Button>
            <span className="min-w-0 flex-1 truncate text-sm font-medium" aria-live="polite">
              {picked.length === 0 ? "Select books" : `${picked.length} selected`}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setSelected(allPicked ? new Set() : new Set(selectable.map((b) => b.id)))}>
              {allPicked ? "None" : "All"}
            </Button>
            <Button variant="ghost" size={wide ? "sm" : "icon"} disabled={!picked.length} onClick={() => setFiling(picked)} aria-label="Add to collection">
              <Tag />
              {wide && "Collection"}
            </Button>
            <Button
              variant="ghost"
              size={wide ? "sm" : "icon"}
              disabled={!picked.length}
              onClick={favoriteMany}
              aria-label={favoritePicked ? "Remove from favorites" : "Add to favorites"}
            >
              {favoritePicked ? <StarOff /> : <Star />}
              {wide && (favoritePicked ? "Unfavorite" : "Favorite")}
            </Button>
            <Button
              variant="ghost"
              size={wide ? "sm" : "icon"}
              className="text-destructive hover:text-destructive"
              disabled={!picked.length}
              onClick={() => setRemovingMany(picked)}
              aria-label="Remove from library"
            >
              <Trash2 />
              {wide && "Remove"}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

function MenuRow({
  icon,
  detail,
  onClick,
  children,
}: {
  icon: React.ReactNode;
  detail?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring"
    >
      <span className="grid size-5 place-items-center text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {detail && <span className="max-w-[55%] truncate text-xs text-muted-foreground">{detail}</span>}
    </button>
  );
}

interface NavProps {
  section: Shelf;
  tally: Record<Section, number>;
  collections: Collection[] | undefined;
  highlights: number;
  onPick: (shelf: Shelf) => void;
  onNewCollection: () => void;
  onHighlights: () => void;
}

/** Sections and collections with their counts: the Mac's sidebar and the phone's library sheet. */
function ShelfNav({ section, tally, collections, highlights, onPick, onNewCollection, onHighlights }: NavProps) {
  const row = (active: boolean) =>
    cn(
      "flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring",
      active && "bg-accent font-semibold",
    );
  return (
    <nav className="grid gap-0.5" aria-label="Library sections">
      {SECTIONS.map((s) => (
        <button key={s.id} type="button" aria-current={section === s.id ? "page" : undefined} onClick={() => onPick(s.id)} className={row(section === s.id)}>
          <SectionIcon section={s.id} />
          <span className="flex-1">{s.name}</span>
          <span className="text-xs text-muted-foreground tabular-nums">{tally[s.id]}</span>
        </button>
      ))}
      <div className="mt-4 mb-1 flex items-center justify-between px-3">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Collections</h3>
        <Button variant="ghost" size="icon-sm" className="-mr-2 size-7 text-muted-foreground" aria-label="New collection" onClick={onNewCollection}>
          <Plus />
        </Button>
      </div>
      {collections?.map((c) => {
        const shelf = collectionShelf(c.id);
        return (
          <button key={c.id} type="button" aria-current={section === shelf ? "page" : undefined} onClick={() => onPick(shelf)} className={row(section === shelf)}>
            <Tag className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{c.name}</span>
            <span className="text-xs text-muted-foreground tabular-nums">{c.books.length}</span>
          </button>
        );
      })}
      {collections?.length === 0 && (
        <button type="button" onClick={onNewCollection} className={cn(row(false), "text-muted-foreground")}>
          Group books into collections…
        </button>
      )}
      <div className="my-2 border-t" />
      <button type="button" onClick={onHighlights} aria-haspopup="dialog" className={row(false)}>
        <Highlighter className="size-4 text-muted-foreground" />
        <span className="flex-1">Highlights</span>
        {highlights > 0 && <span className="text-xs text-muted-foreground tabular-nums">{highlights}</span>}
      </button>
    </nav>
  );
}

/** Rename or delete the open collection. */
function CollectionMenu({ collection, onRename, onDelete }: { collection: Collection; onRename: () => void; onDelete: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground" aria-label={`Options for ${collection.name}`}>
          <EllipsisVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="bg-card">
        <DropdownMenuItem onSelect={onRename}>
          <Pencil />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 />
          Delete collection
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The check circle on a cover while selecting. */
function SelectMark({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        "absolute -top-1.5 -left-1.5 grid size-6 place-items-center rounded-full border-2 bg-card shadow-sm",
        on ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
      )}
      aria-hidden="true"
    >
      {on && <Check className="size-3.5" strokeWidth={3} />}
    </span>
  );
}

/** The cover, with a star on favorites. */
function BadgedCover({ book, large }: { book: Book; large?: boolean }) {
  return (
    <span className="relative block shrink-0 self-start">
      <Cover book={book} large={large} />
      {book.favorite && (
        <span className="absolute -top-1.5 -right-1.5 grid size-6 place-items-center rounded-full bg-card shadow-sm">
          <Star className="size-3.5 fill-amber-400 text-amber-500" aria-label="Favorite" />
        </span>
      )}
    </span>
  );
}

function SectionIcon({ section }: { section: Section }) {
  const Icon = { all: Library_, reading: BookOpen, favorites: Star, finished: CircleCheck, unread: BookDashed }[section];
  return <Icon className="size-4 text-muted-foreground" />;
}

/** The last book read and not finished, to pick up where you left off. */
interface ContinueProps {
  book: Book;
  tags: string[];
  onOpen: () => void;
  actions: BookActions;
  /** While selecting books: whether this one is selected. */
  selection?: boolean;
  onToggle: () => void;
}

function ContinueCard({ book, tags, onOpen, actions, selection, onToggle }: ContinueProps) {
  const percent = Math.round((book.progress?.fraction ?? 0) * 100);
  const selecting = selection !== undefined;
  return (
    <section aria-label="Continue reading" className="mb-6">
      <h2 className="mb-2 text-sm font-semibold text-muted-foreground">Continue reading</h2>
      <div
        className={cn(
          "relative flex gap-4 rounded-2xl border bg-card p-4 pr-10",
          selecting && "cursor-pointer select-none",
          selection && "border-primary ring-2 ring-primary",
        )}
        role={selecting ? "button" : undefined}
        aria-pressed={selecting ? selection : undefined}
        tabIndex={selecting ? 0 : undefined}
        onClick={selecting ? onToggle : undefined}
        onKeyDown={selecting ? (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onToggle()) : undefined}
      >
        {!selecting && <BookMenu book={book} actions={actions} />}
        <span className="relative block shrink-0 self-start">
          <BadgedCover book={book} large />
          {selecting && <SelectMark on={!!selection} />}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <strong className="line-clamp-2 font-serif text-xl leading-snug">{book.title}</strong>
          {book.author && <span className="truncate text-sm">{book.author}</span>}
          {book.progress && (
            <span className="truncate text-sm text-muted-foreground">
              {book.progress.label} · {ago(book.progress.updatedAt)}
            </span>
          )}
          {tags.length > 0 && (
            <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              <Tag className="size-3 shrink-0" />
              <span className="truncate">{tags.join(" · ")}</span>
            </span>
          )}
          <div className="mt-auto flex items-center gap-3 pt-2">
            <div className="meter flex-1">
              <div style={{ width: `${percent}%` }} />
            </div>
            <span className="text-xs text-muted-foreground tabular-nums">{percent}%</span>
          </div>
          <Button className={cn("mt-2 self-start rounded-full", selecting && "invisible")} onClick={onOpen} tabIndex={selecting ? -1 : undefined}>
            <BookOpen />
            Resume
          </Button>
        </div>
      </div>
    </section>
  );
}

interface BookActions {
  onCollections: () => void;
  onFavorite: (on: boolean) => void;
  onFinished: (on: boolean) => void;
  onRemove: () => void;
}

/** A book's ⋯ menu: favorite, collections, finished, remove. */
function BookMenu({ book, actions }: { book: Book; actions: BookActions }) {
  const { onCollections, onFavorite, onFinished, onRemove } = actions;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="absolute top-1.5 right-1.5 text-muted-foreground"
          aria-label={`More for ${book.title}`}
        >
          <EllipsisVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="bg-card">
        <DropdownMenuItem onSelect={() => onFavorite(!book.favorite)}>
          {book.favorite ? <StarOff /> : <Star />}
          {book.favorite ? "Remove from favorites" : "Add to favorites"}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onCollections}>
          <Tag />
          Collections…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onFinished(!book.finishedAt)}>
          {book.finishedAt ? <RotateCcw /> : <CircleCheck />}
          {book.finishedAt ? "Mark as not finished" : "Mark as finished"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onRemove}>
          <Trash2 />
          Remove from library
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface CardProps {
  book: Book;
  /** Names of the collections it's in. */
  tags: string[];
  onOpen: () => void;
  actions: BookActions;
  /** While selecting books: whether this one is selected. */
  selection?: boolean;
  /** A long press on a touch screen starts selecting from this book, at the finger. */
  onLongPress: (x: number, y: number) => void;
}

const LONG_PRESS = 450;

function BookCard({ book, tags, onOpen, actions, selection, onLongPress }: CardProps) {
  const fraction = book.finishedAt ? 1 : (book.progress?.fraction ?? 0);
  const selecting = selection !== undefined;
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout>; fired: boolean } | null>(null);
  const cancel = () => {
    if (press.current) clearTimeout(press.current.timer);
  };
  return (
    <li className={cn("relative", !book.available && !selecting && "opacity-70")} data-book-id={book.id}>
      <button
        className={cn(
          "flex w-full gap-3.5 rounded-xl border bg-card p-3 text-left transition-colors outline-none select-none [-webkit-touch-callout:none] hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-card",
          selection && "border-primary ring-2 ring-primary",
        )}
        aria-pressed={selecting ? selection : undefined}
        onPointerDown={(e) => {
          if (e.pointerType !== "touch") return;
          const state = {
            x: e.clientX,
            y: e.clientY,
            fired: false,
            timer: setTimeout(() => {
              state.fired = true;
              navigator.vibrate?.(12);
              onLongPress(state.x, state.y);
            }, LONG_PRESS),
          };
          press.current = state;
        }}
        onPointerMove={(e) => {
          const p = press.current;
          if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) cancel();
        }}
        onPointerUp={cancel}
        onPointerCancel={cancel}
        onContextMenu={(e) => press.current && e.preventDefault()}
        onClick={() => {
          // The long press already acted; the click that follows it doesn't.
          if (press.current?.fired) {
            press.current = null;
            return;
          }
          if (selecting || book.available) onOpen();
        }}
        disabled={!book.available && !selecting}
      >
        <span className="relative block shrink-0 self-start">
          <BadgedCover book={book} />
          {selecting && <SelectMark on={!!selection} />}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1 pr-7">
          <strong className="line-clamp-2">{book.title}</strong>
          {book.author && <span className="truncate text-sm">{book.author}</span>}
          <span className="flex items-center gap-1 truncate text-sm text-muted-foreground">
            {!book.available ? (
              "Downloading from your other device…"
            ) : book.finishedAt ? (
              <>
                <CircleCheck className="size-3.5 shrink-0 text-ok" /> Finished {day(book.finishedAt)}
              </>
            ) : (
              (book.progress?.label ?? `Not started · ${size(book.size)}`)
            )}
          </span>
          {tags.length > 0 && (
            <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground" aria-label={`Collections: ${tags.join(", ")}`}>
              <Tag className="size-3 shrink-0" />
              <span className="truncate">{tags.join(" · ")}</span>
            </span>
          )}
          <div className="meter mt-auto">
            <div style={{ width: `${Math.round(fraction * 100)}%` }} />
          </div>
        </div>
      </button>
      {!selecting && <BookMenu book={book} actions={actions} />}
    </li>
  );
}
