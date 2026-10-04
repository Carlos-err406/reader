// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { EpubCFI } from "epubjs";
import { cfiRepairs, mergeLines, overlaps, pdfHighlightLocation, pdfHighlightRects, textBounded, type PageRect } from "./highlights";
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

describe("overlaps", () => {
  const text = () => {
    document.body.innerHTML = "<p>Todos tenemos que superar obstáculos</p>";
    return document.body.firstChild!.firstChild!;
  };
  const span = (node: Node, start: number, end: number) => {
    const r = document.createRange();
    r.setStart(node, start);
    r.setEnd(node, end);
    return r;
  };

  it("finds ranges sharing text, in either order", () => {
    const t = text();
    expect(overlaps(span(t, 0, 10), span(t, 5, 20))).toBe(true);
    expect(overlaps(span(t, 5, 20), span(t, 0, 10))).toBe(true);
    // One inside the other.
    expect(overlaps(span(t, 0, 30), span(t, 10, 12))).toBe(true);
    expect(overlaps(span(t, 10, 12), span(t, 0, 30))).toBe(true);
  });

  it("doesn't count ranges that only touch or are apart", () => {
    const t = text();
    expect(overlaps(span(t, 0, 5), span(t, 5, 10))).toBe(false);
    expect(overlaps(span(t, 5, 10), span(t, 0, 5))).toBe(false);
    expect(overlaps(span(t, 0, 3), span(t, 8, 12))).toBe(false);
  });
});

describe("highlights starting at an image", () => {
  // As in "Finanzas personales para Dummies": an icon wrapped in spans, then the paragraph's text.
  const paragraph = () => {
    document.body.innerHTML =
      '<p><span class="text"><span><span><span class="icon"><img src="clave.jpg"/></span></span></span>Ganar más dinero no es la solución.</span></p>';
    const icon = document.querySelector(".icon")!;
    const text = document.querySelector(".text")!.lastChild as Text;
    // A selection dragged from the icon starts between elements, right after the image.
    const range = document.createRange();
    range.setStart(icon, 1);
    range.setEnd(text, 20);
    return range;
  };
  const resolve = (cfi: string) => new EpubCFI(cfi).toRange(document)?.toString() ?? null;

  it("is saved where epub.js can find it again", () => {
    const range = paragraph();
    // epub.js alone writes a text step that isn't there: the highlight can never be drawn.
    expect(resolve(new EpubCFI(range, "/6/22!").toString())).toBeNull();
    const bounded = textBounded(range);
    expect(bounded.startContainer.nodeType).toBe(3);
    expect(resolve(new EpubCFI(bounded, "/6/22!").toString())).toBe("Ganar más dinero no ");
  });

  it("mends ranges older versions saved with that step", () => {
    const broken = new EpubCFI(paragraph(), "/6/22!").toString();
    const mended = cfiRepairs(broken).map(resolve);
    expect(mended).toContain("Ganar más dinero no ");
    // The shape found in a real library.
    expect(cfiRepairs("epubcfi(/6/22!/4/2/142/2/2,/2/2/2/1:1,/1:286)")).toContain("epubcfi(/6/22!/4/2/142/2/2,/2/2/2:1,/1:286)");
    expect(cfiRepairs("epubcfi(/6/22!/4/2/142/2/2/1:4)")).toEqual([]);
  });

  it("leaves selections that are already in text alone", () => {
    const range = paragraph();
    const text = document.querySelector(".text")!.lastChild as Text;
    range.setStart(text, 6);
    expect(textBounded(range)).toBe(range);
  });
});
