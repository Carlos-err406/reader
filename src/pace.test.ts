import { describe, expect, it } from "vitest";
import { add, amount, duration, follow, rate, timeLeft, timeLeftLine, total, type Stretch } from "./pace";
import type { TocEntry } from "./viewer";

const MIN = 60_000;

describe("reading speed", () => {
  it("starts from the usual speed and moves toward the reader's", () => {
    expect(rate(undefined, "epub")).toBe(1);
    expect(rate(undefined, "pdf")).toBe(0.5);
    // Twenty minutes at two locations a minute.
    const fast = add(undefined, 40, 20, "epub");
    expect(rate(fast, "epub")).toBeCloseTo((40 + 5) / 25);
  });

  it("ignores skimming, going back and moments too short to tell", () => {
    expect(add(undefined, 100, 2, "epub")).toEqual({ units: 0, minutes: 0 });
    expect(add(undefined, -3, 5, "epub")).toEqual({ units: 0, minutes: 0 });
    expect(add(undefined, 1, 0.1, "epub")).toEqual({ units: 0, minutes: 0 });
  });

  it("adds up every device's reading of a format", () => {
    const paces = {
      mine: { epub: { units: 30, minutes: 20 }, at: 1 },
      others: [{ epub: { units: 90, minutes: 60 }, pdf: { units: 4, minutes: 10 }, at: 1 }, { pdf: null, at: 1 }],
    };
    expect(total(paces, "epub")).toEqual({ units: 120, minutes: 80 });
    expect(total(paces, "pdf")).toEqual({ units: 4, minutes: 10 });
    expect(total({ mine: null, others: [] }, "epub")).toEqual({ units: 0, minutes: 0 });
  });

  it("remembers only the latest reading", () => {
    let pace = add(undefined, 100, 100, "epub");
    pace = add(pace, 300, 100, "epub");
    expect(pace.minutes).toBeCloseTo(120);
    expect(pace.units / pace.minutes).toBeCloseTo(2);
  });
});

describe("stretches of reading", () => {
  const size = 1000;
  const start = follow(null, 0.1, 0, size, false).stretch;

  it("grow as the reader reads on", () => {
    let s: Stretch = start;
    for (let i = 1; i <= 5; i++) s = follow(s, 0.1 + i * 0.001, i * MIN, size, true).stretch;
    expect(amount(s, size)).toEqual({ units: expect.closeTo(5), minutes: 5 });
  });

  it("end at a jump, a long pause or a step back", () => {
    expect(follow(start, 0.2, MIN, size, true).ended).toBe(start);
    expect(follow(start, 0.101, 10 * MIN, size, true).ended).toBe(start);
    expect(follow(start, 0.09, MIN, size, true).ended).toBe(start);
    // The book moved without the reader: a jump, or opening it.
    expect(follow(start, 0.101, MIN, size, false).ended).toBe(start);
  });

  it("carry on through a glance back", () => {
    const s = follow(start, 0.1005, MIN, size, true).stretch;
    const back = follow(s, 0.1, 2 * MIN, size, true);
    expect(back.ended).toBeUndefined();
    expect(back.stretch.to).toBe(0.1005);
  });
});

describe("time left", () => {
  const entry = (at: number, depth = 0): TocEntry => ({ label: "", location: "", depth, at, order: 0 });

  it("runs to the next chapter and to the end", () => {
    const left = timeLeft(0.25, 1000, [entry(0), entry(0.2), entry(0.27, 1), entry(0.3), entry(0.6)], 2);
    expect(left.chapter).toBeCloseTo(25);
    expect(left.book).toBeCloseTo(375);
  });

  it("counts the chapter just started as the one being read", () => {
    // The page's place rounds to a hair before the chapter's start.
    expect(timeLeft(0.2999, 1000, [entry(0.3), entry(0.4)], 1).chapter).toBeCloseTo(100.1);
  });

  it("has no chapter without a table of contents", () => {
    expect(timeLeft(0.5, 100, [], 1).chapter).toBeUndefined();
    expect(timeLeft(0.5, 100, null, 1).chapter).toBeUndefined();
  });

  it("reads naturally", () => {
    expect(duration(0.4)).toBe("less than a minute");
    expect(duration(12.3)).toBe("12 min");
    expect(duration(80)).toBe("1 h 20 min");
    expect(duration(119)).toBe("2 h");
    expect(duration(250)).toBe("4 h");
    expect(timeLeftLine({ chapter: 12, book: 245 })).toBe("12 min left in chapter · 4 h in book");
    expect(timeLeftLine({ chapter: 0.5, book: 3 })).toBe("Less than a minute left in chapter · 3 min in book");
    expect(timeLeftLine({ book: 30 })).toBe("30 min left in book");
  });
});
