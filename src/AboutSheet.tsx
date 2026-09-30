import { useEffect, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Bug, CircleCheck, Download, ExternalLink, History, LoaderCircle, RefreshCw, Scale } from "lucide-react";
import { Panel } from "@/components/Panel";
import { GitHubLogo } from "@/components/Logos";
import { Button } from "@/components/ui/button";
import icon from "@/assets/reader-icon.png";
import { api, message } from "./api";
import { findUpdate, type Offer } from "./UpdateBanner";

const REPO = "https://github.com/Carlos-err406/reader";

/** Every project Reader ships inside the app, with its license. */
const CREDITS: { name: string; what: string; license: string; href: string }[] = [
  { name: "Tauri", what: "App runtime", license: "MIT / Apache-2.0", href: "https://github.com/tauri-apps/tauri" },
  { name: "PDF.js", what: "PDF rendering", license: "Apache-2.0", href: "https://github.com/mozilla/pdf.js" },
  { name: "epub.js", what: "EPUB rendering", license: "BSD-2-Clause", href: "https://github.com/futurepress/epub.js" },
  { name: "React", what: "Interface", license: "MIT", href: "https://github.com/react/react" },
  { name: "Radix UI", what: "Accessible components", license: "MIT", href: "https://github.com/radix-ui/primitives" },
  { name: "shadcn/ui", what: "Component styles", license: "MIT", href: "https://github.com/shadcn-ui/ui" },
  { name: "Tailwind CSS", what: "Styling", license: "MIT", href: "https://github.com/tailwindlabs/tailwindcss" },
  { name: "Lucide", what: "Icons", license: "ISC", href: "https://github.com/lucide-icons/lucide" },
  { name: "Literata", what: "Reading font", license: "OFL-1.1", href: "https://github.com/googlefonts/literata" },
  {
    name: "Atkinson Hyperlegible",
    what: "Reading font, by the Braille Institute",
    license: "OFL-1.1",
    href: "https://github.com/googlefonts/atkinson-hyperlegible",
  },
  { name: "SQLite, rusqlite", what: "Library storage", license: "Public domain / MIT", href: "https://github.com/rusqlite/rusqlite" },
];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  platform: "desktop" | "android";
}

type Check =
  | { state: "idle" | "checking" | "current" }
  | { state: "installing"; progress: number }
  | { state: "available"; offer: Offer; note?: string }
  | { state: "error"; text: string };

function LinkRow({ href, icon, children }: { href: string; icon: ReactNode; children: ReactNode }) {
  return (
    <li>
      <a
        href={href}
        className="flex items-center gap-3 rounded-md px-2 py-2.5 text-sm transition-colors outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring"
        onClick={(e) => {
          e.preventDefault();
          void api.openLink(href).catch(() => {});
        }}
      >
        <span className="grid size-5 place-items-center text-muted-foreground">{icon}</span>
        <span className="flex-1">{children}</span>
        <ExternalLink className="size-3.5 text-muted-foreground" aria-hidden="true" />
      </a>
    </li>
  );
}

export function AboutSheet({ open, onOpenChange, platform }: Props) {
  const [version, setVersion] = useState<string>();
  const [check, setCheck] = useState<Check>({ state: "idle" });

  useEffect(() => {
    if (open) getVersion().then(setVersion, () => {});
  }, [open]);

  const checkNow = async () => {
    setCheck({ state: "checking" });
    try {
      const offer = await findUpdate(platform);
      setCheck(offer ? { state: "available", offer } : { state: "current" });
    } catch (e) {
      setCheck({ state: "error", text: message(e) });
    }
  };
  const install = async (offer: Offer) => {
    setCheck({ state: "installing", progress: 0 });
    try {
      const result = await offer.install((progress) => setCheck({ state: "installing", progress }));
      if (result === "permission")
        setCheck({ state: "available", offer, note: "Allow Reader to install updates, then tap Install again." });
      else if (result === "installing") setCheck({ state: "available", offer, note: "Confirm in Android's installer." });
    } catch (e) {
      setCheck({ state: "error", text: message(e) });
    }
  };

  return (
    <Panel open={open} onOpenChange={onOpenChange} title="About" description="Version, license, credits and source code">
      <div className="flex items-center gap-4">
        <img src={icon} alt="" width={64} height={64} className="size-16 shrink-0" />
        <div className="grid gap-0.5">
          <strong className="font-serif text-2xl">Reader</strong>
          <span className="text-sm text-muted-foreground">Version {version ?? "…"}</span>
          <span className="text-sm">A PDF and EPUB reader that keeps your place across your devices.</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-lg bg-muted p-3">
        <div className="min-w-40 flex-1 text-sm" role="status">
          {check.state === "idle" && "Updates are checked automatically."}
          {check.state === "checking" && "Checking for updates…"}
          {check.state === "current" && (
            <span className="flex items-center gap-1.5">
              <CircleCheck className="size-4 text-ok" /> You're up to date.
            </span>
          )}
          {check.state === "available" && (check.note ?? `Reader ${check.offer.version} is available.`)}
          {check.state === "installing" && `Downloading… ${Math.round(check.progress * 100)}%`}
          {check.state === "error" && <span className="text-destructive">{check.text}</span>}
        </div>
        {check.state === "available" ? (
          <Button size="sm" className="rounded-full" onClick={() => void install(check.offer)}>
            <Download />
            {platform === "android" ? "Install" : "Install and restart"}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="rounded-full"
            disabled={check.state === "checking" || check.state === "installing"}
            onClick={() => void checkNow()}
          >
            {check.state === "checking" || check.state === "installing" ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <RefreshCw />
            )}
            Check for updates
          </Button>
        )}
      </div>

      <ul className="-mx-2 grid">
        <LinkRow href={REPO} icon={<GitHubLogo size={16} />}>
          Source code
        </LinkRow>
        <LinkRow href={`${REPO}/releases`} icon={<History className="size-4" />}>
          Releases and changes
        </LinkRow>
        <LinkRow href={`${REPO}/issues`} icon={<Bug className="size-4" />}>
          Report a problem
        </LinkRow>
        <LinkRow href={`${REPO}/blob/main/LICENSE`} icon={<Scale className="size-4" />}>
          MIT License
        </LinkRow>
      </ul>

      <section className="grid gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Credits</h3>
        <p className="text-sm text-muted-foreground">Reader is built on these open-source projects:</p>
        <ul className="grid border-t">
          {CREDITS.map((c) => (
            <li key={c.name} className="border-b">
              <a
                href={c.href}
                className="flex items-baseline gap-2 py-2 text-sm outline-none hover:underline focus-visible:underline"
                onClick={(e) => {
                  e.preventDefault();
                  void api.openLink(c.href).catch(() => {});
                }}
              >
                <span className="font-medium">{c.name}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{c.what}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{c.license}</span>
              </a>
            </li>
          ))}
        </ul>
        <ul className="-mx-2 grid">
          <LinkRow href={`${REPO}/blob/main/THIRD-PARTY-NOTICES.md`} icon={<Scale className="size-4" />}>
            Full third-party notices
          </LinkRow>
        </ul>
        <p className="text-xs text-muted-foreground">
          Google, Google Drive and the Google logo are trademarks of Google LLC. GitHub and its logo are trademarks of
          GitHub, Inc.
        </p>
      </section>

      <p className="text-center text-xs text-muted-foreground">© 2026 Carlos Daniel Vilaseca Illnait</p>
    </Panel>
  );
}
