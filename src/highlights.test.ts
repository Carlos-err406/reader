import { describe, expect, it } from "vitest";
import { mergeLines, pdfHighlightLocation, pdfHighlightRects, type PageRect } from "./highlights";
import { pdfPage } from "./format";

describe("PDF highlight locations", () => {
  it("round-trip their rectangles and open at the first page", () => {
    const rects: PageRect[] = [
      [12, 0.123456, 0.2, 0.5, 0.03],
      [13, 0.1, 0.05, 0.4, 0.03],
    ];
    const location = pdfHighlightLocation(rects);
    expect(pdfPage(location, 100)).toBe(12);
    expect(pdfHighlightRects(location)).toEqual([
      [12, 0.1235, 0.2, 0.5, 0.03],
      [13, 0.1, 0.05, 0.4, 0.03],
    ]);
  });

  it("ignore malformed data", () => {
    expect(pdfHighlightRects("4")).toEqual([]);
    expect(pdfHighlightRects('4:[[4,"x",0,1,1],[4,0,0,1,1]]')).toEqual([[4, 0, 0, 1, 1]]);
  });
});

describe("mergeLines", () => {
  it("joins the runs of one line and keeps lines apart", () => {
    const merged = mergeLines([
      [1, 0.1, 0.1, 0.2, 0.02],
      [1, 0.3, 0.101, 0.25, 0.019],
      [1, 0.1, 0.13, 0.4, 0.02],
      [2, 0.1, 0.1, 0.2, 0.02],
    ]);
    expect(merged).toHaveLength(3);
    expect(merged[0]![1]).toBeCloseTo(0.1);
    expect(merged[0]![3]).toBeCloseTo(0.45);
    expect(merged[2]![0]).toBe(2);
  });

  it("splits the overlap between neighbouring lines", () => {
    const [first, second] = mergeLines([
      [1, 0.1, 0.1, 0.5, 0.02],
      [1, 0.1, 0.115, 0.5, 0.02],
    ]);
    expect(first![2] + first![4]).toBeCloseTo(second![2]);
    expect(second![2]).toBeCloseTo(0.1175);
    expect(second![2] + second![4]).toBeCloseTo(0.135);
  });
});
