import type { Position, Status } from "./api";

export function titleFromFileName(name: string): string {
  return (
    name
      .replace(/\.(pdf|epub)$/i, "")
      .replace(/[_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "Untitled"
  );
}

export function pdfPosition(page: number, pages: number): Position {
  return {
    location: String(page),
    label: `Page ${page} of ${pages}`,
    fraction: pages > 0 ? page / pages : 0,
  };
}

/** A stored PDF location, clamped to the document. */
export function pdfPage(location: string | undefined, pages: number): number {
  const page = Number.parseInt(location ?? "", 10);
  return Number.isFinite(page) ? Math.min(Math.max(page, 1), Math.max(pages, 1)) : 1;
}

export function epubLabel(fraction: number, chapter: string | undefined): string {
  const percent = `${Math.round(fraction * 100)}%`;
  const title = chapter?.trim();
  return title ? `${title} · ${percent}` : percent;
}

/** `compact` fits the phone header: "2m ago" rather than "2 min ago". */
export function ago(time: number, now = Date.now(), compact = false): string {
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return compact ? `${minutes}m ago` : `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return compact ? `${hours}h ago` : `${hours} h ago`;
  return new Date(time).toLocaleDateString();
}

/** A day for labels: "today", "yesterday", "28 Sep", or with the year if it isn't this one. */
export function day(time: number, now = Date.now()): string {
  const start = (t: number) => new Date(t).setHours(0, 0, 0, 0);
  const days = Math.round((start(now) - start(time)) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  const sameYear = new Date(time).getFullYear() === new Date(now).getFullYear();
  return new Date(time).toLocaleDateString(undefined, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}

export type Tone = "off" | "ok" | "busy" | "warn" | "error";

/** A short phrase for the header chip, plus the colour of its dot. */
export function statusLine(status: Status, now = Date.now()): { text: string; tone: Tone } {
  if (!status.enabled) return { text: status.google.connected ? "Sync paused" : "Sync off", tone: "off" };
  if (status.syncing) return { text: "Syncing…", tone: "busy" };
  if (status.offline) return { text: "Offline", tone: "warn" };
  if (status.error) return { text: "Sync problem", tone: "error" };
  if (status.pending) return { text: "Changes waiting", tone: "busy" };
  return { text: status.lastSync ? `Synced ${ago(status.lastSync, now, true)}` : "Waiting for first sync", tone: "ok" };
}

export function countdown(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.ceil((at - now) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.ceil(minutes / 60)} h`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** For matching text: ignores case and accents, so "codigo" finds "Código". */
export const fold = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
