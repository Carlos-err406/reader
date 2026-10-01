// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { currentEntry, type TocEntry } from "./viewer";

const entry = (label: string, order: number, depth = 0): TocEntry => ({ label, location: label, depth, at: order / 10, order });

describe("currentEntry", () => {
  const toc = [entry("Cover", 0), entry("One", 1), entry("One, part a", 1, 1), entry("Two", 5), entry("Notes", 9)];

  it("is the last entry starting at or before the section being read", () => {
    expect(currentEntry(toc, 3)).toBe(1);
    expect(currentEntry(toc, 5)).toBe(3);
    expect(currentEntry(toc, 12)).toBe(4);
  });

  it("picks the chapter over its sections when they start together", () => {
    expect(currentEntry(toc, 1)).toBe(1);
  });

  it("is none before the first entry or without entries", () => {
    expect(currentEntry([entry("Late", 2)], 1)).toBe(-1);
    expect(currentEntry([], 5)).toBe(-1);
  });
});

describe("openingTitle", async () => {
  const { openingTitle } = await import("./EpubView");
  const parse = (html: string) => new DOMParser().parseFromString(`<html><body>${html}</body></html>`, "text/html").body;

  it("joins the bold lines a converted chapter opens with, skipping ornaments", () => {
    const body = parse(`
      <div><p><span class="calibre8"><span class="bold">Capítulo 4</span></span></p>
      <blockquote><p><span class="bold">. . . . . . . .</span></p></blockquote>
      <div>&nbsp;</div>
      <p><span><span class="bold">Arquitecto de tu patrimonio</span></span></p>
      <p><span class="bold">En este capítulo</span></p>
      <p>Lorem ipsum dolor sit amet, a body paragraph that goes on for a while and is not a title.</p></div>`);
    expect(openingTitle(body)).toBe("Capítulo 4 · Arquitecto de tu patrimonio");
  });

  it("uses real headings, and finds none where a section opens with body text", () => {
    expect(openingTitle(parse("<h2>Part One</h2><p>Text.</p>"))).toBe("Part One");
    expect(openingTitle(parse("<p>continuing from the previous section, the story went on</p><h2>Late</h2>"))).toBeUndefined();
  });
});
