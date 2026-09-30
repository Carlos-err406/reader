// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { stripActiveContent } from "./sanitize";

const chapter = (body: string) =>
  new DOMParser().parseFromString(
    `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title><meta http-equiv="X-UA-Compatible" content="IE=edge"/></head><body>${body}</body></html>`,
    "application/xhtml+xml",
  );

describe("stripActiveContent", () => {
  it("removes everything that could run", () => {
    const doc = chapter(
      `<script>steal()</script><p onclick="steal()" id="p">Text <a href="javascript:steal()">link</a> <a href="next.xhtml">next</a></p>` +
        `<iframe title="embedded"></iframe><object data="x.swf"></object><embed src="x"/><svg xmlns="http://www.w3.org/2000/svg"><script>steal()</script></svg>`,
    );
    stripActiveContent(doc);
    const html = new XMLSerializer().serializeToString(doc);
    expect(html).not.toMatch(/<script|<iframe|<object|<embed|onclick|javascript:|X-UA-Compatible/i);
    // Ordinary content and links survive.
    expect(doc.getElementById("p")?.textContent).toContain("Text");
    expect(doc.querySelector('a[href="next.xhtml"]')).not.toBeNull();
  });

  it("puts a script-blocking policy first in the head", () => {
    const doc = chapter("<p>x</p>");
    stripActiveContent(doc);
    const first = doc.head.firstElementChild;
    expect(first?.getAttribute("http-equiv")).toBe("Content-Security-Policy");
    expect(first?.getAttribute("content")).toContain("script-src 'none'");
  });
});
