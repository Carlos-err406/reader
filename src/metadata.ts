import ePub from "epubjs";
import { titleFromFileName } from "./format";
import { pdfjs } from "./pdf";

export interface BookMeta {
  title: string;
  author: string | null;
}

const clean = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text : null;
};

/** Best effort: a book with unreadable metadata still imports under its file name. */
export async function readMetadata(file: File, bytes: Uint8Array): Promise<BookMeta> {
  const fallback = { title: titleFromFileName(file.name), author: null };
  try {
    if (/\.epub$/i.test(file.name) || file.type === "application/epub+zip") {
      const book = ePub(bytes.slice().buffer as ArrayBuffer);
      // Let epub.js finish opening before tearing it down.
      await book.ready;
      const meta = await book.loaded.metadata;
      book.destroy();
      return { title: clean(meta.title) ?? fallback.title, author: clean(meta.creator) };
    }
    const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
    const info = (await doc.getMetadata()).info as Record<string, unknown>;
    await doc.destroy();
    return { title: clean(info?.Title) ?? fallback.title, author: clean(info?.Author) };
  } catch {
    return fallback;
  }
}
