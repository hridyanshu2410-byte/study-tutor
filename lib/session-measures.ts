// The four counts the DIS paper takes from each recording. Pure, so they can
// be tested and run over a folder of session files by a script.
//
// 1. Where each tutor mark lands relative to the learner's writing.
// 2. Who first wrote each step (each line of writing on the page).
// 3. The time from an error to the tutor's first act. Errors are moments a
//    researcher marked in the replay (notes of kind "error").
// 4. How often the tutor stops when the learner resumes: of the times the
//    learner put pen down or started speaking while the tutor was speaking
//    or writing, how often the tutor fell quiet within a second.
//
// These are proxies, and the file says how each is computed; the paper
// should report them as such.

import { groupLines, type Box, type Stroke } from "./ink.ts";
import type { LogEvent, SessionFile, Who } from "./session-log.ts";

export type Placement = "on" | "beside" | "near" | "apart" | "blank";
export type Mark = { t: number; end: number; who: Who; box: Box; place: Placement; overlap: number };

const STOP_WITHIN_MS = 1000;
const QUIET_FOR_MS = 1500;

type Pts = [number, number][];
type Learner = { id: string; t: number; end: number; pts: Pts };

function boxOf(pts: Pts): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

const gap = (a: Box, b: Box) => Math.hypot(Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w)), Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h)));
const inside = ([x, y]: [number, number], b: Box, pad: number) => x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad;

// Learner strokes, with when they were erased, so we know what was on the page at a moment.
function learnerInk(file: SessionFile): { strokes: Learner[]; erased: Map<string, number> } {
  const strokes: Learner[] = [];
  const erased = new Map<string, number>();
  for (const e of file.events) {
    if (e.type === "snapshot") for (const s of e.strokes) strokes.push({ id: s.id, t: e.t, end: e.t, pts: s.pts.map((p) => [p[0], p[1]]) });
    else if (e.type === "stroke" && e.who === "student" && e.kind !== "highlight") strokes.push({ id: e.id, t: e.t, end: e.end, pts: e.pts.map((p) => [p[0], p[1]]) });
    else if (e.type === "erase") for (const id of e.ids) if (!erased.has(id)) erased.set(id, e.t);
  }
  return { strokes, erased };
}

// The tutor's marks: each phrase of AI ink, and the human tutor's strokes
// gathered into marks (strokes less than 1.2 s and 80 units apart are one mark).
export function tutorMarks(file: SessionFile): { t: number; end: number; who: Who; pts: Pts }[] {
  const marks: { t: number; end: number; who: Who; pts: Pts }[] = [];
  let open: (typeof marks)[number] | null = null;
  const events = [...file.events].sort((a, b) => a.t - b.t);
  for (const e of events) {
    if (e.type === "tutor_ink") {
      const pts = e.strokes.flatMap((s) => s.points);
      if (pts.length) marks.push({ t: e.t, end: e.t + e.duration, who: "tutor", pts });
    } else if (e.type === "stroke" && e.who === "human_tutor") {
      const pts: Pts = e.pts.map((p) => [p[0], p[1]]);
      if (!pts.length) continue;
      if (open && e.t - open.end < 1200 && gap(boxOf(open.pts), boxOf(pts)) < 80) {
        open.pts.push(...pts);
        open.end = e.end;
      } else {
        open = { t: e.t, end: e.end, who: "human_tutor", pts };
        marks.push(open);
      }
    }
  }
  return marks;
}

// 1. Each mark against the learner's lines on the page when the mark began:
// "on" when at least 30% of its points fall on a learner line, "beside" within
// 40 units of one, "near" within 150, "apart" further, "blank" if the learner
// had written nothing.
export function markPlacements(file: SessionFile): Mark[] {
  const { strokes, erased } = learnerInk(file);
  return tutorMarks(file).map((m) => {
    const present = strokes.filter((s) => s.end <= m.t && (erased.get(s.id) ?? Infinity) > m.t);
    const box = boxOf(m.pts);
    if (!present.length) return { t: m.t, end: m.end, who: m.who, box, place: "blank" as const, overlap: 0 };
    const lines = groupLines(present.map((s): Stroke => ({ id: s.id, color: "", size: 4, createdAt: 0, points: s.pts.map(([x, y]) => [x, y, 0.5]) })));
    const on = m.pts.filter((p) => lines.some((l) => inside(p, l.box, 4))).length / m.pts.length;
    const d = Math.min(...lines.map((l) => gap(box, l.box)));
    const place: Placement = on >= 0.3 ? "on" : d <= 40 ? "beside" : d <= 150 ? "near" : "apart";
    return { t: m.t, end: m.end, who: m.who, box, place, overlap: Math.round(on * 100) / 100 };
  });
}

// 2. Every line of writing that ends up on the page, learner's and tutor's
// together, and whose ink on it came first.
export function firstWriters(file: SessionFile): { line: string; box: Box; first: Who; at: number; learnerInk: number; tutorInk: number }[] {
  const items: { id: string; who: Who; t: number; pts: Pts }[] = [];
  for (const e of file.events) {
    if (e.type === "snapshot") e.strokes.forEach((s) => items.push({ id: s.id, who: "student", t: e.t, pts: s.pts.map((p) => [p[0], p[1]]) }));
    else if (e.type === "stroke" && e.kind !== "highlight") items.push({ id: e.id, who: e.who, t: e.t, pts: e.pts.map((p) => [p[0], p[1]]) });
    else if (e.type === "tutor_ink") e.strokes.forEach((s, i) => s.points.length && items.push({ id: `${e.id}:${i}`, who: "tutor", t: e.t + s.start, pts: s.points }));
  }
  const gone = new Set<string>();
  for (const e of file.events) if (e.type === "erase") e.ids.forEach((id) => gone.add(id));
  for (const e of file.events) if (e.type === "restore") e.ids.forEach((id) => gone.delete(id));
  const kept = items.filter((i) => !gone.has(i.id.split(":")[0]) && i.pts.length);
  const byId = new Map(kept.map((i) => [i.id, i]));
  const lines = groupLines(kept.map((i): Stroke => ({ id: i.id, color: "", size: 4, createdAt: 0, points: i.pts.map(([x, y]) => [x, y, 0.5]) })));
  return lines.map((l) => {
    const mine = l.strokeIds.map((id) => byId.get(id)!).sort((a, b) => a.t - b.t);
    const first = mine[0];
    return {
      line: l.id,
      box: l.box,
      first: first.who,
      at: first.t,
      learnerInk: mine.filter((m) => m.who === "student").length,
      tutorInk: mine.filter((m) => m.who !== "student").length,
    };
  });
}

// What counts as the tutor acting: its words (not the filler said while
// thinking), its ink, and the human tutor's strokes and words.
function tutorActs(file: SessionFile): { t: number; end: number }[] {
  const acts: { t: number; end: number }[] = [];
  for (const e of file.events) {
    if (e.type === "speech" && e.who !== "student" && !e.aside) acts.push({ t: e.t, end: e.end ?? e.t + 2000 });
    else if (e.type === "tutor_ink") acts.push({ t: e.t, end: e.t + e.duration });
    else if (e.type === "stroke" && e.who === "human_tutor") acts.push({ t: e.t, end: e.end });
  }
  return acts.sort((a, b) => a.t - b.t);
}

// 3. From each error the researcher marked to the tutor's next act.
export function errorLatencies(file: SessionFile): { at: number; label: string; firstAct: number | null; ms: number | null }[] {
  const acts = tutorActs(file);
  return file.events
    .filter((e): e is Extract<LogEvent, { type: "note" }> => e.type === "note" && e.kind === "error")
    .map((e) => {
      const next = acts.find((a) => a.t >= e.t);
      return { at: e.t, label: e.text, firstAct: next?.t ?? null, ms: next ? next.t - e.t : null };
    });
}

// 4. The learner resumed while the tutor was acting: did the tutor stop?
// Stopped means every tutor act ended within a second of the resume and none
// began again for a second and a half after that.
export function yields(file: SessionFile): { at: number; by: "pen" | "voice"; stopped: boolean; ms: number | null }[] {
  const acts = tutorActs(file);
  const resumes: { at: number; by: "pen" | "voice" }[] = [];
  for (const e of file.events) {
    if (e.type === "stroke" && e.who === "student") resumes.push({ at: e.t, by: "pen" });
    else if (e.type === "speech" && e.who === "student") resumes.push({ at: e.t, by: "voice" });
  }
  resumes.sort((a, b) => a.at - b.at);
  const out: { at: number; by: "pen" | "voice"; stopped: boolean; ms: number | null }[] = [];
  let lastAt = -Infinity;
  for (const r of resumes) {
    const during = acts.filter((a) => a.t < r.at && a.end > r.at);
    if (!during.length) continue;
    // one resume per tutor act: a stroke after a stroke is still the same resume
    if (r.at - lastAt < 2000) continue;
    lastAt = r.at;
    const quietAt = Math.max(...during.map((a) => a.end));
    const restarted = acts.some((a) => a.t > r.at && a.t < quietAt + QUIET_FOR_MS && !during.includes(a));
    const ms = quietAt - r.at;
    const stopped = ms <= STOP_WITHIN_MS && !restarted;
    out.push({ at: r.at, by: r.by, stopped, ms: Math.round(ms) });
  }
  return out;
}

export type Measures = {
  placements: Record<Placement, number>;
  marks: Mark[];
  steps: { learnerFirst: number; tutorFirst: number; lines: ReturnType<typeof firstWriters> };
  errors: ReturnType<typeof errorLatencies>;
  yields: { resumes: number; stopped: number; rate: number | null; list: ReturnType<typeof yields> };
};

export function measure(file: SessionFile): Measures {
  const marks = markPlacements(file);
  const placements: Record<Placement, number> = { on: 0, beside: 0, near: 0, apart: 0, blank: 0 };
  for (const m of marks) placements[m.place]++;
  const lines = firstWriters(file);
  const ys = yields(file);
  const stopped = ys.filter((y) => y.stopped).length;
  return {
    placements,
    marks,
    steps: { learnerFirst: lines.filter((l) => l.first === "student").length, tutorFirst: lines.filter((l) => l.first !== "student").length, lines },
    errors: errorLatencies(file),
    yields: { resumes: ys.length, stopped, rate: ys.length ? Math.round((stopped / ys.length) * 100) / 100 : null, list: ys },
  };
}

// One row per session, for pooling across participants.
export const MEASURE_COLUMNS = [
  "session", "started", "block", "tutor", "manners_broken", "minutes",
  "marks", "on_line", "beside", "near", "apart", "blank",
  "lines", "learner_first", "tutor_first",
  "errors_marked", "error_to_act_median_ms",
  "resumes_during_tutor", "tutor_stopped", "stop_rate",
] as const;

export function measureRow(file: SessionFile): (string | number)[] {
  const m = measure(file);
  const lat = m.errors.map((e) => e.ms).filter((x): x is number => x != null).sort((a, b) => a - b);
  const median = lat.length ? lat[Math.floor((lat.length - 1) / 2)] : "";
  const broken = Object.entries(file.manners ?? {}).filter(([, v]) => v).map(([k]) => k).join(" ");
  return [
    file.id, new Date(file.startedAt).toISOString(), file.block ? `${file.block.n}/${file.block.of} ${file.block.label}` : "", file.tutor, broken, Math.round(file.duration / 600) / 100,
    m.marks.length, m.placements.on, m.placements.beside, m.placements.near, m.placements.apart, m.placements.blank,
    m.steps.lines.length, m.steps.learnerFirst, m.steps.tutorFirst,
    m.errors.length, median,
    m.yields.resumes, m.yields.stopped, m.yields.rate ?? "",
  ];
}
