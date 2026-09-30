import { useEffect, useState } from "react";
import { Panel } from "@/components/Panel";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { GoogleLogo } from "@/components/Logos";
import { cn } from "@/lib/utils";
import { api, message, type Status } from "./api";
import { ago, countdown, plural, statusLine, type Tone } from "./format";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: Status;
  onStatus: (status: Status) => void;
}

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

const toneStyle: Record<Tone, string> = {
  off: "bg-muted",
  ok: "bg-ok/12",
  busy: "bg-primary/12",
  warn: "bg-warn/15",
  error: "bg-destructive/12",
};

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-2 border-b py-2.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  );
}

export function SyncPanel({ open, onOpenChange, status, onStatus }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(Date.now());

  // Retry countdowns and "2 min ago" stay current while the panel is open.
  useEffect(() => {
    if (!open) return;
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, [open]);

  const run = async (action: () => Promise<Status>) => {
    setBusy(true);
    setError(undefined);
    try {
      onStatus(await action());
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const { google, library } = status;
  const line = statusLine(status, now);
  const signingIn = google.connecting || (busy && !google.connected);
  const problem = error ?? (status.error ? null : google.error);

  let detail: string;
  if (!status.enabled) {
    detail = google.connected
      ? "Changes stay on this device until you resume."
      : "Keep your books, reading position and bookmarks in step across your devices.";
  } else if (status.syncing) {
    detail = status.activity ?? "Working…";
  } else if (status.offline) {
    detail = "Your changes are saved on this device and will sync when the connection returns.";
  } else if (status.error) {
    detail = status.error;
  } else if (status.pending) {
    detail = "Your latest changes will upload in a moment.";
  } else {
    detail = status.lastSync ? "Checks for changes every 30 s and when you open Reader." : "Starting…";
  }
  const headline = line.tone === "ok" && status.lastSync ? "Up to date" : line.text;

  return (
    <Panel open={open} onOpenChange={onOpenChange} title="Sync" description="Google Drive sync status and controls">
      <div className={cn("flex items-start gap-3 rounded-lg p-4", toneStyle[line.tone])}>
        <span className={cn("dot mt-1.5", line.tone)} />
        <div className="grid gap-1 text-sm">
          <strong className="text-base">{headline}</strong>
          <p>{detail}</p>
          {status.enabled && status.error && status.retryAt && (
            <p className="text-muted-foreground">Trying again in {countdown(status.retryAt, now)}.</p>
          )}
        </div>
      </div>

      {!google.configured ? (
        <p className="text-sm text-muted-foreground">
          Google sign-in isn't set up in this build. Add a Desktop OAuth client as <code>google-client.json</code> (see{" "}
          <code>docs/google-setup.md</code>).
        </p>
      ) : !status.enabled ? (
        <div className="grid gap-2">
          <Button
            size="lg"
            variant="outline"
            className="bg-card"
            disabled={busy || google.connecting}
            onClick={() => run(api.enableSync)}
          >
            <GoogleLogo />
            {signingIn
              ? status.platform === "desktop"
                ? "Finish signing in in your browser…"
                : "Signing in…"
              : google.connected
                ? "Resume sync"
                : "Turn on sync with Google Drive"}
          </Button>
          {!google.connected && (
            <p className="text-xs text-muted-foreground">
              Reader only sees files it creates in your Drive. Libraries on both devices are combined.
            </p>
          )}
        </div>
      ) : (
        <div className="flex gap-2">
          <Button size="lg" className="flex-1" disabled={busy || status.syncing} onClick={() => run(api.syncNow)}>
            {status.error ? "Retry now" : "Sync now"}
          </Button>
          <Button size="lg" variant="outline" className="flex-1" disabled={busy} onClick={() => run(api.pauseSync)}>
            Pause
          </Button>
        </div>
      )}

      {problem && <p className="text-sm text-destructive">{problem}</p>}

      {(status.enabled || google.connected) && (
        <dl className="border-t">
          <Fact label="Account">
            <span className="flex min-w-0 items-center gap-2">
              <GoogleLogo size={16} />
              <span className="min-w-0 break-words">{status.account ?? (google.connected ? "Google Drive" : "Not connected")}</span>
            </span>
          </Fact>
          <Fact label="Library">
            {plural(library.books, "book")} · {plural(library.bookmarks, "bookmark")} · reading positions
            {library.localBooks < library.books && (
              <span className="block text-xs text-muted-foreground">
                {plural(library.books - library.localBooks, "book")} still downloading to this device
              </span>
            )}
          </Fact>
          {status.lastSync && (
            <Fact label="Last sync">
              {time(status.lastSync)} ({ago(status.lastSync, now)})
            </Fact>
          )}
          <Fact label="This device">
            {status.platform === "android" ? "Syncs while Reader is open" : "Syncs in the background"}
          </Fact>
        </dl>
      )}

      {google.connected && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/35 p-4">
          <div className="grid gap-0.5">
            <strong className="text-sm">Disconnect Google account</strong>
            <p className="text-xs text-muted-foreground">
              Stops syncing. Books stay on this device and your Drive files are kept.
            </p>
          </div>
          <ConfirmDialog
            title="Disconnect Google account?"
            description="Sync stops on this device. Your books stay here, and the files already in your Drive are kept."
            confirm="Disconnect"
            onConfirm={() => void run(api.disconnect)}
            trigger={
              <Button variant="outline" className="shrink-0 border-destructive/45 text-destructive" disabled={busy}>
                Disconnect
              </Button>
            }
          />
        </div>
      )}
    </Panel>
  );
}
