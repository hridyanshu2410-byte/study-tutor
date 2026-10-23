// The tutor's voice. With OPENAI_API_KEY set on the server, /api/voice reads
// the line in a warm, natural voice; otherwise (or if it fails) the browser's
// own speech is used, which needs no keys. Listening is always the browser's,
// hands-free: it hears the student out and hands over each finished thought.

let serverVoice: boolean | null = null; // null until the first try
let audio: HTMLAudioElement | null = null;
let generation = 0;

// onStart fires when the voice is actually heard, so the tutor's pen can move with it.
export function speak(text: string, onEnd?: () => void, onStart?: () => void) {
  if (typeof window === "undefined" || !text) {
    onStart?.();
    onEnd?.();
    return;
  }
  stopSpeaking();
  const mine = ++generation;
  if (serverVoice === false) return speakInBrowser(text, onEnd, onStart);
  fetch("/api/voice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) })
    .then(async (res) => {
      if (res.status === 404) serverVoice = false;
      if (!res.ok) throw new Error(`voice ${res.status}`);
      serverVoice = true;
      const url = URL.createObjectURL(await res.blob());
      if (mine !== generation) return URL.revokeObjectURL(url); // interrupted while loading
      audio = new Audio(url);
      const done = () => {
        URL.revokeObjectURL(url);
        if (mine === generation) onEnd?.();
      };
      audio.onended = done;
      audio.onerror = done;
      audio.onplaying = () => mine === generation && onStart?.();
      await audio.play();
    })
    .catch(() => {
      if (mine === generation) speakInBrowser(text, onEnd, onStart);
    });
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
  generation++;
  if (audio) {
    audio.onended = audio.onerror = null;
    audio.pause();
    audio = null;
  }
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
const END_OF_TURN_MS = 1100;

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
