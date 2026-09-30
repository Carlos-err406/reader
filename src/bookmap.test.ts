import { describe, expect, it } from "vitest";
import { fromBook, sectionSpans, spineIndex, toBook } from "./bookmap";

const loc = (spine: number, n = 0) => `epubcfi(/6/${(spine + 1) * 2}!/4/2/${n})`;

describe("book map", () => {
  it("reads the spine index from a CFI", () => {
    expect(spineIndex("epubcfi(/6/2!/4/2/1:0)")).toBe(0);
    expect(spineIndex("epubcfi(/6/14[ch6]!/4/2)")).toBe(6);
    expect(spineIndex("not a cfi")).toBeNull();
  });

  it("sizes sections by length, keeping short ones reachable", () => {
    // An image page, then a long chapter, then a medium one.
    const spans = sectionSpans([loc(1), loc(1), loc(1), loc(1), loc(1), loc(1), loc(2), loc(2)], 3);
    expect(spans[0]!.start).toBe(0);
    expect(spans[2]!.end).toBeCloseTo(1);
    expect(spans[0]!.end - spans[0]!.start).toBeGreaterThan(0);
    expect(spans[1]!.end - spans[1]!.start).toBeGreaterThan(spans[2]!.end - spans[2]!.start);
  });

  it("round-trips positions", () => {
    const spans = sectionSpans([loc(0), loc(1), loc(1), loc(2), loc(2), loc(2)], 3);
    for (const f of [0, 0.1, 0.33, 0.5, 0.77, 0.999]) {
      const { index, within } = fromBook(spans, f);
      expect(toBook(spans, index, within)).toBeCloseTo(f);
    }
    expect(fromBook(spans, 1).index).toBe(2);
    expect(fromBook(spans, 1).within).toBeCloseTo(1);
  });
});
