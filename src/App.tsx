import { useCallback, useEffect, useState } from "react";
import { api, message, onChanged, onStatus, type Book, type Status } from "./api";
import { Library } from "./Library";
import { Reader } from "./Reader";

export function App() {
  const [books, setBooks] = useState<Book[]>([]);
  const [open, setOpen] = useState<{ book: Book; at?: string }>();
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState<string>();
  const [, tick] = useState(0);

  const refresh = useCallback(() => {
    api.books().then(setBooks, (e) => setError(message(e)));
  }, []);
  const refreshStatus = useCallback(() => {
    api.status().then(setStatus, () => {});
  }, []);

  useEffect(() => {
    refresh();
    refreshStatus();
    const unlisten = [onChanged(refresh), onStatus(refreshStatus)];
    // Keeps "Synced 2 min ago" honest.
    const clock = setInterval(() => tick((n) => n + 1), 30_000);
    return () => {
      clearInterval(clock);
      unlisten.forEach((u) => void u.then((f) => f()));
    };
  }, [refresh, refreshStatus]);

  // Picking the other device back up should show its latest page right away.
  useEffect(() => {
    const visibility = () => void api.foreground(document.visibilityState === "visible");
    const focus = () => void api.foreground(true);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", focus);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", focus);
    };
  }, []);

  // Android's back button walks history, so the reader is a history entry.
  useEffect(() => {
    // Backing out of a panel inside the reader lands on the reader's own entry: stay there.
    const back = () => setOpen((current) => (history.state?.book ? current : undefined));
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);

  const openBook = (book: Book, at?: string) => {
    // Opened from a panel (the library's highlights): the book takes the panel's place.
    if (history.state?.panel) history.replaceState({ book: book.id }, "");
    else history.pushState({ book: book.id }, "");
    setOpen({ book, at });
  };
  const close = useCallback(() => {
    if (history.state?.book) history.back();
    else setOpen(undefined);
    refresh();
  }, [refresh]);

  if (open) return <Reader key={open.book.id} book={open.book} at={open.at} onClose={close} />;
  return (
    <>
      {error && <p className="m-4 text-sm text-destructive">{error}</p>}
      <Library books={books} status={status} onStatus={setStatus} onOpen={openBook} onChanged={refresh} />
    </>
  );
}
