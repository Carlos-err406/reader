import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { Check, Download, LoaderCircle, Pause, Play, X } from "lucide-react";
import { Panel } from "@/components/Panel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { message } from "./api";
import type { Sentence } from "./sentences";
import { languageOf, loadAloud, RATES, saveAloud, speaker, voiceFor, type AloudSettings, type How, type Voice } from "./speech";
import type { ViewerHandle } from "./viewer";

export type AloudState = "off" | "starting" | "playing" | "paused";

interface Events {
  /** A sentence began: the reader is listening, so the screen stays on. */
  onSentence: () => void;
  onError: (problem: string) => void;
}

/**
 * Reads the book aloud from the top of the page, a sentence at a time, marking each and turning
 * pages to follow. A chapter (EPUB) or page (PDF) is queued at once; the next is fetched when it
 * ends. Pausing stops the voice and keeps the place; playing goes on from the same sentence.
 */
export function useReadAloud(viewer: RefObject<ViewerHandle | null>, events: Events) {
  const [state, setState] = useState<AloudState>("off");
  const [settings, setSettings] = useState<AloudSettings>(loadAloud);
  const [lang, setLang] = useState<string | null>(null);
  const passage = useRef<Sentence[]>([]);
  const index = useRef(0);
  // Bumped on every stop, pause or restart, so work from before is dropped.
  const run = useRef(0);
  const latest = useRef({ settings, lang, events });
  latest.current.events = events;

  const how = (): How => {
    const { settings, lang } = latest.current;
    return { voice: settings.voices[lang ? languageOf(lang) : ""], lang: lang ?? undefined, rate: settings.rate };
  };

  const stop = () => {
    run.current++;
    speaker?.stop();
    viewer.current?.speak(null);
    passage.current = [];
    setState("off");
  };

  const speakFrom = (from: number) => {
    const list = passage.current;
    const mine = run.current;
    index.current = from;
    speaker?.speak(
      list.slice(from).map((s) => s.text),
      how(),
      (i) => {
        index.current = from + i;
        viewer.current?.speak(list[from + i]!.location);
        latest.current.events.onSentence();
      },
      () => void onward(mine),
      (problem) => {
        if (mine !== run.current) return;
        stop();
        latest.current.events.onError(problem);
      },
    );
  };

  // The chapter or page is done: on to the next one with anything to read, or the end.
  const onward = async (mine: number) => {
    const last = passage.current[passage.current.length - 1];
    const next = last ? await viewer.current?.sentences(last.location).catch(() => null) : null;
    if (mine !== run.current) return;
    if (!next) return stop();
    passage.current = next;
    speakFrom(0);
  };

  const start = async () => {
    const v = viewer.current;
    if (!speaker || !v) return;
    const mine = ++run.current;
    setState("starting");
    latest.current.lang = v.language();
    setLang(latest.current.lang);
    const list = await v.sentences().catch(() => null);
    if (mine !== run.current) return;
    if (!list?.length) {
      setState("off");
      latest.current.events.onError("There's nothing to read aloud from here.");
      return;
    }
    passage.current = list;
    setState("playing");
    speakFrom(0);
  };

  const pause = () => {
    run.current++;
    speaker?.stop();
    setState("paused");
  };

  const resume = () => {
    run.current++;
    setState("playing");
    speakFrom(index.current);
  };

  const change = (patch: Partial<AloudSettings>) => {
    const next = { ...latest.current.settings, ...patch };
    latest.current.settings = next;
    setSettings(next);
    saveAloud(next);
    // Heard straight away: the sentence being read starts again in the new voice or speed.
    if (state === "playing") resume();
  };

  // Leaving the book stops the voice.
  useEffect(
    () => () => {
      run.current++;
      speaker?.stop();
    },
    [],
  );

  return {
    available: !!speaker,
    state,
    lang,
    rate: settings.rate,
    voice: settings.voices[lang ? languageOf(lang) : ""],
    start,
    stop,
    toggle: () => (state === "playing" ? pause() : state === "paused" ? resume() : undefined),
    /** The next speed, round to the slowest after the fastest. */
    faster: () => change({ rate: RATES[(RATES.indexOf(settings.rate as (typeof RATES)[number]) + 1) % RATES.length]! }),
    /** A voice for the book's language, or undefined for the system's choice. */
    setVoice: (id: string | undefined) => {
      const voices = { ...latest.current.settings.voices };
      const key = lang ? languageOf(lang) : "";
      if (id) voices[key] = id;
      else delete voices[key];
      change({ voices });
    },
  };
}

export type ReadAloud = ReturnType<typeof useReadAloud>;

const rateLabel = (rate: number) => `${rate}×`;

/** The controls while reading aloud: play or pause, speed, voice and stop. */
export function ReadAloudBar({
  aloud,
  onVoices,
  className,
  style,
}: {
  aloud: ReadAloud;
  onVoices: () => void;
  className?: string;
  style?: CSSProperties;
}) {
  if (aloud.state === "off") return null;
  const playing = aloud.state === "playing";
  return (
    <div
      role="toolbar"
      aria-label="Read aloud"
      className={cn("flex items-center gap-1 rounded-full border bg-card/95 p-1 shadow-lg backdrop-blur", className)}
      style={style}
    >
      <Button
        size="icon"
        className="rounded-full"
        onClick={aloud.toggle}
        disabled={aloud.state === "starting"}
        aria-label={playing ? "Pause reading aloud" : "Go on reading aloud"}
      >
        {aloud.state === "starting" ? <LoaderCircle className="animate-spin" /> : playing ? <Pause /> : <Play />}
      </Button>
      <Button variant="ghost" size="sm" className="w-14 rounded-full tabular-nums" onClick={aloud.faster} aria-label={`Speed ${rateLabel(aloud.rate)}`}>
        {rateLabel(aloud.rate)}
      </Button>
      <Button variant="ghost" size="sm" className="rounded-full" onClick={onVoices} aria-haspopup="dialog">
        Voice
      </Button>
      <Button variant="ghost" size="icon" className="rounded-full" onClick={aloud.stop} aria-label="Stop reading aloud">
        <X />
      </Button>
    </div>
  );
}

const languageName = (tag: string) => {
  try {
    return new Intl.DisplayNames(undefined, { type: "language" }).of(tag.replace("_", "-")) ?? tag;
  } catch {
    return tag;
  }
};

/** Picks the voice for the book's language. The system's own choice stays the default. */
export function VoicesSheet({ open, onOpenChange, aloud }: { open: boolean; onOpenChange: (open: boolean) => void; aloud: ReadAloud }) {
  const [voices, setVoices] = useState<Voice[]>();
  const [problem, setProblem] = useState<string>();
  useEffect(() => {
    if (!open || !speaker) return;
    speaker.voices().then(setVoices, (e) => setProblem(message(e)));
  }, [open]);
  const lang = aloud.lang;
  // The book's language first; the rest by language, each in the order the system gives (on
  // Android, the best and offline ones first).
  const theirs = lang ? (voices ?? []).filter((v) => languageOf(v.lang) === languageOf(lang)) : [];
  const others = (voices ?? []).filter((v) => !theirs.includes(v)).sort((a, b) => languageName(a.lang).localeCompare(languageName(b.lang)));
  const install = speaker?.installVoices;
  const automatic = lang && voices ? voiceFor(voices, lang) : undefined;
  const row = (selected: boolean) =>
    cn(
      "flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring",
      selected && "font-semibold",
    );
  const pick = (id: string | undefined) => {
    aloud.setVoice(id);
    onOpenChange(false);
  };
  const item = (v: Voice) => (
    <li key={v.id}>
      <button type="button" role="radio" aria-checked={aloud.voice === v.id} className={row(aloud.voice === v.id)} onClick={() => pick(v.id)}>
        <span className="grid size-4 place-items-center">{aloud.voice === v.id && <Check className="size-4 text-primary" />}</span>
        <span className="min-w-0 flex-1 truncate">{v.name}</span>
        <span className="text-xs text-muted-foreground">{v.lang}</span>
      </button>
    </li>
  );
  return (
    <Panel open={open} onOpenChange={onOpenChange} title="Voice" description="Voices come from this device; how they sound varies.">
      {problem && <p className="text-sm text-destructive">{problem}</p>}
      {!voices && !problem && <p className="text-sm text-muted-foreground">Looking for voices…</p>}
      {voices && voices.length === 0 && <p className="text-sm text-muted-foreground">This device has no voices installed.</p>}
      {voices && lang && !theirs.length && (
        <p className="text-sm text-muted-foreground">
          This device has no {languageName(lang)} voice, so this book is read with whatever voice the system finds for it.
        </p>
      )}
      {voices && install && (
        <Button variant="outline" className="justify-self-start" onClick={() => install().catch((e) => setProblem(message(e)))}>
          <Download />
          Get more voices
        </Button>
      )}
      {voices && voices.length > 0 && (
        <div role="radiogroup" aria-label="Voices" className="-mx-2 grid gap-3">
          <ul className="grid gap-0.5">
            <li>
              <button type="button" role="radio" aria-checked={!aloud.voice} className={row(!aloud.voice)} onClick={() => pick(undefined)}>
                <span className="grid size-4 place-items-center">{!aloud.voice && <Check className="size-4 text-primary" />}</span>
                <span className="min-w-0 flex-1 truncate">Automatic</span>
                <span className="truncate text-xs text-muted-foreground">{automatic?.name ?? "The system's voice"}</span>
              </button>
            </li>
            {theirs.map(item)}
          </ul>
          {others.length > 0 && (
            <section className="grid gap-0.5">
              <h3 className="px-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {theirs.length ? "Other languages" : "Voices"}
              </h3>
              <ul className="grid gap-0.5">{others.map(item)}</ul>
            </section>
          )}
        </div>
      )}
    </Panel>
  );
}
