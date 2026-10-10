import { describe, expect, it } from "vitest";
import { sentences, spoken } from "./sentences";

const pieces = (text: string, lang?: string) => sentences(text, lang).map(([a, b]) => text.slice(a, b));

describe("sentences to read aloud", () => {
  it("split prose into sentences, without the space around them", () => {
    expect(pieces("Call me Ishmael.  Some years ago, I went to sea! Why? ", "en")).toEqual([
      "Call me Ishmael.",
      "Some years ago, I went to sea!",
      "Why?",
    ]);
  });

  it("end at line breaks, so a heading isn't read into its paragraph", () => {
    expect(pieces("Chapter 1\nIt was a dark night. It rained.")).toEqual(["Chapter 1", "It was a dark night.", "It rained."]);
  });

  it("skip pieces with nothing to say", () => {
    expect(pieces("* * *\nHello.\n. . .")).toEqual(["Hello."]);
  });

  it("cut very long sentences at a space", () => {
    const long = Array.from({ length: 300 }, () => "word").join(" ");
    const parts = pieces(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 600 && !p.startsWith(" "))).toBe(true);
    expect(parts.join(" ")).toBe(long);
  });

  it("are spoken with words broken across lines joined", () => {
    expect(spoken("an exam-\nple of  text\non lines")).toBe("an example of text on lines");
    expect(spoken("Jean-\nPaul")).toBe("Jean- Paul");
  });
});
