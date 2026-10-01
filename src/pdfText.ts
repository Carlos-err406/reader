/**
 * Selecting text over PDF pages. PDF.js lays transparent text over each page image; this is a
 * port of the part of its viewer (TextLayerBuilder) that keeps drag-selection from jumping
 * when the pointer crosses gaps between text runs.
 */
const layers = new Map<HTMLElement, HTMLElement>();
let controller: AbortController | null = null;
let previous: Range | null = null;

const reset = (end: HTMLElement, layer: HTMLElement) => {
  layer.append(end);
  end.style.width = "";
  end.style.height = "";
  layer.classList.remove("selecting");
};

function listen() {
  if (controller) return;
  controller = new AbortController();
  const { signal } = controller;
  let pointerDown = false;
  document.addEventListener("pointerdown", () => (pointerDown = true), { signal });
  document.addEventListener(
    "pointerup",
    () => {
      pointerDown = false;
      layers.forEach(reset);
    },
    { signal },
  );
  window.addEventListener(
    "blur",
    () => {
      pointerDown = false;
      layers.forEach(reset);
    },
    { signal },
  );
  document.addEventListener("keyup", () => !pointerDown && layers.forEach(reset), { signal });
  document.addEventListener(
    "selectionchange",
    () => {
      const selection = document.getSelection();
      if (!selection || selection.rangeCount === 0) {
        layers.forEach(reset);
        return;
      }
      const active = new Set<HTMLElement>();
      for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        for (const layer of layers.keys()) if (range.intersectsNode(layer)) active.add(layer);
      }
      for (const [layer, end] of layers) {
        if (active.has(layer)) layer.classList.add("selecting");
        else reset(end, layer);
      }
      // Keep the invisible end-of-content block right after the selection's moving end, so the
      // browser extends the selection to the nearest text instead of the whole page.
      const range = selection.getRangeAt(0);
      const modifyStart =
        previous &&
        (range.compareBoundaryPoints(Range.END_TO_END, previous) === 0 ||
          range.compareBoundaryPoints(Range.START_TO_END, previous) === 0);
      let anchor: Node | null = modifyStart ? range.startContainer : range.endContainer;
      if (anchor?.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
      if (!modifyStart && range.endOffset === 0 && anchor) {
        do {
          while (anchor && !anchor.previousSibling) anchor = anchor.parentNode;
          anchor = anchor?.previousSibling ?? null;
        } while (anchor && !anchor.childNodes.length);
      }
      const element = anchor as HTMLElement | null;
      const layer = element?.parentElement?.closest<HTMLElement>(".textLayer");
      const end = layer ? layers.get(layer) : undefined;
      if (layer && end && element?.parentElement) {
        end.style.width = layer.style.width;
        end.style.height = layer.style.height;
        element.parentElement.insertBefore(end, modifyStart ? element : element.nextSibling);
      }
      previous = range.cloneRange();
    },
    { signal },
  );
}

/** Call once a page's text layer has rendered; returns the cleanup. */
export function attachTextLayer(layer: HTMLElement): () => void {
  const end = document.createElement("div");
  end.className = "endOfContent";
  layer.append(end);
  const down = () => layer.classList.add("selecting");
  layer.addEventListener("mousedown", down);
  layers.set(layer, end);
  listen();
  return () => {
    layer.removeEventListener("mousedown", down);
    layers.delete(layer);
    if (layers.size === 0) {
      controller?.abort();
      controller = null;
      previous = null;
    }
  };
}
