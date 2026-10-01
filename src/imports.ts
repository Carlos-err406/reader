import { Channel } from "@tauri-apps/api/core";
import { api, type Book } from "./api";
import { makeCover } from "./covers";
import { readMetadata } from "./metadata";

/**
 * Adds one book file to the library, with its title and author from the file, and draws its
 * cover in the background (`onCover` runs when that's done). The same file again is the same
 * book; it keeps any details edited since.
 */
export async function importBook(file: File, onCover: () => void): Promise<Book> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const book = await api.importBook(bytes, await readMetadata(file, bytes));
  if (book.cover === null) void makeCover(book, bytes).then(onCover);
  return book;
}

/**
 * Books opened with Reader from elsewhere: a file manager, "Share" on Android, "Open With" or a
 * double-click on the desktop. Each is imported and `onBooks` gets those that worked; files that
 * aren't books go to `onError`. Covers the ones waiting from launch and any that come later.
 */
export function watchOpenedBooks(onBooks: (books: Book[]) => void, onError: (message: string) => void, onCover: () => void) {
  let busy = Promise.resolve();
  const take = () => {
    busy = busy.then(async () => {
      const books: Book[] = [];
      for (const opened of await api.takeOpenedFiles().catch(() => [])) {
        try {
          // The bytes come over once, for the details; Rust imports from its own copy.
          const bytes = new Uint8Array(await api.readOpenedFile(opened.id));
          const book = await api.importOpenedFile(opened.id, await readMetadata(new File([bytes], opened.name), bytes));
          if (book.cover === null) void makeCover(book, bytes).then(onCover);
          books.push(book);
        } catch (e) {
          onError(`${opened.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (books.length) onBooks(books);
    });
  };
  void api.watchOpenedFiles(new Channel<null>(take)).catch(() => {});
  take();
}
