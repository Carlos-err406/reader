import ePub from "epubjs";
import { api, type Book } from "./api";
import { pdfjs } from "./pdf";

/** Rendered once per device and stored locally; wide enough for sharp 2x thumbnails. */
const WIDTH = 320;

const urls = new Map<string, string>();
let queue: Promise<unknown> = Promise.resolve();

function toJpeg(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject) : reject(new Error("No cover"))),
      "image/jpeg",
      0.85,
    ),
  );
}

async function renderPdf(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  try {
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: WIDTH / page.getViewport({ scale: 1 }).width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvas, viewport }).promise;
    return await toJpeg(canvas);
  } finally {
    void doc.destroy();
  }
}

/** The EPUB's declared cover image, or null when it has none. */
async function renderEpub(bytes: Uint8Array): Promise<Uint8Array | null> {
  const book = ePub(bytes.slice().buffer as ArrayBuffer);
  try {
    await book.ready;
    const url = await book.coverUrl();
    if (!url) return null;
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = Math.round((image.naturalHeight / image.naturalWidth) * WIDTH);
    canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await toJpeg(canvas);
  } finally {
    book.destroy();
  }
}

function remember(id: string, image: Uint8Array): string {
  const url = URL.createObjectURL(new Blob([image as BlobPart], { type: "image/jpeg" }));
  urls.set(id, url);
  return url;
}

export function cachedCover(id: string): string | undefined {
  return urls.get(id);
}

export async function loadCover(id: string): Promise<string | undefined> {
  if (urls.has(id)) return urls.get(id);
  try {
    return remember(id, new Uint8Array(await api.readCover(id)));
  } catch {
    return undefined;
  }
}

/**
 * Renders and stores a book's cover, one book at a time so a big library doesn't parse
 * dozens of files at once. Pass the bytes when they're at hand (just imported).
 * A book without a usable cover is recorded as such, so it isn't retried.
 */
export function makeCover(book: Pick<Book, "id" | "format">, bytes?: Uint8Array): Promise<string | undefined> {
  const job = queue.then(async () => {
    if (urls.has(book.id)) return urls.get(book.id);
    let image: Uint8Array | null = null;
    try {
      const source = bytes ?? new Uint8Array(await api.readBook(book.id));
      image = await (book.format === "pdf" ? renderPdf(source) : renderEpub(source));
    } catch {
      image = null;
    }
    await api.saveCover(book.id, image ?? new Uint8Array()).catch(() => {});
    return image ? remember(book.id, image) : undefined;
  });
  queue = job.catch(() => {});
  return job;
}

