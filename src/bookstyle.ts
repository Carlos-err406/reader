const XHTML = "http://www.w3.org/1999/xhtml";

/** Book text smaller than this share of the body text is raised to it. */
export const SMALLEST_TEXT = 0.9;

/** Elements whose smaller text is meant to be small: note marks, ruby annotations. */
const SMALL_ON_PURPOSE = new Set(["sup", "sub", "rt", "rp"]);

/** Parses a computed colour ("rgb(…)" / "rgba(…)"); null when it's transparent or unreadable. */
function rgb(color: string): [number, number, number] | null {
  const m = color.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
  if (!m) return null;
  const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  if (alpha === 0) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Plain white or black is the page, not a box. */
const plain = ([r, g, b]: [number, number, number]) => Math.min(r, g, b) >= 248 || Math.max(r, g, b) <= 8;

/**
 * Runs on every rendered chapter while only the book's own styles apply (before `pageCss`).
 *
 * Some books shrink whole passages, such as the sidebars of "For Dummies" books at 62.5%. That
 * reads as the text suddenly getting smaller, and because line spacing is set per paragraph, it
 * leaves wide gaps between the small lines. Such text is raised to `SMALLEST_TEXT` of the body's
 * size. Sizes are pinned in rem, so they still follow the reader's text size.
 *
 * Tinted blocks (sidebars, notes) lose their colour to the skin, so they are marked
 * `data-reader-box` for `pageCss` to tint in the skin's colours instead.
 */
export function adjustBookStyles(doc: Document) {
  const view = doc.defaultView;
  const body = doc.body;
  if (!view || !body) return;
  const root = parseFloat(view.getComputedStyle(doc.documentElement).fontSize);
  const bodyStyle = view.getComputedStyle(body);
  const floor = parseFloat(bodyStyle.fontSize) * SMALLEST_TEXT;
  if (!(root > 0 && floor > 0)) return;
  const page = bodyStyle.backgroundColor;

  // Measure everything before changing anything, so each size is the book's own.
  const elements = Array.from(body.getElementsByTagName("*")).filter((e): e is HTMLElement => e.namespaceURI === XHTML);
  const measured = new Map<Element, { size: number; display: string; background: string; exempt: boolean }>();
  for (const e of elements) {
    const s = view.getComputedStyle(e);
    measured.set(e, {
      size: parseFloat(s.fontSize),
      display: s.display,
      background: s.backgroundColor,
      exempt: SMALL_ON_PURPOSE.has(e.localName) || s.verticalAlign === "super" || s.verticalAlign === "sub",
    });
  }

  const exempt = new Set<Element>();
  const pinned = new Set<Element>();
  const boxes = new Map<Element, string>();
  for (const e of elements) {
    const m = measured.get(e)!;
    const parent = e.parentElement;
    const above = parent ? measured.get(parent) : undefined;

    // Sizes relative to an exempt element follow it, whatever happens to its parent.
    if (m.exempt || (parent && exempt.has(parent))) exempt.add(e);
    else if (m.size > 0) {
      const inherits = above !== undefined && m.size === above.size;
      if (inherits) {
        if (parent && pinned.has(parent)) pinned.add(e);
      } else if (m.size < floor || (parent && pinned.has(parent))) {
        // Below the floor it's raised; under a raised parent it keeps its own size.
        e.style.setProperty("font-size", `${(Math.max(m.size, floor) / root).toFixed(4)}rem`, "important");
        pinned.add(e);
      }
    }

    const color = rgb(m.background);
    if (!color || plain(color) || m.background === page) continue;
    if (m.display === "none" || m.display === "contents" || m.display.startsWith("inline")) continue;
    // A block inside a box of the same colour is part of that box.
    let outer = parent;
    while (outer && outer !== body && !boxes.has(outer)) outer = outer.parentElement;
    if (outer && boxes.get(outer) === m.background) continue;
    boxes.set(e, m.background);
    e.setAttribute("data-reader-box", m.display.startsWith("table") ? "cell" : "block");
  }
}
