import { describe, expect, it } from "vitest";
import { DEFAULT_DISPLAY, normalize, pageCss, palette, stepSize, type Display } from "./display";

const css = (patch: Partial<Display>) => {
  const display = { ...DEFAULT_DISPLAY, ...patch };
  return pageCss(display, palette(display, false));
};

describe("display settings", () => {
  it("falls back to defaults for unknown or old saved values", () => {
    const saved = { ...DEFAULT_DISPLAY, skin: "neon", spacing: "3", align: undefined } as unknown as Display;
    expect(normalize(saved)).toEqual(DEFAULT_DISPLAY);
  });

  it("steps text size within its range, from any pinched size", () => {
    expect(stepSize(100, 1)).toBe(110);
    expect(stepSize(80, -1)).toBe(80);
    expect(stepSize(170, 1)).toBe(170);
    expect(stepSize(127, 1)).toBe(135);
    expect(stepSize(127, -1)).toBe(120);
    expect(normalize({ ...DEFAULT_DISPLAY, size: 127 }).size).toBe(127);
    expect(normalize({ ...DEFAULT_DISPLAY, size: 999 }).size).toBe(200);
  });

  it("forces line spacing only when one is chosen", () => {
    expect(css({ spacing: "1.7" })).toContain("line-height: 1.7 !important");
    expect(css({ spacing: "book" })).not.toContain("line-height");
  });

  it("aligns running text, hyphenating when justified", () => {
    expect(css({ align: "justify" })).toMatch(/body p.*text-align: justify !important; hyphens: auto/);
    expect(css({ align: "left" })).toContain("text-align: start !important");
    expect(css({ align: "book" })).not.toContain("text-align");
  });

  it("centres a readable column only in scroll layout", () => {
    expect(css({ layout: "scroll" })).toContain("max-width: 46rem");
    expect(css({ layout: "pages" })).not.toContain("max-width");
  });

  it("keeps the book's fonts when asked", () => {
    expect(css({ font: "original" })).not.toContain("font-family");
    expect(css({ font: "hyperlegible" })).toContain('font-family: "Atkinson Hyperlegible"');
  });
});
