// The tutor's voice. With OPENAI_API_KEY set on the server, /api/voice reads
// the line in a warm, natural voice; otherwise (or if it fails) the browser's
// own speech is used, which needs no keys. Listening is always the browser's,
// hands-free: it hears the student out and hands over each finished thought.

let serverVoice: boolean | null = null; // null until the first try

// A phrase of the tutor's voice, fetched as soon as the phrase is known so it
// is ready to play the moment the phrase before it ends.
export type Clip = {
  // Speaks once the audio is ready. onStart fires when the voice is actually
  // heard, with the clip's length in ms when the browser knows it.
  play(onStart: (ms: number | null) => void, onEnd: () => void): void;
  stop(): void;
};

const clips = new Set<Clip>();

// Voices of short lines fetched once ahead of time, so they can be said at once.
const kept = new Map<string, Blob>();
const keeping = new Set<string>();

export function keepClips(texts: string[]) {
  if (typeof window === "undefined" || serverVoice === false) return;
  for (const text of texts) {
    if (kept.has(text) || keeping.has(text)) continue;
    keeping.add(text);
    fetch("/api/voice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) })
      .then(async (res) => {
        if (res.status === 404) serverVoice = false;
        if (res.ok) kept.set(text, await res.blob());
      })
      .catch(() => {})
      .finally(() => keeping.delete(text));
  }
}

// A line's voice: at once if it was kept, otherwise fetched now.
export const keptClip = (text: string): Clip => prepareClip(text, kept.get(text));

export function prepareClip(text: string, audio?: Blob): Clip {
  let stopped = false;
  let el: HTMLAudioElement | null = null;
  let url: string | null = null;
  let failed = typeof window === "undefined" || !text.trim() || (serverVoice === false && !audio);
  let asked: { onStart: (ms: number | null) => void; onEnd: () => void } | null = null;
  let heard = false;
  let inBrowser = false;
  const fetching = new AbortController();

  const release = () => {
    if (url) URL.revokeObjectURL(url);
    url = null;
    clips.delete(clip);
  };
  const fallback = () => {
    if (stopped || !asked) return;
    const { onStart, onEnd } = asked;
    inBrowser = true;
    speakInBrowser(text, () => {
      release();
      if (!stopped) onEnd();
    }, () => !stopped && onStart(null));
  };
  // Plays once the clip has been asked for and the audio (or its failure) is in.
  const go = () => {
    if (stopped || !asked) return;
    if (failed) return fallback();
    if (!el) return;
    const audio = el;
    const { onStart, onEnd } = asked;
    audio.onplaying = () => {
      if (stopped || heard) return;
      heard = true;
      onStart(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration * 1000 : null);
    };
    audio.onended = () => {
      release();
      if (!stopped) onEnd();
    };
    audio.onerror = () => {
      if (stopped) return;
      if (heard) {
        release();
        onEnd();
      } else fallback();
    };
    audio.play().catch(() => !heard && fallback());
  };

  if (!failed && audio) {
    url = URL.createObjectURL(audio);
    el = new Audio(url);
    el.preload = "auto";
  } else if (!failed) {
    fetch("/api/voice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), signal: fetching.signal })
      .then(async (res) => {
        if (res.status === 404) serverVoice = false;
        if (!res.ok) throw new Error(`voice ${res.status}`);
        serverVoice = true;
        if (stopped) return void res.body?.cancel();
        // Play the voice as it arrives rather than after the whole clip has downloaded.
        const made = streamable(res, () => stopped) ?? (await whole(res));
        if (stopped) return URL.revokeObjectURL(made.url);
        el = made.el;
        url = made.url;
        el.preload = "auto";
        go();
      })
      .catch(() => {
        failed = true;
        go();
      });
  }

  const clip: Clip = {
    play(onStart, onEnd) {
      asked = { onStart, onEnd };
      go();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      fetching.abort();
      if (el) {
        el.onplaying = el.onended = el.onerror = null;
        el.pause();
      }
      if (inBrowser && typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
      release();
    },
  };
  clips.add(clip);
  return clip;
}

// Says a line now. onStart fires when the voice is actually heard, so the tutor's pen can move with it.
export function speak(text: string, onEnd?: () => void, onStart?: () => void) {
  stopSpeaking();
  prepareClip(text).play(
    () => onStart?.(),
    () => onEnd?.(),
  );
}

// Streams the MP3 into the audio element through MediaSource, where the browser supports it.
function streamable(res: Response, stopped: () => boolean): { el: HTMLAudioElement; url: string } | null {
  if (!res.body || typeof MediaSource === "undefined" || !MediaSource.isTypeSupported("audio/mpeg")) return null;
  const source = new MediaSource();
  const url = URL.createObjectURL(source);
  const reader = res.body.getReader();
  source.addEventListener(
    "sourceopen",
    async () => {
      const buf = source.addSourceBuffer("audio/mpeg");
      const settled = () => new Promise((r) => buf.addEventListener("updateend", r, { once: true }));
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (stopped()) return void reader.cancel();
          buf.appendBuffer(value);
          await settled();
        }
        if (source.readyState === "open") source.endOfStream();
      } catch {
        if (source.readyState === "open") source.endOfStream("network");
      }
    },
    { once: true },
  );
  return { el: new Audio(url), url };
}

async function whole(res: Response): Promise<{ el: HTMLAudioElement; url: string }> {
  const url = URL.createObjectURL(await res.blob());
  return { el: new Audio(url), url };
}

function speakInBrowser(text: string, onEnd?: () => void, onStart?: () => void) {
  if (!("speechSynthesis" in window)) {
    onStart?.();
    onEnd?.();
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.97;
  utterance.pitch = 1;
  const voice = pickVoice();
  if (voice) utterance.voice = voice;
  utterance.onstart = () => onStart?.();
  utterance.onend = () => onEnd?.();
  utterance.onerror = () => onEnd?.();
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking() {
  for (const c of [...clips]) c.stop();
  if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
}

// Prefers the natural-sounding voices most platforms ship.
function pickVoice(): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
  const preferred = ["Samantha", "Ava", "Google UK English Female", "Microsoft Aria", "Microsoft Jenny", "Karen", "Daniel"];
  for (const name of preferred) {
    const match = voices.find((v) => v.name.includes(name));
    if (match) return match;
  }
  return voices.find((v) => v.localService) ?? voices[0];
}

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

export function speechInputSupported(): boolean {
  return typeof window !== "undefined" && ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);
}

// How long the student can go quiet mid-thought before we treat it as their turn ending.
const END_OF_TURN_MS = 900;

export type ConversationEvents = {
  // A finished thought, ready for the tutor.
  onUtterance: (text: string) => void;
  // True while the student is mid-sentence, so the tutor doesn't talk over them.
  onHearing: (hearing: boolean) => void;
  // The microphone was refused or is unavailable.
  onBlocked: (reason: string) => void;
};

// An always-on ear. The browser ends recognition on its own every so often,
// so it quietly restarts until stopped. While the tutor talks it is paused,
// so the tutor never hears itself through the speakers.
export class Conversation {
  private rec: Recognition | null = null;
  private wanted = false;
  private paused = false;
  private heard = "";
  private interim = "";
  private quiet: ReturnType<typeof setTimeout> | null = null;
  private restarts = 0;
  // Results already handed over; the browser may still finalize one of them later.
  private consumed = 0;
  private seen = 0;

  constructor(private events: ConversationEvents) {}

  get active() {
    return this.wanted;
  }

  start() {
    this.wanted = true;
    this.paused = false;
    this.restarts = 0;
    this.open();
  }

  stop() {
    this.wanted = false;
    this.close();
  }

  pause() {
    if (!this.wanted || this.paused) return;
    this.paused = true;
    this.close();
  }

  resume() {
    if (!this.wanted || !this.paused) return;
    this.paused = false;
    this.open();
  }

  private open() {
    if (this.rec || typeof window === "undefined") return;
    const w = window as unknown as Record<string, new () => Recognition>;
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return this.events.onBlocked("This browser can't listen. Try Chrome or Edge.");
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = true;
    rec.onresult = (e) => {
      this.restarts = 0;
      let interim = "";
      this.seen = e.results.length;
      for (let i = Math.max(e.resultIndex, this.consumed); i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) this.heard = `${this.heard} ${r[0].transcript}`.trim();
        else interim += r[0].transcript;
      }
      this.interim = interim.trim();
      this.events.onHearing(Boolean(this.interim || this.heard));
      this.waitForEnd();
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        this.wanted = false;
        this.events.onBlocked("The microphone is blocked. Allow it in the address bar to talk to me.");
      }
    };
    rec.onend = () => {
      this.rec = null;
      this.consumed = this.seen = 0;
      // Keep what was said before the browser cut off.
      if (this.interim) this.heard = `${this.heard} ${this.interim}`.trim();
      this.interim = "";
      if (this.heard) this.finish();
      if (this.wanted && !this.paused && this.restarts++ < 50) setTimeout(() => this.open(), 150);
    };
    this.rec = rec;
    this.consumed = this.seen = 0;
    try {
      rec.start();
    } catch {
      this.rec = null;
    }
  }

  private close() {
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = null;
    this.heard = "";
    this.interim = "";
    this.events.onHearing(false);
    const rec = this.rec;
    this.rec = null;
    if (rec) {
      rec.onend = null;
      rec.onresult = null;
      rec.abort();
    }
  }

  private waitForEnd() {
    if (this.quiet) clearTimeout(this.quiet);
    // Wait longer while words are still forming than after a phrase has settled.
    this.quiet = setTimeout(() => this.finish(), this.interim ? END_OF_TURN_MS * 1.8 : END_OF_TURN_MS);
  }

  private finish() {
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = null;
    const text = `${this.heard} ${this.interim}`.trim();
    this.consumed = this.seen;
    this.heard = "";
    this.interim = "";
    this.events.onHearing(false);
    if (text) this.events.onUtterance(text);
  }
}
