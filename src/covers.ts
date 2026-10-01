import ePub from "epubjs";
import { api, type Book } from "./api";
import { pdfjs } from "./pdf";

/** Rendered once per device and stored locally; wide enough for sharp 2x thumbnails. */
const WIDTH = 320;

const urls = new Map<string, string>();
let queue: Promise<unknown> = Promise.resolve();

function toJpeg(canvas: HTMLCanvasElement, quality = 0.85): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject) : reject(new Error("No cover"))),
      "image/jpeg",
      quality,
    ),
  );
}

/** A chosen cover syncs inside a record, so it's kept small. */
const CHOSEN_WIDTH = 480;
const CHOSEN_HEIGHT = 720;
const CHOSEN_BYTES = 200 * 1024;

/** A picked image made into a cover: scaled to fit 480×720 and saved as a compact JPEG. */
export async function coverFromImage(file: Blob): Promise<Uint8Array> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode().catch(() => {
      throw new Error("That file isn't an image Reader can use");
    });
    const scale = Math.min(1, CHOSEN_WIDTH / image.naturalWidth, CHOSEN_HEIGHT / image.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d")!;
    // JPEG has no transparency: see-through parts would turn black, so they go on white.
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.85, 0.7, 0.55]) {
      const jpeg = await toJpeg(canvas, quality);
      if (jpeg.length <= CHOSEN_BYTES) return jpeg;
    }
    throw new Error("That image is too detailed to use as a cover");
  } finally {
    URL.revokeObjectURL(url);
  }
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

type Covered = Pick<Book, "id" | "customCover">;

/** A chosen cover gets a key of its own, so choosing another shows it right away. */
const keyOf = (book: Covered) => `${book.id}:${book.customCover ?? ""}`;

function remember(key: string, image: Uint8Array): string {
  const url = URL.createObjectURL(new Blob([image as BlobPart], { type: "image/jpeg" }));
  urls.set(key, url);
  return url;
}

export function cachedCover(book: Covered): string | undefined {
  return urls.get(keyOf(book));
}

export async function loadCover(book: Covered): Promise<string | undefined> {
  const key = keyOf(book);
  if (urls.has(key)) return urls.get(key);
  try {
    return remember(key, new Uint8Array(await api.readCover(book.id)));
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
  const key = keyOf({ id: book.id, customCover: null });
  const job = queue.then(async () => {
    if (urls.has(key)) return urls.get(key);
    let image: Uint8Array | null = null;
    try {
      const source = bytes ?? new Uint8Array(await api.readBook(book.id));
      image = await (book.format === "pdf" ? renderPdf(source) : renderEpub(source));
    } catch {
      image = null;
    }
    await api.saveCover(book.id, image ?? new Uint8Array()).catch(() => {});
    return image ? remember(key, image) : undefined;
  });
  queue = job.catch(() => {});
  return job;
}

