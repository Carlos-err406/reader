import literataNormal from "@fontsource-variable/literata/files/literata-latin-wght-normal.woff2?url";
import literataItalic from "@fontsource-variable/literata/files/literata-latin-wght-italic.woff2?url";
import literataExtNormal from "@fontsource-variable/literata/files/literata-latin-ext-wght-normal.woff2?url";
import literataExtItalic from "@fontsource-variable/literata/files/literata-latin-ext-wght-italic.woff2?url";
import atkinson400 from "@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-400-normal.woff2?url";
import atkinson400i from "@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-400-italic.woff2?url";
import atkinson700 from "@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-700-normal.woff2?url";
import atkinson700i from "@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-700-italic.woff2?url";

export type Mode = "system" | "light" | "dark";
export type Layout = "scroll" | "pages";
/** "book" keeps the book's own setting. */
export type Spacing = "book" | "1.3" | "1.5" | "1.7" | "2.0";
export type Align = "book" | "left" | "justify";

export const SPACINGS: Spacing[] = ["book", "1.3", "1.5", "1.7", "2.0"];
export const ALIGNS: Align[] = ["book", "left", "justify"];

export interface Palette {
  bg: string;
  paper: string;
  ink: string;
  muted: string;
  line: string;
  accent: string;
  accentInk: string;
}

export interface Skin {
  id: string;
  name: string;
  light: Palette;
  dark: Palette;
}

export const SKINS: Skin[] = [
  {
    id: "paper",
    name: "Paper",
    light: { bg: "#f6f2ea", paper: "#fbf8f2", ink: "#1d1b18", muted: "#6d665c", line: "#e2dacb", accent: "#1f3a5f", accentInk: "#ffffff" },
    dark: { bg: "#141312", paper: "#1a1917", ink: "#e8e3da", muted: "#9c958a", line: "#2d2b27", accent: "#8fb3e6", accentInk: "#10213a" },
  },
  {
    id: "sepia",
    name: "Sepia",
    light: { bg: "#ece0c8", paper: "#f5ebd6", ink: "#3b2f22", muted: "#7a6a55", line: "#dccbac", accent: "#8a4b1f", accentInk: "#ffffff" },
    dark: { bg: "#18130e", paper: "#211a13", ink: "#e6d6bd", muted: "#a8977d", line: "#3a2f24", accent: "#e0a36b", accentInk: "#2a1707" },
  },
  {
    id: "slate",
    name: "Slate",
    light: { bg: "#eaeef2", paper: "#f7f9fb", ink: "#1b2330", muted: "#5d6b7c", line: "#d6dde6", accent: "#2d5b8a", accentInk: "#ffffff" },
    dark: { bg: "#0e1318", paper: "#141a21", ink: "#dce4ed", muted: "#8d9aab", line: "#25303b", accent: "#7fb0e8", accentInk: "#0b1f36" },
  },
  {
    id: "contrast",
    name: "Contrast",
    light: { bg: "#f2f2f2", paper: "#ffffff", ink: "#000000", muted: "#555555", line: "#d9d9d9", accent: "#0b57d0", accentInk: "#ffffff" },
    dark: { bg: "#000000", paper: "#000000", ink: "#f2f2f2", muted: "#9a9a9a", line: "#262626", accent: "#8ab4f8", accentInk: "#062e6f" },
  },
];

export interface Font {
  id: string;
  name: string;
  /** `null` keeps the book's own fonts. */
  stack: string | null;
}

export const FONTS: Font[] = [
  { id: "literata", name: "Literata", stack: `"Literata Variable", Georgia, serif` },
  { id: "serif", name: "Serif", stack: `Georgia, "Iowan Old Style", "Noto Serif", serif` },
  { id: "sans", name: "Sans", stack: `system-ui, -apple-system, Roboto, "Segoe UI", sans-serif` },
  { id: "hyperlegible", name: "Hyperlegible", stack: `"Atkinson Hyperlegible", system-ui, sans-serif` },
  { id: "original", name: "Book's own", stack: null },
];

/** Button steps; a pinch can land anywhere between MIN_SIZE and MAX_SIZE. */
export const SIZES = [80, 90, 100, 110, 120, 135, 150, 170] as const;
export const MIN_SIZE = 70;
export const MAX_SIZE = 200;
export const clampSize = (size: number) => Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(size)));

export interface Display {
  mode: Mode;
  skin: string;
  font: string;
  /** Percent of the book's base size. */
  size: number;
  layout: Layout;
  spacing: Spacing;
  align: Align;
  /** Android: the volume buttons turn pages while reading. */
  volumeKeys: boolean;
  /** Android: the screen stays on while reading. */
  keepAwake: boolean;
}

export const DEFAULT_DISPLAY: Display = {
  mode: "system",
  skin: "paper",
  font: "literata",
  size: 100,
  layout: "scroll",
  spacing: "1.5",
  align: "book",
  volumeKeys: true,
  keepAwake: true,
};

const KEY = "reader:display";

/** Per device: the right size on a phone and on a desktop differ. */
export function loadDisplay(): Display {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Display> | null;
    return normalize({ ...DEFAULT_DISPLAY, ...saved });
  } catch {
    return DEFAULT_DISPLAY;
  }
}

export function saveDisplay(display: Display) {
  try {
    localStorage.setItem(KEY, JSON.stringify(display));
  } catch {}
}

export function normalize(d: Display): Display {
  return {
    mode: ["system", "light", "dark"].includes(d.mode) ? d.mode : DEFAULT_DISPLAY.mode,
    skin: SKINS.some((s) => s.id === d.skin) ? d.skin : DEFAULT_DISPLAY.skin,
    font: FONTS.some((f) => f.id === d.font) ? d.font : DEFAULT_DISPLAY.font,
    size: Number.isFinite(d.size) ? clampSize(d.size) : DEFAULT_DISPLAY.size,
    layout: d.layout === "pages" ? "pages" : "scroll",
    spacing: SPACINGS.includes(d.spacing) ? d.spacing : DEFAULT_DISPLAY.spacing,
    align: ALIGNS.includes(d.align) ? d.align : DEFAULT_DISPLAY.align,
    volumeKeys: typeof d.volumeKeys === "boolean" ? d.volumeKeys : DEFAULT_DISPLAY.volumeKeys,
    keepAwake: typeof d.keepAwake === "boolean" ? d.keepAwake : DEFAULT_DISPLAY.keepAwake,
  };
}

/** The next button step from any size, including one left by a pinch. */
export function stepSize(size: number, step: 1 | -1): number {
  const next = step > 0 ? SIZES.find((s) => s > size) : [...SIZES].reverse().find((s) => s < size);
  return next ?? size;
}

export function palette(display: Display, dark: boolean): Palette {
  const skin = SKINS.find((s) => s.id === display.skin) ?? SKINS[0]!;
  return dark ? skin.dark : skin.light;
}

/** Applies the skin to the app chrome through the CSS variables in styles.css. */
export function applyChrome(p: Palette, dark: boolean) {
  const root = document.documentElement;
  const vars: Record<string, string> = {
    "--background": p.bg,
    "--card": p.paper,
    "--foreground": p.ink,
    "--muted-foreground": p.muted,
    "--border": p.line,
    "--primary": p.accent,
    "--primary-foreground": p.accentInk,
  };
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  root.style.colorScheme = dark ? "dark" : "light";
  root.dataset.theme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", p.paper);
}

// Chapters are separate documents, so font files need absolute URLs.
const absolute = (url: string) => new URL(url, globalThis.location?.href ?? "http://localhost/").href;

/** Book pages live in their own iframe documents, so they need the font files declared again. */
function fontFaces(): string {
  const face = (family: string, url: string, style: string, weight: string, range: string) =>
    `@font-face{font-family:"${family}";src:url("${absolute(url)}") format("woff2");font-style:${style};font-weight:${weight};font-display:swap;unicode-range:${range};}`;
  const latin = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
  const ext = "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";
  return [
    face("Literata Variable", literataNormal, "normal", "200 900", latin),
    face("Literata Variable", literataItalic, "italic", "200 900", latin),
    face("Literata Variable", literataExtNormal, "normal", "200 900", ext),
    face("Literata Variable", literataExtItalic, "italic", "200 900", ext),
    face("Atkinson Hyperlegible", atkinson400, "normal", "400", latin),
    face("Atkinson Hyperlegible", atkinson400i, "italic", "400", latin),
    face("Atkinson Hyperlegible", atkinson700, "normal", "700", latin),
    face("Atkinson Hyperlegible", atkinson700i, "italic", "700", latin),
  ].join("\n");
}

/**
 * The stylesheet injected into every EPUB chapter. Books ship their own colours (usually black
 * on white), which must lose to the skin or text vanishes in dark mode, so colours are forced.
 */
export function pageCss(display: Display, p: Palette): string {
  const font = FONTS.find((f) => f.id === display.font)?.stack ?? null;
  return `
${font ? fontFaces() : ""}
html { font-size: ${display.size}% !important; touch-action: pan-x pan-y; }
html, body { background: ${p.paper} !important; color: ${p.ink} !important; }
${
  display.spacing === "book"
    ? ""
    : `body, body *:not(ruby):not(rt) { line-height: ${display.spacing} !important; }`
}
${
  // Only running text: headings, captions and centred lines keep the book's alignment.
  display.align === "book"
    ? ""
    : `body p, body li, body blockquote, body dd { text-align: ${display.align === "justify" ? "justify" : "start"} !important;${
        display.align === "justify" ? " hyphens: auto; -webkit-hyphens: auto;" : " hyphens: manual;"
      } }`
}
body * { color: inherit !important; background-color: transparent !important; border-color: ${p.line} !important; }
a, a * { color: ${p.accent} !important; }
${font ? `body, body *:not(code):not(pre):not(kbd):not(samp) { font-family: ${font} !important; }` : ""}
${
  // Scroll layout: chapters span the window (so the margins scroll too); keep a readable column.
  display.layout === "scroll"
    ? "body { max-width: 46rem !important; margin-left: auto !important; margin-right: auto !important; padding-left: 1.25rem !important; padding-right: 1.25rem !important; box-sizing: border-box !important; }"
    : ""
}
`;
}
