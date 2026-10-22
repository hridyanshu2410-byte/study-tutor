// The tutor's voice. With OPENAI_API_KEY set on the server, /api/voice reads
// the line in a warm, natural voice; otherwise (or if it fails) the browser's
// own speech is used, which needs no keys. Listening is always the browser's.

let serverVoice: boolean | null = null; // null until the first try
let audio: HTMLAudioElement | null = null;
let generation = 0;

export function speak(text: string, onEnd?: () => void) {
  if (typeof window === "undefined" || !text) {
    onEnd?.();
    return;
  }
  stopSpeaking();
  const mine = ++generation;
  if (serverVoice === false) return speakInBrowser(text, onEnd);
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
      await audio.play();
    })
    .catch(() => {
      if (mine === generation) speakInBrowser(text, onEnd);
    });
}

function speakInBrowser(text: string, onEnd?: () => void) {
  if (!("speechSynthesis" in window)) {
    onEnd?.();
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.97;
  utterance.pitch = 1;
  const voice = pickVoice();
  if (voice) utterance.voice = voice;
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
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
};

export function speechInputSupported(): boolean {
  return typeof window !== "undefined" && ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);
}

// Push-to-talk: call the returned function to stop listening early.
export function listen(onText: (text: string) => void, onDone: () => void): () => void {
  const w = window as unknown as Record<string, new () => Recognition>;
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Ctor) {
    onDone();
    return () => {};
  }
  const rec = new Ctor();
  rec.lang = "en-US";
  rec.interimResults = false;
  rec.continuous = false;
  let heard = "";
  rec.onresult = (e) => {
    heard = Array.from(e.results)
      .map((r) => r[0].transcript)
      .join(" ")
      .trim();
  };
  rec.onend = () => {
    if (heard) onText(heard);
    onDone();
  };
  rec.onerror = () => onDone();
  rec.start();
  return () => rec.stop();
}
