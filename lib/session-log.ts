// The session recorder: everything that happens on the page, on one clock.
//
// A session file holds every student, tutor and human-tutor stroke with the
// time of each point, every spoken phrase with its start and end, each
// trigger, model call and interruption, and where the view was. Times are
// milliseconds from the start of the session (performance.now() based, so
// they never jump when the wall clock does); `startedAt` gives the wall time.
// A replay rebuilds the page at any moment from this file alone.
//
// This file is pure: no DOM, so it can be tested and read by scripts.

import type { Manners } from "./manners.ts";

export const FORMAT = "coink-session";
export const VERSION = 1;

export type Who = "student" | "tutor" | "human_tutor";

// A point with the time it was drawn, relative to the stroke's start.
export type TimedPoint = [x: number, y: number, pressure: number, dt: number];
// A tutor pen stroke as planned: its points and when along the phrase the pen draws it.
export type PlannedStroke = { points: [number, number][]; start: number; end: number; w?: number };
type B = { x: number; y: number; w: number; h: number };

export type LogEvent =
  // The page as it stood when recording began (a saved page reopened).
  | { t: number; type: "snapshot"; strokes: { id: string; color: string; size: number; kind?: string; pts: TimedPoint[] }[]; tutorInk: { id: string; strokes: PlannedStroke[] }[] }
  // A stroke someone drew; `t` is pen down, `end` pen up.
  | { t: number; type: "stroke"; who: Who; id: string; color: string; size: number; kind?: string; pts: TimedPoint[]; end: number }
  // Ink taken off the page.
  | { t: number; type: "erase"; who: Who; ids: string[]; how: "eraser" | "scribble" | "undo" | "clear" | "page" | "tap" }
  // Ink put back (undo of an erase); it reappears as it was.
  | { t: number; type: "restore"; who: Who; ids: string[] }
  // One phrase's worth of AI tutor ink; `t` is when the pen started, strokes are timed from there.
  | { t: number; type: "tutor_ink"; id: string; turn: number; beat: number; strokes: PlannedStroke[]; duration: number; marks?: B[]; rules?: B[]; atOnce?: boolean }
  // Something that starts a tutor turn.
  | { t: number; type: "trigger"; turn: number; trigger: string; speech?: string | null; focus?: { line_id: string; token: number | null } | null }
  // The request to the model, and what came back when.
  | { t: number; type: "model_call"; turn: number; trigger: string; lines: number }
  | { t: number; type: "model_beat"; turn: number; beat: number; say: string; ink: string[] }
  | { t: number; type: "model_end"; turn: number; move: string; beats: number; ms: number }
  | { t: number; type: "model_error"; turn: number; error: string }
  // A turn that came back but was not performed, and why.
  | { t: number; type: "turn_dropped"; turn: number; why: string }
  // A spoken phrase. For the AI tutor `beat` is its place in the turn; `voice` says if it was heard aloud.
  | { t: number; type: "speech"; who: Who; text: string; end: number | null; turn?: number; beat?: number; voice?: "audio" | "silent"; aside?: boolean }
  // The tutor was cut off while it spoke or thought.
  | { t: number; type: "interrupt"; by: string; turn: number | null; beat: number | null; during: "speaking" | "thinking" }
  // The student double-tapped to point.
  | { t: number; type: "point"; x: number; y: number }
  // Where the student's view was (sampled while it moves).
  | { t: number; type: "view"; x: number; y: number; z: number; w: number; h: number }
  // A recording of someone's microphone, kept as a separate file, starting at `t`.
  | { t: number; type: "audio"; who: Who; file: string; mime: string; end?: number | null }
  // The tutor pen room: opened, a tutor joined or left.
  | { t: number; type: "room"; what: "open" | "joined" | "clock" | "left" | "closed"; code: string; name?: string; offsetMs?: number; rttMs?: number }
  // The problem text changed, or a free note (a researcher's mark in the replay is kind "mark").
  | { t: number; type: "note"; text: string; kind?: string }
  // The learner's ratings and answers after a block of a solo session.
  | { t: number; type: "survey"; ratings: Record<string, number>; answers: Record<string, string> };

export type SessionFile = {
  format: typeof FORMAT;
  version: number;
  id: string;
  startedAt: number;
  savedAt: number;
  // the AI tutor, or a person through the tutor pen
  tutor: "ai" | "human";
  manners: Manners;
  // In a solo session of several blocks, which block this file is.
  block?: { n: number; of: number; label: string } | null;
  problem: string;
  app: { userAgent?: string; participant?: string | null; condition?: string | null };
  duration: number;
  events: LogEvent[];
};

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

// Point times for a stroke whose points were replaced wholesale (a ruled
// shape, a snapped line): spread evenly between pen down and pen up.
export function timePoints(points: [number, number, number?][], times: number[], start: number, end: number): TimedPoint[] {
  const even = times.length !== points.length;
  return points.map((p, i) => {
    const at = even ? start + ((end - start) * i) / Math.max(1, points.length - 1) : times[i];
    return [r1(p[0]), r1(p[1]), r2(p[2] ?? 0.5), Math.max(0, Math.round(at - start))];
  });
}

export type Clock = () => number;

export class SessionLog {
  readonly id: string;
  readonly startedAt: number;
  readonly events: LogEvent[] = [];
  manners: Manners;
  tutor: "ai" | "human" = "ai";
  block: SessionFile["block"] = null;
  problem = "";
  app: SessionFile["app"] = {};
  private origin: number;
  private live = new Map<string, number[]>();
  private turnNo = 0;
  private lastView: { x: number; y: number; z: number; at: number } | null = null;
  // Called after each new event, e.g. to save soon.
  onChange: (() => void) | null = null;

  private clock: Clock;

  constructor(id: string, manners: Manners, clock: Clock, wallNow = Date.now()) {
    this.clock = clock;
    this.id = id;
    this.manners = manners;
    this.origin = clock();
    this.startedAt = wallNow;
  }

  // Session time now, or of a performance.now() timestamp.
  now(at?: number): number {
    return Math.max(0, Math.round((at ?? this.clock()) - this.origin));
  }

  push<E extends LogEvent>(e: E): E {
    this.events.push(e);
    this.onChange?.();
    return e;
  }

  nextTurn(): number {
    return ++this.turnNo;
  }

  snapshot(strokes: { id: string; color: string; size: number; kind?: string; points: [number, number, number][] }[], tutorInk: { id: string; strokes: PlannedStroke[] }[]) {
    if (!strokes.length && !tutorInk.length) return;
    this.push({
      t: this.now(),
      type: "snapshot",
      strokes: strokes.map((s) => ({ id: s.id, color: s.color, size: s.size, ...(s.kind ? { kind: s.kind } : {}), pts: timePoints(s.points, [], 0, 0) })),
      tutorInk: tutorInk.map((t) => ({ id: t.id, strokes: t.strokes.map(roundStroke) })),
    });
  }

  // A stroke in progress: pen down, each point, pen up.
  strokeBegin(id: string, at?: number) {
    this.live.set(id, [at ?? this.clock()]);
  }
  strokePoint(id: string, at?: number) {
    this.live.get(id)?.push(at ?? this.clock());
  }
  strokeEnd(who: Who, s: { id: string; color: string; size: number; kind?: string; points: [number, number, number][] }, at?: number) {
    const times = this.live.get(s.id);
    this.live.delete(s.id);
    const end = at ?? this.clock();
    const start = times?.[0] ?? end;
    this.push({
      t: this.now(start),
      type: "stroke",
      who,
      id: s.id,
      color: s.color,
      size: s.size,
      ...(s.kind ? { kind: s.kind } : {}),
      pts: timePoints(s.points, times ?? [], start, end),
      end: this.now(end),
    });
  }
  // A whole stroke whose times are already in session time (from the tutor pen).
  strokeTimed(who: Who, s: { id: string; color: string; size: number; kind?: string }, pts: TimedPoint[], t: number, end: number) {
    this.push({ t, type: "stroke", who, id: s.id, color: s.color, size: s.size, ...(s.kind ? { kind: s.kind } : {}), pts, end });
  }
  dropLive(id: string) {
    this.live.delete(id);
  }

  erase(who: Who, ids: string[], how: Extract<LogEvent, { type: "erase" }>["how"]) {
    if (ids.length) this.push({ t: this.now(), type: "erase", who, ids, how });
  }

  // The student's view, at most four times a second and only when it moved.
  view(cam: { x: number; y: number; z: number }, w: number, h: number) {
    const now = this.clock();
    const v = this.lastView;
    if (v && now - v.at < 250) return;
    if (v && Math.abs(v.x - cam.x) < 2 && Math.abs(v.y - cam.y) < 2 && Math.abs(v.z - cam.z) < 0.01) return;
    this.lastView = { ...cam, at: now };
    this.push({ t: this.now(now), type: "view", x: r1(cam.x), y: r1(cam.y), z: r2(cam.z), w: Math.round(w), h: Math.round(h) });
  }

  toFile(savedAt = Date.now()): SessionFile {
    const last = this.events.reduce((m, e) => Math.max(m, e.t, "end" in e && typeof e.end === "number" ? e.end : 0), 0);
    return {
      format: FORMAT,
      version: VERSION,
      id: this.id,
      startedAt: this.startedAt,
      savedAt,
      tutor: this.tutor,
      manners: this.manners,
      block: this.block,
      problem: this.problem,
      app: this.app,
      duration: Math.max(last, this.now()),
      events: this.events,
    };
  }
}

export function roundStroke(s: PlannedStroke): PlannedStroke {
  return { points: s.points.map(([x, y]) => [r1(x), r1(y)]), start: Math.round(s.start), end: Math.round(s.end), ...(s.w ? { w: r2(s.w) } : {}) };
}

export function isSessionFile(v: unknown): v is SessionFile {
  const f = v as SessionFile | null;
  return Boolean(f && f.format === FORMAT && Array.isArray(f.events) && typeof f.startedAt === "number");
}

// ---------- reading a session back ----------

// What is on the page at session time `t`. Strokes appear point by point as
// they were drawn; tutor ink as its pen plan reaches each stroke; erased ink
// goes when it was erased.
export type PageAt = {
  strokes: { id: string; who: Who; color: string; size: number; kind?: string; points: [number, number, number][]; drawing: boolean }[];
  tutorInk: { id: string; strokes: { points: [number, number][]; w?: number; done: boolean }[]; marks?: B[]; rules?: B[]; sweep: number }[];
  speaking: { who: Who; text: string }[];
  view: { x: number; y: number; z: number; w: number; h: number } | null;
};

export function pageAt(file: SessionFile, t: number): PageAt {
  type S = PageAt["strokes"][number];
  type I = PageAt["tutorInk"][number];
  // everything drawn so far, by id, and what is on the page now (in drawing order)
  const seen = new Map<string, { kind: "s"; v: S } | { kind: "i"; v: I }>();
  const shown = new Map<string, { kind: "s"; v: S } | { kind: "i"; v: I }>();
  const out: PageAt = { strokes: [], tutorInk: [], speaking: [], view: null };
  const put = (id: string, x: { kind: "s"; v: S } | { kind: "i"; v: I }) => {
    seen.set(id, x);
    shown.delete(id);
    shown.set(id, x);
  };
  const events = [...file.events].sort((a, b) => a.t - b.t);
  for (const e of events) {
    if (e.t > t) break;
    if (e.type === "snapshot") {
      for (const s of e.strokes) put(s.id, { kind: "s", v: { id: s.id, who: "student", color: s.color, size: s.size, kind: s.kind, points: s.pts.map(([x, y, p]) => [x, y, p]), drawing: false } });
      for (const ink of e.tutorInk) put(ink.id, { kind: "i", v: { id: ink.id, strokes: ink.strokes.map((s) => ({ points: s.points, w: s.w, done: true })), sweep: 1 } });
    } else if (e.type === "stroke") {
      const into = t - e.t;
      const points = e.pts.filter((p) => p[3] <= into).map(([x, y, p]) => [x, y, p] as [number, number, number]);
      if (points.length) put(e.id, { kind: "s", v: { id: e.id, who: e.who, color: e.color, size: e.size, kind: e.kind, points, drawing: t < e.end } });
    } else if (e.type === "tutor_ink") {
      const into = t - e.t;
      const strokes = e.strokes.flatMap((s) => {
        const pts = strokeUpTo(s, into);
        return pts ? [{ points: pts, w: s.w, done: into >= s.end }] : [];
      });
      put(e.id, { kind: "i", v: { id: e.id, strokes, marks: e.marks, rules: e.rules, sweep: Math.min(1, Math.max(0, into / 500)) } });
    } else if (e.type === "erase") e.ids.forEach((id) => shown.delete(id));
    else if (e.type === "restore") {
      for (const id of e.ids) {
        const x = seen.get(id);
        if (x) shown.set(id, x);
      }
    } else if (e.type === "speech") {
      if (e.end == null ? t - e.t < 8000 : t <= e.end) out.speaking.push({ who: e.who, text: e.text });
    } else if (e.type === "view") out.view = { x: e.x, y: e.y, z: e.z, w: e.w, h: e.h };
  }
  for (const x of shown.values()) {
    if (x.kind === "s") out.strokes.push(x.v);
    else out.tutorInk.push(x.v);
  }
  return out;
}

// How much of a planned stroke the pen has drawn `t` ms into its phrase.
export function strokeUpTo(s: PlannedStroke, t: number): [number, number][] | null {
  if (t <= s.start && s.end > s.start) return null;
  if (t >= s.end) return s.points;
  const f = (t - s.start) / (s.end - s.start);
  const e = f * f * (3 - 2 * f);
  return s.points.slice(0, Math.max(2, Math.ceil(s.points.length * e)));
}

// The extent of all ink in a session, for fitting it in view.
export function inkBounds(file: SessionFile): B | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  };
  for (const e of file.events) {
    if (e.type === "stroke") e.pts.forEach((p) => add(p[0], p[1]));
    else if (e.type === "tutor_ink") e.strokes.forEach((s) => s.points.forEach((p) => add(p[0], p[1])));
    else if (e.type === "snapshot") {
      e.strokes.forEach((s) => s.pts.forEach((p) => add(p[0], p[1])));
      e.tutorInk.forEach((i) => i.strokes.forEach((s) => s.points.forEach((p) => add(p[0], p[1]))));
    }
  }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// One row per event, for a spreadsheet or R. Point lists are summarised, not dumped.
export function eventsCsv(file: SessionFile): string {
  const cols = ["session", "t_ms", "end_ms", "type", "who", "turn", "beat", "text", "detail"];
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = file.events.map((e) => {
    const any = e as Record<string, unknown>;
    let text = "";
    let detail = "";
    switch (e.type) {
      case "stroke":
        detail = `${e.pts.length} points${e.kind ? `, ${e.kind}` : ""}, ${e.color}`;
        break;
      case "tutor_ink":
        detail = `${e.strokes.length} strokes over ${Math.round(e.duration)} ms${e.atOnce ? ", all at once" : ""}`;
        break;
      case "erase":
        detail = `${e.how}: ${e.ids.length}`;
        break;
      case "trigger":
        text = e.speech ?? "";
        detail = e.trigger + (e.focus ? ` at ${e.focus.line_id}${e.focus.token != null ? `#${e.focus.token}` : ""}` : "");
        break;
      case "model_beat":
        text = e.say;
        detail = e.ink.join("; ");
        break;
      case "model_end":
        detail = `${e.move}, ${e.beats} beats, ${e.ms} ms`;
        break;
      case "model_error":
        detail = e.error;
        break;
      case "turn_dropped":
        detail = e.why;
        break;
      case "speech":
        text = e.text;
        detail = [e.voice, e.aside ? "aside" : ""].filter(Boolean).join(", ");
        break;
      case "interrupt":
        detail = `${e.by} while ${e.during}`;
        break;
      case "point":
        detail = `${Math.round(e.x)},${Math.round(e.y)}`;
        break;
      case "view":
        detail = `${e.x},${e.y} @${e.z}`;
        break;
      case "audio":
        detail = e.file;
        break;
      case "room":
        detail = `${e.what} ${e.code}${e.name ? ` (${e.name})` : ""}${e.offsetMs != null ? `, clock offset ${e.offsetMs} ms, rtt ${e.rttMs} ms` : ""}`;
        break;
      case "note":
        text = e.text;
        detail = e.kind ?? "";
        break;
      case "restore":
        detail = `${e.ids.length}`;
        break;
      case "survey":
        text = Object.entries(e.answers).map(([k, v]) => `${k}: ${v}`).join(" | ");
        detail = Object.entries(e.ratings).map(([k, v]) => `${k}=${v}`).join("; ");
        break;
      case "snapshot":
        detail = `${e.strokes.length} strokes, ${e.tutorInk.length} tutor inks`;
        break;
      case "model_call":
        detail = `${e.trigger}, ${e.lines} lines`;
        break;
    }
    return [file.id, e.t, any.end ?? "", e.type, any.who ?? "", any.turn ?? "", any.beat ?? "", text, detail].map(esc).join(",");
  });
  return [cols.join(","), ...rows].join("\n") + "\n";
}
