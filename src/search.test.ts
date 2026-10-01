import { describe, expect, it } from "vitest";
import { excerpt, foldQuery, matches } from "./search";

describe("matches", () => {
  it("ignores case and accents, and points at the original text", () => {
    const text = "El Crédito y el credito: CRÉDITOS.";
    const found = matches(text, foldQuery("credito"));
    expect(found.map(([s, e]) => text.slice(s, e))).toEqual(["Crédito", "credito", "CRÉDITO"]);
  });

  it("matches across line breaks and runs of spaces", () => {
    const text = "the age of\nwisdom, the  age   of foolishness";
    expect(matches(text, foldQuery("age of  wisdom")).length).toBe(1);
    expect(matches(text, foldQuery("the age of")).length).toBe(1);
  });

  it("finds nothing for an empty query", () => {
    expect(matches("anything", foldQuery("   "))).toEqual([]);
  });
});

describe("excerpt", () => {
  it("keeps whole words around the match", () => {
    const text = "It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness";
    const at = text.indexOf("worst");
    const e = excerpt(text, at, at + 5, 20);
    expect(e.match).toBe("worst");
    expect(e.before.startsWith("…")).toBe(true);
    expect(e.before.endsWith("the ")).toBe(true);
    expect(e.after.startsWith(" of times")).toBe(true);
    expect(e.after.endsWith("…")).toBe(true);
  });

  it("doesn't add ellipses at the ends of the text", () => {
    expect(excerpt("short text", 0, 5)).toEqual({ before: "", match: "short", after: " text" });
  });
});
