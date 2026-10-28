// The tutor's turn arrives as JSON a few characters at a time. These read it
// as it comes, so each beat (a phrase and its ink) can be checked and sent to
// the student the moment it is complete, while the rest is still being written.

import { firstBreak } from "./check.ts";
import { beatSchema, type Beat, type TutorTurn } from "./tutor.ts";

// Reads a growing JSON object: each top-level value once it is complete, and
// the items of its "beats" array one by one.
export class TurnScanner {
  readonly values = new Map<string, unknown>();
  readonly beats: unknown[] = [];
  private s = "";
  private pos = 0;
  private depth = 0;
  private inString = false;
  private escaped = false;
  private stringStart = -1;
  // where we are among the top-level object's members
  private phase: "key" | "colon" | "value" | "after" = "key";
  private key = "";
  private valueStart = -1;
  private beatStart = -1;

  get text() {
    return this.s;
  }

  // The words of the beat still being written, as soon as they are complete,
  // so its voice can be made while its ink is still coming. Null until then.
  get upcoming(): string | null {
    if (this.beatStart < 0) return null;
    const m = /^\{\s*"say"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(this.s.slice(this.beatStart));
    const say = m ? parse(m[1]) : null;
    return typeof say === "string" ? say : null;
  }

  push(chunk: string) {
    this.s += chunk;
    for (; this.pos < this.s.length; this.pos++) {
      const c = this.s[this.pos];
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (c === "\\") this.escaped = true;
        else if (c === '"') {
          this.inString = false;
          if (this.depth === 1 && this.phase === "key") {
            this.key = parse(this.s.slice(this.stringStart, this.pos + 1)) as string;
            this.phase = "colon";
          } else if (this.depth === 1 && this.phase === "value" && this.valueStart === this.stringStart) this.complete(this.pos + 1);
        }
        continue;
      }
      if (c === '"') {
        this.inString = true;
        this.stringStart = this.pos;
        if (this.depth === 1 && this.phase === "value" && this.valueStart < 0) this.valueStart = this.pos;
      } else if (c === "{" || c === "[") {
        if (this.depth === 1 && this.phase === "value" && this.valueStart < 0) this.valueStart = this.pos;
        if (this.depth === 2 && c === "{" && this.key === "beats") this.beatStart = this.pos;
        this.depth++;
      } else if (c === "}" || c === "]") {
        // a number, true, false or null ends at the brace that closes the object
        if (this.depth === 1 && this.phase === "value" && this.valueStart >= 0) this.complete(this.pos);
        this.depth--;
        if (this.depth === 2 && c === "}" && this.key === "beats" && this.beatStart >= 0) {
          this.beats.push(parse(this.s.slice(this.beatStart, this.pos + 1)));
          this.beatStart = -1;
        }
        if (this.depth === 1 && this.phase === "value" && this.valueStart >= 0) this.complete(this.pos + 1);
      } else if (this.depth === 1) {
        if (c === ":" && this.phase === "colon") {
          this.phase = "value";
          this.valueStart = -1;
        } else if (c === ",") {
          if (this.phase === "value" && this.valueStart >= 0) this.complete(this.pos);
          this.phase = "key";
        } else if (this.phase === "value" && this.valueStart < 0 && !/\s/.test(c)) this.valueStart = this.pos;
      }
    }
  }

  private complete(end: number) {
    this.values.set(this.key, parse(this.s.slice(this.valueStart, end).trim()));
    this.valueStart = -1;
    this.phase = "after";
  }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// What the checker found wrong with the student's page, compared with what
// the tutor read there. Null when they agree.
export function readingFlag(priv: TutorTurn["private"] | undefined): string | null {
  const reading = priv?.reading ?? [];
  const student = firstBreak(reading.map((r) => r.latex));
  if (!student) return null;
  const id = reading[student.index].line_id;
  const said = priv?.first_error_line ?? null;
  const saidAt = said ? reading.findIndex((r) => r.line_id === said) : -1;
  if (saidAt >= 0 && saidAt <= student.index) return null;
  return `On the student's page, ${student.detail} (line ${id}), but your first_error_line is ${said ?? "null"}. Check your reading of ${id} and the line before it.`;
}

export type BeatRules = {
  // Paper mode: the paper's text, to check that highlighted sentences exist.
  paperText: string | null;
  // The student's line ids, for marks on them.
  lines: Set<string>;
};

// Holds a turn's beats to its limits as they arrive (marks, lines and
// figures per turn), and checks the tutor's own math across beats: a slip in
// what it writes must never reach the page.
export class BeatChecker {
  private writes: string[] = [];
  private steps: string[] | null = null;
  private figures = 0;
  private highlights = 0;
  private annotations = 0;
  private rules: BeatRules;
  count = 0;

  constructor(rules: BeatRules) {
    this.rules = rules;
  }

  // A beat in the shape the app expects, trimmed to the turn's limits; null if
  // it isn't a beat or there is nothing in it.
  sanitize(raw: unknown): Beat | null {
    const parsed = beatSchema.safeParse(raw);
    if (!parsed.success || this.count >= 8) return null;
    const b = parsed.data;
    const paper = this.rules.paperText;
    b.say = b.say.trim().slice(0, 240);
    b.write = b.write.map((w) => w.trim().slice(0, paper ? 60 : 48)).filter(Boolean).slice(0, 2).slice(0, Math.max(0, 6 - this.writes.length));
    if (b.draw && !b.continue_figure && this.figures >= 2) b.draw = null;
    b.highlights = !paper
      ? []
      : b.highlights
          .filter((h) => /^p\d+\.s\d+$/.test(h.ref) && paper.includes(`[${h.ref}]`))
          .slice(0, Math.max(0, 3 - this.highlights))
          .map((h) => ({ ...h, note: h.note?.trim().slice(0, 40) || null }));
    b.annotations = b.annotations.filter((a) => this.rules.lines.has(a.line_id) || a.kind === "note").slice(0, Math.max(0, 4 - this.annotations));
    if (!b.say && !b.write.length && !b.draw && !b.highlights.length && !b.annotations.length) return null;
    return b;
  }

  // A slip in this beat's math, checked against everything the turn wrote before it.
  slip(b: Beat): string | null {
    const w = firstBreak([...this.writes, ...b.write]);
    if (w && w.index >= this.writes.length) return `In what you wrote, ${w.detail}.`;
    const lines = this.stepLines(b);
    if (lines) {
      const before = b.continue_figure && this.steps ? this.steps.length : 0;
      const s = firstBreak(lines);
      if (s && s.index >= before) return `In the steps you drew, ${s.detail}.`;
    }
    return null;
  }

  // Cuts this beat's math at its first slip.
  strip(b: Beat) {
    const w = firstBreak([...this.writes, ...b.write]);
    if (w && w.index >= this.writes.length) b.write = b.write.slice(0, w.index - this.writes.length);
    const lines = this.stepLines(b);
    if (lines && b.draw?.kind === "steps") {
      const before = b.continue_figure && this.steps ? this.steps.length : 0;
      const s = firstBreak(lines);
      if (s && s.index >= before) b.draw.lines = b.draw.lines.slice(0, s.index - before);
      if (!b.draw.lines.length) b.draw = null;
    }
  }

  // The beat is going out: count it toward the turn's limits.
  commit(b: Beat) {
    this.count++;
    this.writes.push(...b.write);
    this.highlights += b.highlights.length;
    this.annotations += b.annotations.length;
    if (b.draw) {
      const lines = this.stepLines(b);
      if (b.draw.kind === "steps") this.steps = lines;
      else if (!b.continue_figure) this.steps = null;
      if (!b.continue_figure) this.figures++;
    }
  }

  // All the equation lines of the steps figure this beat draws or grows.
  private stepLines(b: Beat): string[] | null {
    if (b.draw?.kind !== "steps") return null;
    const add = b.draw.lines.map((l) => l.math);
    return b.continue_figure && this.steps ? [...this.steps, ...add] : add;
  }
}
