import { useCallback, useEffect, useRef, useState } from "react";
import { EllipsisVertical, FileDown, Highlighter, Info, Plus, Trash2, Type } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { api, message, type Book, type Status } from "./api";
import { size, statusLine } from "./format";
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
function Cover({ book }: { book: Book }) {
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

  const frame = "h-[108px] w-[72px] shrink-0 overflow-hidden rounded-[3px_6px_6px_3px] shadow-[0_1px_4px_rgba(0,0,0,0.25)]";
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
          "library mx-auto max-w-5xl px-4 pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-[calc(env(safe-area-inset-bottom)+2rem)]",
          !pull && "settling",
        )}
        style={offset ? { transform: `translateY(${offset}px)` } : undefined}
      >
        <header className="flex items-center gap-2 pt-2 pb-4">
          <h1 className="flex-1 shrink-0 font-serif text-[1.55rem] font-semibold sm:text-3xl">Library</h1>
          <Button
            variant="outline"
            size="icon"
            className="rounded-full bg-card"
            onClick={() => setShowDisplay(true)}
            aria-label="Display settings"
          >
            <Type />
          </Button>
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

        {books.length === 0 ? (
          <div className="px-4 py-16 text-center">
            <p className="mb-1 text-xl">No books yet.</p>
            <p className="text-muted-foreground">
              Add a PDF or EPUB{status?.platform === "desktop" && ", or drop one here"}. With sync on, it will appear on your
              other device too.
            </p>
          </div>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
            {books.map((book) => (
              <li key={book.id} className={cn("relative", !book.available && "opacity-70")}>
                <button
                  className="flex w-full gap-3.5 rounded-xl border bg-card p-3 text-left transition-colors outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-card"
                  onClick={() => book.available && onOpen(book)}
                  disabled={!book.available}
                >
                  <Cover book={book} />
                  <div className="flex min-w-0 flex-1 flex-col gap-1 pr-7">
                    <strong className="line-clamp-2">{book.title}</strong>
                    {book.author && <span className="truncate text-sm">{book.author}</span>}
                    <span className="truncate text-sm text-muted-foreground">
                      {!book.available
                        ? "Downloading from your other device…"
                        : (book.progress?.label ?? `Not started · ${size(book.size)}`)}
                    </span>
                    <div className="meter mt-auto">
                      <div style={{ width: `${Math.round((book.progress?.fraction ?? 0) * 100)}%` }} />
                    </div>
                  </div>
                </button>
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
                    <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(book)}>
                      <Trash2 />
                      Remove from library
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
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
    </>
  );
}
