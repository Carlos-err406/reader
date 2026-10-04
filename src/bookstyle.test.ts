// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { adjustBookStyles } from "./bookstyle";

// happy-dom's cascade gets nested em sizes and table display wrong, so each element states what a
// browser would compute: data-px (font size, inherited when absent), data-bg, data-display, data-va.
function chapter(body: string) {
  document.body.innerHTML = body;
  const computed = (e: Element): Partial<CSSStyleDeclaration> => {
    const inherited = e.parentElement ? computed(e.parentElement).fontSize : "16px";
    return {
      fontSize: e.getAttribute("data-px") ? `${e.getAttribute("data-px")}px` : inherited,
      backgroundColor: e.getAttribute("data-bg") ?? "rgba(0, 0, 0, 0)",
      display: e.getAttribute("data-display") ?? (e.localName === "span" || e.localName === "sup" ? "inline" : "block"),
      verticalAlign: e.getAttribute("data-va") ?? "baseline",
    };
  };
  vi.spyOn(window, "getComputedStyle").mockImplementation((e) => computed(e) as CSSStyleDeclaration);
  adjustBookStyles(document);
}
const size = (id: string) => document.getElementById(id)!.style.getPropertyValue("font-size");
const box = (id: string) => document.getElementById(id)!.getAttribute("data-reader-box");

describe("adjustBookStyles", () => {
  afterEach(() => vi.restoreAllMocks());

  it("raises text the book shrinks, in rem so it follows the reader's size", () => {
    chapter(`<p><span data-px="10" id="s">a</span></p><p data-px="12" id="m">b</p>`);
    expect(size("s")).toBe("0.9rem");
    expect(size("m")).toBe("0.9rem");
  });

  it("leaves body-sized and larger text alone", () => {
    chapter(`<h2 data-px="24" id="h">T</h2><p id="p">x</p><p data-px="15.2" id="n">y</p>`);
    expect(size("h")).toBe("");
    expect(size("p")).toBe("");
    expect(size("n")).toBe("");
  });

  it("keeps a larger heading inside shrunk text at its own size", () => {
    // A 0.625em box holding a 1.6em title and a plain paragraph.
    chapter(`<div data-px="10" id="b"><p data-px="16" id="t">T</p><p id="p">x</p></div>`);
    expect(size("b")).toBe("0.9rem");
    // Pinned at 1em instead of growing with the box; the paragraph just inherits the box's size.
    expect(size("t")).toBe("1rem");
    expect(size("p")).toBe("");
  });

  it("leaves note marks small", () => {
    chapter(`<p>x<sup data-px="12" data-va="super" id="n">1</sup></p>`);
    expect(size("n")).toBe("");
  });

  it("marks tinted blocks as boxes, once per box", () => {
    const teal = "rgb(226, 242, 242)";
    chapter(
      `<div data-bg="${teal}" id="b"><div data-bg="${teal}" id="inner">x</div></div>` +
        `<div data-bg="rgb(255, 255, 255)" id="w">y</div>` +
        `<div data-bg="rgb(238, 238, 221)" data-display="table-cell" id="c">z</div>` +
        `<span data-bg="${teal}" id="i">i</span>`,
    );
    expect(box("b")).toBe("block");
    expect(box("inner")).toBeNull();
    expect(box("w")).toBeNull();
    expect(box("c")).toBe("cell");
    expect(box("i")).toBeNull();
  });
});
