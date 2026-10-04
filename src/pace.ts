import type { Paces, Reading } from "./api";
import type { TocEntry } from "./viewer";

/**
 * Reading speed. Units are EPUB locations (about 1200 characters) or PDF pages, so the speed
 * carries over between books of a format. Each device measures its own, and they sync.
 */
export type Kind = "epub" | "pdf";
export type Pace = Reading;

/** Until there's reading to go on: about 200 words a minute, or a PDF page every two minutes. */
const USUAL: Record<Kind, number> = { epub: 1, pdf: 0.5 };
/** The usual speed counts as this much reading, so a few odd minutes don't swing the estimate. */
const PRIOR = 5;
/** Only the latest reading counts (in minutes), so the estimate follows the reader. */
const REMEMBERED = 120;
/** A pause longer than this is the reader away, not reading. */
const AWAY = 5 * 60_000;
/** Moving on this many units at once is a jump (the scrubber, a link), not reading. */
const LEAP = 10;
/** Faster than this many times the usual speed is skimming, not reading. */
const SKIMMING = 6;

const none: Pace = { units: 0, minutes: 0 };

/** Every device's reading of a format, together. */
export function total(paces: Paces, kind: Kind): Pace {
  return [paces.mine, ...paces.others].reduce<Pace>(
    (sum, device) => ({ units: sum.units + (device?.[kind]?.units ?? 0), minutes: sum.minutes + (device?.[kind]?.minutes ?? 0) }),
    none,
  );
}

/** Units a minute. */
export function rate(pace: Pace | undefined, kind: Kind): number {
  const p = pace ?? none;
  return (p.units + PRIOR * USUAL[kind]) / (p.minutes + PRIOR);
}

/** The pace with some reading added, unless it doesn't look like reading. */
export function add(pace: Pace | undefined, units: number, minutes: number, kind: Kind): Pace {
  const p = pace ?? none;
  if (minutes < 0.25 || units < 0 || units / minutes > SKIMMING * USUAL[kind]) return p;
  const total = { units: p.units + units, minutes: p.minutes + minutes };
  const keep = Math.min(1, REMEMBERED / total.minutes);
  return { units: total.units * keep, minutes: total.minutes * keep };
}

/** A stretch of reading: forward moves without long pauses or jumps. Places are 0 to 1. */
export interface Stretch {
  from: number;
  to: number;
  start: number;
  end: number;
}

/** How much reading a stretch was. */
export const amount = (s: Stretch, size: number) => ({ units: (s.to - s.from) * size, minutes: (s.end - s.start) / 60_000 });

/**
 * Follows the reader to a new place. `read`: they moved there themselves; otherwise the book
 * was opened or jumped there. Returns the stretch going on, and the one that just ended, if any.
 */
export function follow(
  stretch: Stretch | null,
  at: number,
  now: number,
  size: number,
  read: boolean,
): { stretch: Stretch; ended?: Stretch } {
  const fresh = { from: at, to: at, start: now, end: now };
  if (!stretch) return { stretch: fresh };
  const ahead = (at - stretch.to) * size;
  if (!read || now - stretch.end > AWAY || ahead > LEAP || ahead < -1) return { stretch: fresh, ended: stretch };
  return { stretch: { ...stretch, to: Math.max(stretch.to, at), end: now } };
}

/** Minutes left in the chapter (when the book has chapters) and in the book. */
export function timeLeft(at: number, size: number, entries: TocEntry[] | null, perMinute: number) {
  const minutes = (fraction: number) => Math.max(0, fraction * size) / perMinute;
  const top = entries?.length ? Math.min(...entries.map((e) => e.depth)) : 0;
  // A chapter starting less than a unit ahead is the one being read: at its very start, the
  // page's place can fall a hair before the chapter's own.
  const next = entries?.filter((e) => e.depth === top && (e.at - at) * size >= 1).reduce((a, e) => Math.min(a, e.at), 1);
  return { chapter: entries?.length ? minutes((next ?? 1) - at) : undefined, book: minutes(1 - at) };
}

/** "12 min", "1 h 20 min", "4 h". */
export function duration(minutes: number): string {
  if (minutes < 1) return "less than a minute";
  if (minutes < 59.5) return `${Math.round(minutes)} min`;
  if (minutes < 180) {
    const total = Math.round(minutes / 5) * 5;
    const [h, m] = [Math.floor(total / 60), total % 60];
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  return `${Math.round(minutes / 60)} h`;
}

/** The footer's line: "12 min left in chapter · 4 h in book". */
export function timeLeftLine(left: { chapter?: number; book: number }): string {
  const line =
    left.chapter === undefined
      ? `${duration(left.book)} left in book`
      : `${duration(left.chapter)} left in chapter · ${duration(left.book)} in book`;
  return line[0]!.toUpperCase() + line.slice(1);
}
