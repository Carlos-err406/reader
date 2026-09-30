import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, message } from "./api";

/** What happened: installed (desktop restarts), the installer opened, or Android needs permission first. */
export type InstallResult = "installing" | "permission" | void;

export interface Offer {
  version: string;
  notes: string;
  install: (progress: (fraction: number) => void) => Promise<InstallResult>;
}

/** Android: Reader downloads and checks the APK itself, then opens Android's installer. */
async function installApk(progress: (fraction: number) => void): Promise<InstallResult> {
  const { addPluginListener } = await import("@tauri-apps/api/core");
  const listener = await addPluginListener<{ fraction: number }>("app-update", "progress", (e) => progress(e.fraction));
  try {
    return await api.installUpdate();
  } finally {
    void listener.unregister();
  }
}

const DISMISSED = "reader:update-dismissed";
const EVERY = 6 * 60 * 60 * 1000;

/** Desktop installs signed updates in place; Android verifies the new APK and opens its installer. */
export async function findUpdate(platform: "desktop" | "android"): Promise<Offer | null> {
  if (platform === "android") {
    const apk = await api.checkApkUpdate();
    return apk && { version: apk.version, notes: apk.notes, install: installApk };
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
  const [note, setNote] = useState<string>();

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
    setNote(undefined);
    setProgress(0);
    try {
      const result = await offer.install(setProgress);
      setProgress(undefined);
      if (result === "permission") setNote("Allow Reader to install updates, then come back and tap Install again.");
      if (result === "installing") setNote("Confirm in Android's installer. Your library stays.");
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
            (installing
              ? `Downloading… ${Math.round((progress ?? 0) * 100)}%`
              : (note ?? (platform === "android" ? "Downloads, checks and installs. Your library stays." : "Installs and restarts. Your library stays.")))}
        </span>
      </div>
      <Button size="sm" className="rounded-full" disabled={installing} onClick={install}>
        <Download />
        {platform === "android" ? "Install" : "Install and restart"}
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Not now" onClick={dismiss} disabled={installing}>
        <X />
      </Button>
    </div>
  );
}
