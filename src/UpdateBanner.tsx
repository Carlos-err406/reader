import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, message } from "./api";

export interface Offer {
  version: string;
  notes: string;
  install: (progress: (fraction: number) => void) => Promise<void>;
}

const DISMISSED = "reader:update-dismissed";
const EVERY = 6 * 60 * 60 * 1000;

/** Desktop installs signed updates in place; Android hands the new APK to the system. */
export async function findUpdate(platform: "desktop" | "android"): Promise<Offer | null> {
  if (platform === "android") {
    const apk = await api.checkApkUpdate();
    return apk && { version: apk.version, notes: apk.notes, install: () => api.openApk(apk.url) };
  }
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) return null;
  return {
    version: update.version,
    notes: update.body ?? "",
    install: async (progress) => {
      let total = 0;
      let received = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        if (event.event === "Progress") received += event.data.chunkLength;
        if (total) progress(received / total);
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    },
  };
}

export function UpdateBanner({ platform }: { platform: "desktop" | "android" }) {
  const [offer, setOffer] = useState<Offer>();
  const [progress, setProgress] = useState<number>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    const look = () =>
      findUpdate(platform).then(
        (found) => {
          let dismissed: string | null = null;
          try {
            dismissed = localStorage.getItem(DISMISSED);
          } catch {}
          if (live && found && found.version !== dismissed) setOffer(found);
        },
        // Offline or rate-limited: try again at the next check.
        () => {},
      );
    const first = setTimeout(look, 4000);
    const later = setInterval(look, EVERY);
    return () => {
      live = false;
      clearTimeout(first);
      clearInterval(later);
    };
  }, [platform]);

  if (!offer) return null;
  const installing = progress !== undefined;
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED, offer.version);
    } catch {}
    setOffer(undefined);
  };
  const install = async () => {
    setError(undefined);
    setProgress(0);
    try {
      await offer.install(setProgress);
      if (platform === "android") setProgress(undefined);
    } catch (e) {
      setProgress(undefined);
      setError(message(e));
    }
  };

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border bg-card p-3 pl-4" role="status">
      <div className="min-w-48 flex-1">
        <strong className="block text-sm">Reader {offer.version} is available</strong>
        <span className="text-xs text-muted-foreground">
          {error ??
            (installing && platform === "desktop"
              ? `Downloading… ${Math.round((progress ?? 0) * 100)}%`
              : platform === "android"
                ? "Opens the download; install it when it finishes. Your library stays."
                : "Installs and restarts. Your library stays.")}
        </span>
      </div>
      <Button size="sm" className="rounded-full" disabled={installing} onClick={install}>
        <Download />
        {platform === "android" ? "Download" : "Install and restart"}
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Not now" onClick={dismiss} disabled={installing}>
        <X />
      </Button>
    </div>
  );
}
