"use client";

// The student's side of the tutor pen room. It shares the page live with the
// human tutor's device, takes the tutor's strokes and words, answers clock
// pings so both devices log on one clock, and answers the voice call.
// Everything the tutor does is written into the session log here, with the
// tutor's own timings mapped onto the student's session clock.

import type { Stroke } from "./ink";
import type { PlainStroke, RoomMessage } from "./room-clock";
import type { Recorder } from "./session-recorder";
import type { TimedPoint } from "./session-log";
import { joinRoom, VoiceCall, type RoomLink } from "./tutor-room";

type Opts = {
  code: string;
  recorder: Recorder;
  recordVoice: boolean;
  // the human tutor's ink on this page, shared with the canvas
  guestInk: Map<string, Stroke>;
  page: () => { strokes: PlainStroke[]; tutor: PlainStroke[]; guest: PlainStroke[]; problem: string };
  sessionId: () => string;
  onInk: (id: string | null) => void;
  onState: (s: { status: string; guest: string | null; call: string | null; offsetMs: number | null }) => void;
  onSaid: (text: string) => void;
};

const plain = (s: Stroke): PlainStroke => ({ id: s.id, color: s.color, size: s.size, ...(s.kind ? { kind: s.kind } : {}), points: s.points.map(([x, y, p]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(p * 100) / 100]) });

export class HostRoom {
  private link: RoomLink | null = null;
  private call: VoiceCall | null = null;
  private mic: MediaStream | null = null;
  private live = new Map<string, { t0: number; pts: TimedPoint[] }>();
  private sentPts = new Map<string, number>();
  private lastSend = 0;
  private lastView = 0;
  private voiceSaved: (() => void) | null = null;
  private state = { status: "connecting", guest: null as string | null, call: null as string | null, offsetMs: null as number | null };

  constructor(private o: Opts) {}

  get code() {
    return this.o.code;
  }

  async open(): Promise<void> {
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      this.mic = null; // ink still works; the call needs the mic
    }
    if (this.mic && this.o.recordVoice) await this.o.recorder.startVoice(this.mic).catch(() => undefined);
    this.link = joinRoom(this.o.code, "host", {
      onMessage: (m) => void this.handle(m),
      onStatus: (s) => this.set({ status: s }),
    });
    const log = this.o.recorder.log;
    if (log) {
      log.tutor = "human";
      log.push({ t: log.now(), type: "room", what: "open", code: this.o.code });
    }
  }

  private set(p: Partial<HostRoom["state"]>) {
    this.state = { ...this.state, ...p };
    this.o.onState(this.state);
  }

  private send(m: RoomMessage) {
    this.link?.send(m);
  }

  sendPage() {
    this.send({ k: "page", ...this.o.page() });
  }

  private async handle(m: RoomMessage) {
    const log = this.o.recorder.log;
    switch (m.k) {
      case "hello":
        this.set({ guest: m.name || "Tutor" });
        log?.push({ t: log.now(), type: "room", what: "joined", code: this.o.code, name: m.name });
        this.send({ k: "welcome", session: this.o.sessionId(), recordVoice: this.o.recordVoice });
        this.sendPage();
        break;
      case "ping":
        this.send({ k: "pong", a: m.a, b: performance.now() });
        break;
      case "clock":
        this.set({ offsetMs: Math.round(m.offset) });
        log?.push({ t: log.now(), type: "room", what: "clock", code: this.o.code, offsetMs: Math.round(m.offset), rttMs: Math.round(m.rtt) });
        break;
      case "ink": {
        let s = this.o.guestInk.get(m.id);
        if (!s) {
          s = { id: m.id, color: m.color, size: m.size, createdAt: Date.now(), points: [] };
          this.o.guestInk.set(m.id, s);
        }
        const rec = this.live.get(m.id) ?? { t0: m.pts[0]?.[3] ?? performance.now(), pts: [] };
        this.live.set(m.id, rec);
        for (const [x, y, p, t] of m.pts) {
          s.points.push([x, y, p]);
          rec.pts.push([x, y, p, Math.max(0, Math.round(t - rec.t0))]);
        }
        if (m.done) {
          this.live.delete(m.id);
          if (log && rec.pts.length) log.strokeTimed("human_tutor", s, rec.pts, log.now(rec.t0), log.now(rec.t0 + (rec.pts.at(-1)?.[3] ?? 0)));
        }
        this.o.onInk(m.id);
        break;
      }
      case "rub":
        for (const id of m.ids) this.o.guestInk.delete(id);
        log?.erase("human_tutor", m.ids, "eraser");
        this.o.onInk(null);
        break;
      case "said":
        log?.push({ t: log.now(m.t), type: "speech", who: "human_tutor", text: m.text, end: log.now(m.end) });
        this.o.onSaid(m.text);
        break;
      case "voice":
        if (log) {
          const prev = log.events.find((e) => e.type === "audio" && e.who === "human_tutor" && e.end == null);
          if (m.file && prev && prev.type === "audio") {
            prev.file = m.file;
            prev.end = log.now();
          }
          if (m.file) this.voiceSaved?.(); else if (!m.file) log.push({ t: log.now(m.t), type: "audio", who: "human_tutor", file: "human_tutor (on the tutor's device)", mime: m.mime, end: null });
        }
        break;
      case "rtc":
        if (!this.mic) break;
        this.call ??= new VoiceCall("host", (x) => this.send(x), this.mic);
        this.call.onState = (c) => this.set({ call: c });
        await this.call.handle(m);
        break;
      case "bye":
        this.set({ guest: null, call: null });
        log?.push({ t: log.now(), type: "room", what: "left", code: this.o.code });
        this.call?.hangUp();
        this.call = null;
        break;
    }
  }

  // The student's stroke as it is drawn: new points about ten times a second, all of it at the end.
  studentStroke(s: Stroke, done: boolean) {
    if (!this.link) return;
    const now = performance.now();
    if (!done && now - this.lastSend < 100) return;
    this.lastSend = now;
    const { points, ...meta } = plain(s);
    const from = this.sentPts.get(s.id) ?? 0;
    const whole = done || s.kind === "shape" || from === 0;
    if (done) this.sentPts.delete(s.id);
    else this.sentPts.set(s.id, points.length);
    this.send({ k: "s_ink", ...meta, pts: whole ? points : points.slice(from), done, full: whole });
  }

  erased(ids: string[]) {
    if (ids.length) this.send({ k: "s_rub", ids });
  }

  view(cam: { x: number; y: number; z: number }, w: number, h: number) {
    const now = performance.now();
    if (now - this.lastView < 250) return;
    this.lastView = now;
    this.send({ k: "view", x: Math.round(cam.x), y: Math.round(cam.y), z: Math.round(cam.z * 100) / 100, w: Math.round(w), h: Math.round(h) });
  }

  async close(): Promise<void> {
    // the tutor's device says where it saved their voice before it leaves (a few seconds at most)
    const told = this.state.guest ? new Promise<void>((r) => (this.voiceSaved = r)) : Promise.resolve();
    this.send({ k: "end" });
    await Promise.race([told, new Promise((r) => setTimeout(r, 4000))]);
    const log = this.o.recorder.log;
    log?.push({ t: log.now(), type: "room", what: "closed", code: this.o.code });
    this.call?.hangUp();
    this.call = null;
    // give the last message a moment to leave
    await new Promise((r) => setTimeout(r, 300));
    this.link?.close();
    this.link = null;
    if (this.o.recordVoice) await this.o.recorder.stopVoice();
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
  }
}

export { plain as plainStroke };
