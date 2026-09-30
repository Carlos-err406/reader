import { useCallback, useEffect, useState } from "react";
import { api, message, onChanged, onStatus, type Book, type Status } from "./api";
import { Library } from "./Library";
import { Reader } from "./Reader";

export function App() {
  const [books, setBooks] = useState<Book[]>([]);
  const [open, setOpen] = useState<Book>();
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
    const back = () => setOpen(undefined);
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);

  const openBook = (book: Book) => {
    history.pushState({ book: book.id }, "");
    setOpen(book);
  };
  const close = useCallback(() => {
    if (history.state?.book) history.back();
    else setOpen(undefined);
    refresh();
  }, [refresh]);

  if (open) return <Reader key={open.id} book={open} onClose={close} />;
  return (
    <>
      {error && <p className="m-4 text-sm text-destructive">{error}</p>}
      <Library books={books} status={status} onStatus={setStatus} onOpen={openBook} onChanged={refresh} />
    </>
  );
}
