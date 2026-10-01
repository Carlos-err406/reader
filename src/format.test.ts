import { describe, expect, it } from "vitest";
import type { Status } from "./api";
import { ago, countdown, epubLabel, pdfPage, pdfPosition, plural, statusLine, titleFromFileName } from "./format";

const status = (patch: Partial<Status>): Status => ({
  enabled: true,
  syncing: false,
  pending: false,
  lastSync: null,
  error: null,
  offline: false,
  activity: null,
  retryAt: null,
  account: "reader@example.com",
  platform: "desktop",
  library: { books: 0, localBooks: 0, bookmarks: 0, highlights: 0 },
  google: { configured: true, connected: true, connecting: false, error: null },
  ...patch,
});

describe("format", () => {
  it("derives titles from file names", () => {
    expect(titleFromFileName("The_Left_Hand_of_Darkness.epub")).toBe("The Left Hand of Darkness");
    expect(titleFromFileName("report.PDF")).toBe("report");
    expect(titleFromFileName(".pdf")).toBe("Untitled");
  });

  it("round-trips PDF positions and clamps stale pages", () => {
    expect(pdfPosition(42, 300)).toEqual({ location: "42", label: "Page 42 of 300", fraction: 0.14 });
    expect(pdfPage("42", 300)).toBe(42);
    expect(pdfPage("900", 300)).toBe(300);
    expect(pdfPage(undefined, 300)).toBe(1);
    expect(pdfPage("epubcfi(/6/2)", 10)).toBe(1);
  });

  it("labels EPUB positions", () => {
    expect(epubLabel(0.374, " Chapter 3 ")).toBe("Chapter 3 · 37%");
    expect(epubLabel(1, undefined)).toBe("100%");
  });

  it("describes sync state", () => {
    const now = 1_000_000;
    const off = { ...status({}).google, connected: false };
    expect(statusLine(status({ enabled: false, google: off }))).toEqual({ text: "Sync off", tone: "off" });
    expect(statusLine(status({ enabled: false })).text).toBe("Sync paused");
    expect(statusLine(status({ syncing: true })).tone).toBe("busy");
    expect(statusLine(status({ error: "x", offline: true }))).toEqual({ text: "Offline", tone: "warn" });
    expect(statusLine(status({ error: "Drive said no" }))).toEqual({ text: "Sync problem", tone: "error" });
    expect(statusLine(status({ pending: true })).text).toBe("Changes waiting");
    expect(statusLine(status({ lastSync: now - 5 * 60_000 }), now).text).toBe("Synced 5m ago");
    expect(ago(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(ago(now - 10_000, now)).toBe("just now");
  });

  it("formats retries and counts", () => {
    expect(countdown(1_040_000, 1_000_000)).toBe("40 s");
    expect(countdown(1_000_000 + 90_000, 1_000_000)).toBe("2 min");
    expect(plural(1, "book")).toBe("1 book");
    expect(plural(3, "bookmark")).toBe("3 bookmarks");
  });
});
