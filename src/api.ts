import { invoke } from "@tauri-apps/api/core";
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
}

export interface Bookmark {
  id: string;
  bookId: string;
  location: string;
  label: string;
  createdAt: number;
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
  library: { books: number; localBooks: number; bookmarks: number };
  google: {
    configured: boolean;
    connected: boolean;
    connecting: boolean;
    error: string | null;
  };
}

export interface Changed {
  kind: "book" | "progress" | "bookmark";
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
  bookmarks: (bookId: string) => invoke<Bookmark[]>("list_bookmarks", { bookId }),
  addBookmark: (bookId: string, p: Position) =>
    invoke<Bookmark>("add_bookmark", { bookId, location: p.location, label: p.label }),
  removeBookmark: (id: string) => invoke<void>("remove_bookmark", { id }),
  status: () => invoke<Status>("sync_status"),
  enableSync: () => invoke<Status>("sync_enable"),
  pauseSync: () => invoke<Status>("sync_pause"),
  syncNow: () => invoke<Status>("sync_now"),
  disconnect: () => invoke<Status>("google_disconnect"),
  foreground: (visible: boolean) => invoke<void>("app_foreground", { visible }),
  /** Android: a newer release APK on GitHub, if any (desktop uses the Tauri updater). */
  checkApkUpdate: () => invoke<{ version: string; url: string; notes: string } | null>("check_apk_update"),
  openApk: (url: string) => invoke<void>("open_apk", { url }),
  /** Opens a github.com page in the browser; anything else is refused. */
  openLink: (url: string) => invoke<void>("open_link", { url }),
  /** Android: hide the system bars while reading. A no-op on desktop. */
  setImmersive: (on: boolean) => invoke<void>("set_immersive", { on }),
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
