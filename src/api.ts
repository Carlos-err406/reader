import { invoke, type Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Format = "pdf" | "epub";

export interface Progress {
  /** A page number for PDFs, an EPUB CFI for EPUBs. */
  location: string;
  label: string;
  fraction: number;
  updatedAt: number;
}

export interface Book {
  id: string;
  title: string;
  author: string | null;
  format: Format;
  size: number;
  addedAt: number;
  available: boolean;
  progress: Progress | null;
  /** null until this device has rendered a cover; then whether the book has one. */
  cover: boolean | null;
  favorite: boolean;
  /** When it was read to the end or marked as finished (epoch ms). */
  finishedAt: number | null;
}

export interface Bookmark {
  id: string;
  bookId: string;
  location: string;
  label: string;
  createdAt: number;
}

export type HighlightColor = "yellow" | "green" | "blue" | "pink" | "purple";

export interface Highlight {
  id: string;
  bookId: string;
  /** An EPUB CFI range, or for PDFs the page, a colon and the marked rectangles (see highlights.ts). */
  location: string;
  text: string;
  color: HighlightColor;
  /** Chapter and percentage, or page, for lists. */
  label: string;
  fraction: number;
  createdAt: number;
}

export type NewHighlight = Pick<Highlight, "location" | "text" | "color" | "label" | "fraction">;

export interface Collection {
  id: string;
  name: string;
  createdAt: number;
  /** Ids of the books in it. */
  books: string[];
}

export interface Status {
  enabled: boolean;
  syncing: boolean;
  pending: boolean;
  lastSync: number | null;
  error: string | null;
  /** The error is a lost connection; changes wait locally. */
  offline: boolean;
  /** What the running sync is doing, e.g. "Uploading “Dune”". */
  activity: string | null;
  /** When the next automatic attempt runs after a failure (epoch ms). */
  retryAt: number | null;
  /** The Google account email, when known. */
  account: string | null;
  platform: "desktop" | "android";
  library: { books: number; localBooks: number; bookmarks: number; highlights: number };
  google: {
    configured: boolean;
    connected: boolean;
    connecting: boolean;
    error: string | null;
  };
}

export interface Changed {
  kind: "book" | "progress" | "bookmark" | "highlight" | "favorite" | "finished" | "collection" | "member";
  id: string;
}

export interface Position {
  location: string;
  label: string;
  fraction: number;
}

export const api = {
  books: () => invoke<Book[]>("list_books"),
  importBook: (bytes: Uint8Array, meta: { title: string; author: string | null }) =>
    invoke<Book>("import_book", bytes, {
      headers: { "x-book-meta": encodeURIComponent(JSON.stringify(meta)) },
    }),
  readBook: (id: string) => invoke<ArrayBuffer>("read_book", { id }),
  removeBook: (id: string) => invoke<void>("remove_book", { id }),
  /** An empty image records that the book has no cover. */
  saveCover: (id: string, image: Uint8Array) => invoke<void>("save_cover", image, { headers: { "x-book-id": id } }),
  readCover: (id: string) => invoke<ArrayBuffer>("read_cover", { id }),
  progress: (bookId: string) => invoke<Progress | null>("get_progress", { bookId }),
  setProgress: (bookId: string, p: Position) => invoke<void>("set_progress", { bookId, ...p }),
  setFavorite: (bookId: string, on: boolean) => invoke<void>("set_favorite", { bookId, on }),
  setFinished: (bookId: string, on: boolean) => invoke<void>("set_finished", { bookId, on }),
  collections: () => invoke<Collection[]>("list_collections"),
  createCollection: (name: string) => invoke<Collection>("create_collection", { name }),
  renameCollection: (id: string, name: string) => invoke<void>("rename_collection", { id, name }),
  deleteCollection: (id: string) => invoke<void>("delete_collection", { id }),
  setInCollection: (collectionId: string, bookId: string, on: boolean) =>
    invoke<void>("set_in_collection", { collectionId, bookId, on }),
  bookmarks: (bookId: string) => invoke<Bookmark[]>("list_bookmarks", { bookId }),
  addBookmark: (bookId: string, p: Position) =>
    invoke<Bookmark>("add_bookmark", { bookId, location: p.location, label: p.label }),
  removeBookmark: (id: string) => invoke<void>("remove_bookmark", { id }),
  /** One book's highlights in reading order, or every book's without `bookId`. */
  highlights: (bookId?: string) => invoke<Highlight[]>("list_highlights", { bookId: bookId ?? null }),
  addHighlight: (bookId: string, highlight: NewHighlight) => invoke<Highlight>("add_highlight", { bookId, highlight }),
  recolorHighlight: (id: string, color: HighlightColor) => invoke<Highlight>("recolor_highlight", { id, color }),
  removeHighlight: (id: string) => invoke<void>("remove_highlight", { id }),
  status: () => invoke<Status>("sync_status"),
  enableSync: () => invoke<Status>("sync_enable"),
  pauseSync: () => invoke<Status>("sync_pause"),
  syncNow: () => invoke<Status>("sync_now"),
  disconnect: () => invoke<Status>("google_disconnect"),
  foreground: (visible: boolean) => invoke<void>("app_foreground", { visible }),
  /** Android: a newer release APK on GitHub, if any (desktop uses the Tauri updater). */
  checkApkUpdate: () => invoke<{ version: string; url: string; notes: string } | null>("check_apk_update"),
  /** Android: download, verify and install the newest release; "permission" if Reader must be allowed to install first. */
  installUpdate: (onProgress: Channel<{ fraction: number }>) =>
    invoke<"installing" | "permission">("install_update", { onProgress }),
  /** Opens a github.com page in the browser; anything else is refused. */
  openLink: (url: string) => invoke<void>("open_link", { url }),
  /** Android: hide the system bars while reading. A no-op on desktop. */
  setImmersive: (on: boolean) => invoke<void>("set_immersive", { on }),
  /** Android: keep the screen from sleeping. A no-op on desktop. */
  keepAwake: (on: boolean) => invoke<void>("keep_awake", { on }),
  /** Android: while on, the volume buttons send page turns to `keys` instead of changing the volume. */
  volumeKeys: (on: boolean, keys: Channel<{ turn: "next" | "previous" }>) => invoke<void>("volume_keys", { on, keys }),
};

export const onChanged = (handler: (changed: Changed[]) => void): Promise<UnlistenFn> =>
  listen<Changed[]>("records-changed", (e) => handler(e.payload));

export const onStatus = (handler: () => void): Promise<UnlistenFn> =>
  listen("sync-status", () => handler());

export function message(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Something went wrong";
}
