// Shared clock and codes for the tutor pen room. Pure, so it can be tested.
//
// The student's device holds the session clock. The tutor's device keeps an
// estimate of the offset between its own performance.now() and that clock,
// from ping and pong pairs: the reply with the shortest round trip gives the
// tightest bound, and the offset assumes the reply was stamped halfway.

export type ClockSample = { offset: number; rtt: number };

export class ClockSync {
  private samples: ClockSample[] = [];

  // `sent` and `received` are on this device's clock, `hostT` on the host's.
  add(sent: number, hostT: number, received: number): ClockSample {
    const rtt = Math.max(0, received - sent);
    const s = { offset: hostT - (sent + rtt / 2), rtt };
    this.samples.push(s);
    if (this.samples.length > 30) this.samples.shift();
    return s;
  }

  get ready() {
    return this.samples.length > 0;
  }

  best(): ClockSample | null {
    return this.samples.reduce<ClockSample | null>((b, s) => (!b || s.rtt < b.rtt ? s : b), null);
  }

  // This device's time on the host's clock.
  toHost(local: number): number {
    return local + (this.best()?.offset ?? 0);
  }
}

// Room codes: eight letters and digits that are hard to misread (about 40 bits).
const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
export function roomCode(random: () => number = Math.random): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += ALPHABET[Math.floor(random() * ALPHABET.length)];
  return s;
}
export const validRoomCode = (s: unknown): s is string => typeof s === "string" && /^[2-9a-z]{8}$/.test(s);

// ---------- what goes between the two devices ----------
export type Pt = [x: number, y: number, p: number, t: number];
export type PlainStroke = { id: string; color: string; size: number; kind?: string; points: [number, number, number][] };

export type RoomMessage =
  // tutor → student
  | { k: "hello"; name: string }
  | { k: "ping"; a: number }
  | { k: "ink"; id: string; color: string; size: number; pts: Pt[]; done: boolean } // a stroke, sent in pieces; times on the host clock
  | { k: "rub"; ids: string[] } // the tutor erased some of its own ink
  | { k: "said"; text: string; t: number; end: number } // the tutor's words, as its device heard them, on the host clock
  | { k: "voice"; t: number; file: string | null; mime: string } // the tutor started (file null) or saved a recording
  | { k: "clock"; offset: number; rtt: number }
  | { k: "bye" }
  // student → tutor
  | { k: "welcome"; session: string; recordVoice: boolean }
  | { k: "pong"; a: number; b: number }
  | { k: "page"; strokes: PlainStroke[]; tutor: PlainStroke[]; guest: PlainStroke[]; problem: string }
  | { k: "s_ink"; id: string; color: string; size: number; kind?: string; pts: [number, number, number][]; done: boolean; full?: boolean } // pieces add points; `full` replaces them
  | { k: "s_rub"; ids: string[] }
  | { k: "view"; x: number; y: number; z: number; w: number; h: number }
  | { k: "end" }
  // either way: setting up the voice call
  | { k: "rtc"; sdp?: { type: "offer" | "answer"; sdp: string }; ice?: unknown };

export type Envelope = { from: "host" | "guest"; m: RoomMessage };
