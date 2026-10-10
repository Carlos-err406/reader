import { Channel } from "@tauri-apps/api/core";
import { api, message } from "./api";

/**
 * The system's voices. Desktop webviews speak themselves (`speechSynthesis`); Android's WebView
 * can't, so there the phone's text-to-speech engine speaks, through SpeechPlugin.kt.
 */
export interface Voice {
  id: string;
  name: string;
  /** BCP 47, such as "en-US". */
  lang: string;
}

export interface How {
  /** A voice's id; otherwise one for `lang`, or the system's own. */
  voice?: string;
  lang?: string;
  /** 1 is the voice's normal speed. */
  rate: number;
}

export interface Speaker {
  voices(): Promise<Voice[]>;
  /**
   * Speaks the texts one after another: `onStart(i)` as each begins, `onEnd` once the last is
   * done. Speaking again, or `stop`, cancels what's left and silences the callbacks.
   */
  speak(texts: string[], how: How, onStart: (index: number) => void, onEnd: () => void, onError: (problem: string) => void): void;
  stop(): void;
  /** Opens the system's screen for adding voices, where there is one. */
  installVoices?: () => Promise<void>;
}

const android = /android/i.test(navigator.userAgent);

/** Same language: "es", "es-MX" and "es_ES" all match "es-ES" loosely, the region exactly. */
export const languageOf = (tag: string) => tag.replace("_", "-").split("-")[0]!.toLowerCase();

/** A voice for the language: one for its region if there is, the system's default first. */
export function voiceFor<V extends { lang: string }>(voices: V[], lang: string | undefined, isDefault = (_: V) => false): V | undefined {
  if (!lang) return undefined;
  const want = lang.replace("_", "-").toLowerCase();
  const same = voices.filter((v) => languageOf(v.lang) === languageOf(want));
  const rank = (v: V) => (v.lang.replace("_", "-").toLowerCase() === want ? 2 : 0) + (isDefault(v) ? 1 : 0);
  return same.sort((a, b) => rank(b) - rank(a))[0];
}

function web(): Speaker | null {
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (!synth || typeof SpeechSynthesisUtterance === "undefined") return null;
  let generation = 0;
  // Utterances are kept until spoken: some engines drop the events of ones no longer referenced.
  let queued: SpeechSynthesisUtterance[] = [];
  const list = () =>
    new Promise<SpeechSynthesisVoice[]>((done) => {
      const now = synth.getVoices();
      if (now.length) return done(now);
      // Voices arrive a moment after the page loads.
      const late = setTimeout(() => done(synth.getVoices()), 1500);
      synth.addEventListener(
        "voiceschanged",
        () => {
          clearTimeout(late);
          done(synth.getVoices());
        },
        { once: true },
      );
    });
  return {
    voices: async () => (await list()).map((v) => ({ id: v.voiceURI, name: v.name, lang: v.lang })),
    speak: (texts, how, onStart, onEnd, onError) => {
      const mine = ++generation;
      synth.cancel();
      void list().then((voices) => {
        if (mine !== generation) return;
        const voice = voices.find((v) => v.voiceURI === how.voice) ?? voiceFor(voices, how.lang, (v) => v.default);
        queued = texts.map((text, i) => {
          const u = new SpeechSynthesisUtterance(text);
          if (voice) u.voice = voice;
          u.lang = voice?.lang ?? how.lang ?? "";
          u.rate = how.rate;
          u.onstart = () => mine === generation && onStart(i);
          u.onend = () => mine === generation && i === texts.length - 1 && onEnd();
          u.onerror = (e) => mine === generation && e.error !== "interrupted" && e.error !== "canceled" && onError(e.error);
          return u;
        });
        queued.forEach((u) => synth.speak(u));
      });
    },
    stop: () => {
      generation++;
      queued = [];
      synth.cancel();
    },
  };
}

function phone(): Speaker {
  let generation = 0;
  return {
    voices: () => api.speechVoices(),
    speak: (texts, how, onStart, onEnd, onError) => {
      const mine = ++generation;
      // Each text is the utterance `<generation>:<index>`, so events from before are told apart.
      const events = new Channel<{ start?: string; done?: string; error?: string }>((e) => {
        const id = e.start ?? e.done ?? e.error ?? "";
        const [of, index] = id.split(":").map(Number);
        if (of !== mine || mine !== generation || index === undefined || Number.isNaN(index)) return;
        if (e.start !== undefined) onStart(index);
        else if (e.done !== undefined) index === texts.length - 1 && onEnd();
        else onError("The voice couldn't read this sentence");
      });
      api
        .speechSpeak(texts, { utterance: mine, voice: how.voice ?? null, lang: how.lang ?? null, rate: how.rate }, events)
        .catch((e) => mine === generation && onError(message(e)));
    },
    stop: () => {
      generation++;
      void api.speechStop().catch(() => {});
    },
    installVoices: () => api.speechInstallVoices(),
  };
}

/** Null where there's no way to speak. */
export const speaker: Speaker | null = android ? phone() : web();

export const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export interface AloudSettings {
  rate: number;
  /** The voice picked for each language (by its primary tag; "" for books that don't say). */
  voices: Record<string, string>;
}

const KEY = "reader:read-aloud";

/** Per device, like the display settings: each device has its own voices. */
export function loadAloud(): AloudSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<AloudSettings> | null;
    const rate = RATES.find((r) => r === saved?.rate) ?? 1;
    const voices = saved?.voices && typeof saved.voices === "object" ? saved.voices : {};
    return { rate, voices: Object.fromEntries(Object.entries(voices).filter(([, v]) => typeof v === "string")) };
  } catch {
    return { rate: 1, voices: {} };
  }
}

export function saveAloud(settings: AloudSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {}
}
