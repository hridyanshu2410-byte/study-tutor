// Reading a research paper together. A paper is its page pictures plus its
// text split into sentences, each with an id like "p3.s12" and the boxes it
// covers on the page, so the tutor can point at an exact passage and the
// app can highlight it. Nothing here touches the browser, so it can be tested.

import type { Box } from "./ink.ts";

// A run of text on a page, with its box as fractions of the page (0..1, y down).
export type TextRun = { str: string; box: Box; eol: boolean };
export type PaperSentence = { id: string; text: string; boxes: Box[] };
export type PaperPage = { n: number; src: string; w: number; h: number; sentences: PaperSentence[] };
export type Paper = { id: string; title: string; pages: PaperPage[]; pageCount: number };

const ABBREV = /\b(e\.g|i\.e|et al|etc|vs|Fig|Figs|Eq|Eqs|Sec|Tab|cf|approx|resp|Dr|Mr|Ms|No|Vol|pp|al)\.$/i;

// Ends in . ! or ? that isn't an abbreviation ("Fig.") or an initial ("A. Smith").
function endsSentence(s: string): boolean {
  const t = s.trim();
  return /[.!?]["”)]?$/.test(t) && !ABBREV.test(t) && !/(^|\s)[A-Z]\.$/.test(t);
}

// Splits a page's runs into sentences. A sentence's boxes are the parts of
// runs it covers (a run can hold the end of one sentence and the start of the
// next), merged line by line: what a highlighter would cover. Table rows and
// headings become their own entries so they can be pointed at too.
// `aspect` is the page's height over its width, since boxes are fractions of each.
export function sentencesOf(runs: TextRun[], page: number, aspect = 11 / 8.5): PaperSentence[] {
  const out: PaperSentence[] = [];
  let text = "";
  let boxes: Box[] = [];
  let heights: number[] = [];
  const flush = () => {
    const t = text.replace(/\s+/g, " ").trim();
    if (t.length > 1) out.push({ id: `p${page}.s${out.length + 1}`, text: t, boxes: mergeLines(boxes) });
    text = "";
    boxes = [];
    heights = [];
  };

  for (const line of linesOf(runs)) {
    if (isTableRow(line, aspect)) {
      flush();
      text = line.filter((r) => r.str.trim()).map((r) => r.str.trim()).join(" | ");
      boxes = line.filter((r) => r.str.trim()).map((r) => r.box);
      flush();
      continue;
    }
    for (const run of line) {
      if (!run.str.trim()) {
        if (run.str) text += " ";
        continue;
      }
      // A change of font size is a heading starting or ending.
      const avg = heights.length ? heights.reduce((a, b) => a + b, 0) / heights.length : run.box.h;
      if (text.trim() && Math.abs(run.box.h - avg) / avg > 0.12) flush();
      // A line-ending hyphen joins the word across lines.
      if (/[a-z]-\s*$/.test(text) && /^[a-z]/.test(run.str)) text = text.replace(/-\s*$/, "");
      else if (text && !/\s$/.test(text)) text += " ";
      const parts: string[] = [];
      for (const piece of run.str.split(/(?<=[.!?])\s+(?=[A-Z0-9(“"])/)) {
        if (parts.length && !endsSentence(parts[parts.length - 1])) parts[parts.length - 1] += ` ${piece}`;
        else parts.push(piece);
      }
      let at = 0;
      parts.forEach((part, i) => {
        const from = Math.max(0, run.str.indexOf(part, at));
        at = from + part.length;
        const len = run.str.length || 1;
        text += part;
        boxes.push({ ...run.box, x: run.box.x + (run.box.w * from) / len, w: (run.box.w * part.length) / len });
        heights.push(run.box.h);
        if (i < parts.length - 1 || endsSentence(text)) flush();
      });
      // Very long "sentences" are usually captions or references run together.
      if (text.length > 600) flush();
    }
    text += " ";
  }
  flush();
  return out;
}

// Runs grouped into lines: a new line after an end-of-line mark or a jump in height.
function linesOf(runs: TextRun[]): TextRun[][] {
  const lines: TextRun[][] = [];
  let cur: TextRun[] = [];
  for (const r of runs) {
    const last = cur.findLast((x) => x.str.trim());
    if (last && r.str.trim() && Math.abs(last.box.y + last.box.h / 2 - (r.box.y + r.box.h / 2)) > Math.max(last.box.h, r.box.h) * 0.6) {
      lines.push(cur);
      cur = [];
    }
    cur.push(r);
    if (r.eol) {
      lines.push(cur);
      cur = [];
    }
  }
  if (cur.length) lines.push(cur);
  return lines;
}

// Three or more cells with wide gaps between them, like a results table row.
function isTableRow(line: TextRun[], aspect: number): boolean {
  const cells = line.filter((r) => r.str.trim());
  if (cells.length < 3) return false;
  let wide = 0;
  for (let i = 1; i < cells.length; i++) {
    const gap = (cells[i].box.x - (cells[i - 1].box.x + cells[i - 1].box.w)) / aspect; // in units of page height
    if (gap > cells[i].box.h * 1.2) wide++;
  }
  return wide >= cells.length - 2;
}

// Neighbouring boxes on the same line become one box.
export function mergeLines(boxes: Box[]): Box[] {
  const out: Box[] = [];
  for (const b of boxes) {
    const last = out.at(-1);
    const sameLine = last && Math.abs(last.y + last.h / 2 - (b.y + b.h / 2)) < Math.max(last.h, b.h) * 0.5;
    if (last && sameLine && b.x >= last.x - 0.01 && b.x - (last.x + last.w) < 0.05) {
      const x = Math.min(last.x, b.x), y = Math.min(last.y, b.y);
      out[out.length - 1] = { x, y, w: Math.max(last.x + last.w, b.x + b.w) - x, h: Math.max(last.y + last.h, b.y + b.h) - y };
    } else out.push({ ...b });
  }
  return out;
}

// The paper as text for the tutor: every sentence tagged with its id, page by
// page, cut to a budget so a long paper stays affordable. Pages the student is
// looking at are always kept whole.
export function paperDigest(paper: Paper, budget = 120_000, keep: number[] = []): { text: string; truncated: boolean } {
  const pageText = (p: PaperPage) => `\n=== Page ${p.n} ===\n` + p.sentences.map((s) => `[${s.id}] ${s.text}`).join("\n");
  const pages = paper.pages.map((p) => ({ n: p.n, text: pageText(p) }));
  let used = pages.filter((p) => keep.includes(p.n)).reduce((n, p) => n + p.text.length, 0);
  let truncated = paper.pageCount > paper.pages.length;
  const kept = pages.map((p) => {
    if (keep.includes(p.n)) return p.text;
    if (used + p.text.length <= budget) {
      used += p.text.length;
      return p.text;
    }
    truncated = true;
    return `\n=== Page ${p.n} === (left out for length)`;
  });
  return { text: `Title: ${paper.title}\n${kept.join("\n")}`, truncated };
}

// A best guess at the title: the largest text near the top of page one.
export function guessTitle(runs: TextRun[], fallback: string): string {
  const top = runs.filter((r) => r.str.trim() && r.box.y < 0.35);
  if (!top.length) return fallback;
  const tallest = Math.max(...top.map((r) => r.box.h));
  const title = top
    .filter((r) => r.box.h > tallest * 0.85)
    .map((r) => r.str.trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return title.length >= 4 && title.length <= 200 ? title : fallback;
}

// Where each sentence id lives, for drawing highlights.
export function findSentence(paper: Paper, id: string): { page: PaperPage; sentence: PaperSentence } | null {
  const m = /^p(\d+)\.s\d+$/.exec(id);
  const page = m ? paper.pages.find((p) => p.n === Number(m[1])) : undefined;
  const sentence = page?.sentences.find((s) => s.id === id);
  return page && sentence ? { page, sentence } : null;
}
