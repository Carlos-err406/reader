import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpDown,
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
  const [filing, setFiling] = useState<Book>();
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
    onCollections: () => setFiling(book),
    onFavorite: (on) => void mark(api.setFavorite(book.id, on)),
    onFinished: (on) => void mark(api.setFinished(book.id, on)),
    onRemove: () => setRemoving(book),
  });
  const tagsOf = (book: Book) => (collections ?? []).filter((c) => c.books.includes(book.id)).map((c) => c.name);
  const saveName = async (name: string) => {
    if (naming?.rename) await api.renameCollection(naming.rename.id, name);
    else setView({ section: collectionShelf((await api.createCollection(name)).id) });
    loadCollections();
  };

  const pullSync = useCallback(() => {
    setRefreshing(true);
    api.syncNow().then(onStatus, (e) => setError(message(e)));
  }, [onStatus]);
  const pull = usePullToSync(pullSync, !!status?.enabled && !showSync && !showDisplay);
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
        )}
        style={offset ? { transform: `translateY(${offset}px)` } : undefined}
      >
        <div className="md:flex md:gap-8">
          {wide && (
            <aside className="sticky top-4 w-52 shrink-0 self-start pt-2" aria-label="Library sections">
              <h1 className="mb-4 px-3 font-serif text-3xl font-semibold">Library</h1>
              <nav className="grid gap-0.5">
                {SECTIONS.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    aria-current={section === s.id ? "page" : undefined}
                    onClick={() => setView({ section: s.id })}
                    className={cn(
                      "flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring",
                      section === s.id && "bg-accent font-semibold",
                    )}
                  >
                    <SectionIcon section={s.id} />
                    <span className="flex-1">{s.name}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">{tally[s.id]}</span>
                  </button>
                ))}
                <div className="mt-4 mb-1 flex items-center justify-between px-3">
                  <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Collections</h3>
                  <Button variant="ghost" size="icon-sm" className="-mr-2 size-7 text-muted-foreground" aria-label="New collection" onClick={() => setNaming({})}>
                    <Plus />
                  </Button>
                </div>
                {collections?.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    aria-current={section === collectionShelf(c.id) ? "page" : undefined}
                    onClick={() => setView({ section: collectionShelf(c.id) })}
                    className={cn(
                      "flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring",
                      section === collectionShelf(c.id) && "bg-accent font-semibold",
                    )}
                  >
                    <Tag className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{c.name}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">{c.books.length}</span>
                  </button>
                ))}
                {collections?.length === 0 && (
                  <button
                    type="button"
                    onClick={() => setNaming({})}
                    className="rounded-lg px-3 py-2 text-left text-sm text-muted-foreground outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring"
                  >
                    Group books into collections…
                  </button>
                )}
                <div className="my-2 border-t" />
                <button
                  type="button"
                  onClick={() => setShowHighlights(true)}
                  aria-haspopup="dialog"
                  className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring"
                >
                  <Highlighter className="size-4 text-muted-foreground" />
                  <span className="flex-1">Highlights</span>
                  {!!status?.library.highlights && (
                    <span className="text-xs text-muted-foreground tabular-nums">{status.library.highlights}</span>
                  )}
                </button>
              </nav>
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
                <h1 className="flex-1 shrink-0 font-serif text-[1.55rem] font-semibold sm:text-3xl">Library</h1>
              )}
              <Button
                variant="outline"
                size="icon"
                className="rounded-full bg-card"
                onClick={() => setShowDisplay(true)}
                aria-label="Display settings"
              >
                <Type />
              </Button>
              {!wide && (
                <Button
                  variant="outline"
                  size="icon"
                  className="rounded-full bg-card"
                  onClick={() => setShowHighlights(true)}
                  aria-haspopup="dialog"
                  aria-label="Highlights"
                >
                  <Highlighter />
                </Button>
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

            {!wide && books.length > 0 && (
              <div className="-mx-4 mb-3 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]" role="group" aria-label="Library sections">
                {SECTIONS.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    aria-pressed={section === s.id}
                    onClick={() => setView({ section: s.id })}
                    className={cn(
                      "flex h-8 shrink-0 items-center gap-1.5 rounded-full border bg-card px-3 text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring",
                      section === s.id && "border-primary bg-primary text-primary-foreground",
                    )}
                  >
                    {s.id === "favorites" && <Star className="size-3.5" />}
                    {s.id === "all" ? "All" : s.name}
                    <span className={cn("tabular-nums opacity-70")}>{tally[s.id]}</span>
                  </button>
                ))}
                {collections?.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={section === collectionShelf(c.id)}
                    onClick={() => setView({ section: collectionShelf(c.id) })}
                    className={cn(
                      "flex h-8 shrink-0 items-center gap-1.5 rounded-full border bg-card px-3 text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring",
                      section === collectionShelf(c.id) && "border-primary bg-primary text-primary-foreground",
                    )}
                  >
                    <Tag className="size-3.5" />
                    {c.name}
                    <span className="tabular-nums opacity-70">{c.books.length}</span>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setNaming({})}
                  className="flex h-8 shrink-0 items-center gap-1 rounded-full border border-dashed px-3 text-sm whitespace-nowrap text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
                >
                  <Plus className="size-3.5" />
                  Collection
                </button>
              </div>
            )}
            {!wide && opened && (
              <div className="mb-3 flex items-center gap-1">
                <Tag className="size-4 text-muted-foreground" />
                <strong className="min-w-0 truncate font-serif text-lg">{opened.name}</strong>
                <CollectionMenu collection={opened} onRename={() => setNaming({ rename: opened })} onDelete={() => setDeleting(opened)} />
              </div>
            )}

            {books.length > 0 && (
              <div className="mb-4 flex items-center gap-2">
                <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full border bg-card px-3 focus-within:ring-[3px] focus-within:ring-ring/50">
                  <Search className="size-4 shrink-0 text-muted-foreground" />
                  <input
                    type="search"
                    value={query}
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
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" className="h-9 shrink-0 rounded-full bg-card max-sm:w-9 max-sm:px-0" aria-label={`Sort: ${sortName}`}>
                      <ArrowUpDown />
                      <span className="max-sm:sr-only">{sortName}</span>
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
              </div>
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
            <CollectionsSheet
              book={filing}
              onClose={() => setFiling(undefined)}
              collections={collections ?? []}
              onChanged={loadCollections}
            />
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
            {status && <UpdateBanner platform={status.platform} />}
            {error && <p className="mb-3 text-sm text-destructive">{error}</p>}

            {resume && <ContinueCard book={resume} tags={tagsOf(resume)} onOpen={() => onOpen(resume)} actions={actionsFor(resume)} />}

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
                    <BookCard key={book.id} book={book} tags={tagsOf(book)} onOpen={() => onOpen(book)} actions={actionsFor(book)} />
                  ))}
                </ul>
              </>
            )}
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
          </div>
        </div>
      </div>
    </>
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

/** The cover, with a star on favorites. */
function BadgedCover({ book, large }: { book: Book; large?: boolean }) {
  return (
    <span className="relative shrink-0 self-start">
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
function ContinueCard({ book, tags, onOpen, actions }: { book: Book; tags: string[]; onOpen: () => void; actions: BookActions }) {
  const percent = Math.round((book.progress?.fraction ?? 0) * 100);
  return (
    <section aria-label="Continue reading" className="mb-6">
      <h2 className="mb-2 text-sm font-semibold text-muted-foreground">Continue reading</h2>
      <div className="relative flex gap-4 rounded-2xl border bg-card p-4 pr-10">
        <BookMenu book={book} actions={actions} />
        <BadgedCover book={book} large />
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
          <Button className="mt-2 self-start rounded-full" onClick={onOpen}>
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
}

function BookCard({ book, tags, onOpen, actions }: CardProps) {
  const fraction = book.finishedAt ? 1 : (book.progress?.fraction ?? 0);
  return (
    <li className={cn("relative", !book.available && "opacity-70")}>
      <button
        className="flex w-full gap-3.5 rounded-xl border bg-card p-3 text-left transition-colors outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-card"
        onClick={() => book.available && onOpen()}
        disabled={!book.available}
      >
        <BadgedCover book={book} />
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
      <BookMenu book={book} actions={actions} />
    </li>
  );
}
