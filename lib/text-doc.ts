// Reading a poem, a story, a play or a chapter together. Pasted or uploaded
// text is set as book pages (a serif face, generous margins, poems with line
// numbers in the margin, the way an anthology prints them), and every line of
// a poem or sentence of prose gets an id and the boxes of each of its words,
// so the tutor can point at one exact word ("this word, 'fair'") and the app
// can mark just that word on the page.
//
// The layout is plain arithmetic over a measuring function, so it can be
// tested; only `typesetText` touches the browser, to draw the pages.

import type { Box } from "./ink.ts";
import { mergeLines, type DocKind, type Paper, type PaperPage, type PaperSentence } from "./paper.ts";

export const PAGE = { w: 1200, h: 1553, left: 150, right: 120, top: 130, bottom: 120 };
const FONT = 30;
const SERIF = `Georgia, "Iowan Old Style", "Palatino Linotype", "Times New Roman", serif`;
// About thirty book pages: a long poem, a short story, a chapter.
export const MAX_CHARS = 60_000;

type Measure = (text: string, font: string) => number;
type Word = { text: string; sentence: number; x: number; w: number; italic: boolean; bold: boolean };
type Line = { words: Word[]; y: number; size: number; number: number | null; title?: boolean };
type Laid = { pages: Line[][]; sentences: { id: number; line: number | null }[] };

// A poem has short lines kept as written; a play has speakers' names in
// capitals; anything else is prose.
export function guessKind(text: string): Exclude<DocKind, "paper"> {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const filled = lines.filter(Boolean);
  if (!filled.length) return "prose";
  const speakers = filled.filter((l) => /^[A-Z][A-Z .'-]{1,24}(\.|:|$)/.test(l) && l.length < 60).length;
  if (speakers >= 4 && speakers / filled.length > 0.12) return "play";
  const short = filled.filter((l) => l.length < 70).length / filled.length;
  const avg = filled.reduce((n, l) => n + l.length, 0) / filled.length;
  return short > 0.8 && avg < 55 && filled.length >= 3 ? "poem" : "prose";
}

const fontOf = (size: number, italic = false, bold = false) => `${italic ? "italic " : ""}${bold ? "600 " : ""}${size}px ${SERIF}`;

// Sentences of a paragraph, kept whole across abbreviations like "Mr." and initials.
export function splitSentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?…]["”’)\]]?)\s+(?=["“‘(\[]?[A-Z0-9])/);
  const out: string[] = [];
  for (const p of parts) {
    const last = out.at(-1);
    if (last && /\b(Mr|Mrs|Ms|Dr|St|Mt|Jr|Sr|vs|etc|e\.g|i\.e|[A-Z])\.$/.test(last)) out[out.length - 1] = `${last} ${p}`;
    else out.push(p);
  }
  return out.filter((s) => s.trim());
}

export function layoutText(title: string, text: string, kind: Exclude<DocKind, "paper">, measure: Measure): Laid {
  const width = PAGE.w - PAGE.left - PAGE.right;
  const space = measure(" ", fontOf(FONT));
  const sentences: Laid["sentences"] = [];
  const lead = FONT * (kind === "poem" ? 1.62 : 1.58);
  let y = PAGE.top;
  // Blocks of lines that stay on one page (a poem's wrapped line, a title), with the space before them.
  const blocks: { lines: Line[]; before: number }[] = [];

  const wrap = (words: Omit<Word, "x">[], indent: number, hang: number, size: number, number: number | null): Line[] => {
    const out: Line[] = [];
    let cur: Word[] = [];
    let x = indent;
    for (const w of words) {
      const fits = x + w.w <= width;
      if (!fits && cur.length) {
        out.push({ words: cur, y: 0, size, number: out.length ? null : number });
        cur = [];
        x = hang;
      }
      cur.push({ ...w, x });
      x += w.w + space;
    }
    if (cur.length) out.push({ words: cur, y: 0, size, number: out.length ? null : number });
    return out;
  };
  const wordsOf = (s: string, sentence: number, size: number, italic = false, bold = false): Omit<Word, "x">[] =>
    s
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => ({ text: t, sentence, w: measure(t, fontOf(size, italic, bold)), italic, bold }));

  if (title.trim()) {
    const size = 42;
    const tl = wrap(wordsOf(title.trim(), -1, size, false, true), 0, 0, size, null);
    tl.forEach((l) => (l.title = true));
    blocks.push({ lines: tl, before: 0 });
    blocks.push({ lines: [], before: FONT * 1.4 });
  }

  const paragraphs = text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split(/\n\s*\n/);
  if (kind === "poem") {
    let n = 0;
    paragraphs.forEach((stanza, si) => {
      stanza.split("\n").forEach((raw, li) => {
        if (!raw.trim()) return;
        n++;
        const id = sentences.length;
        sentences.push({ id, line: n });
        // keep the poet's own indent
        const indent = Math.min(width * 0.4, (raw.match(/^ */)?.[0].length ?? 0) * space);
        const ls = wrap(wordsOf(raw.trim(), id, FONT), indent, indent + FONT * 2, FONT, n % 5 === 0 ? n : null);
        blocks.push({ lines: ls, before: li === 0 && si > 0 ? lead * 0.75 : 0 });
      });
    });
  } else if (kind === "play") {
    for (const para of paragraphs)
      for (const raw of para.split("\n")) {
        const t = raw.trim();
        if (!t) continue;
        const m = /^([A-Z][A-Z .'-]{1,24})(\.|:)?\s+(.*)$/.exec(t);
        const direction = /^[[(].*[\])]$/.test(t);
        const words: Omit<Word, "x">[] = [];
        if (m && !direction) words.push(...wordsOf(`${m[1]}${m[2] ?? ""}`, -1, FONT, false, true));
        const body = m && !direction ? m[3] : t;
        for (const sent of splitSentences(body)) {
          const id = sentences.length;
          sentences.push({ id, line: null });
          words.push(...wordsOf(sent, id, FONT, direction));
        }
        blocks.push({ lines: wrap(words, 0, FONT * 1.5, FONT, null), before: lead * 0.35 });
      }
  } else {
    paragraphs.forEach((para, pi) => {
      const flat = para.replace(/\s*\n\s*/g, " ").trim();
      if (!flat) return;
      const words: Omit<Word, "x">[] = [];
      for (const sent of splitSentences(flat)) {
        const id = sentences.length;
        sentences.push({ id, line: null });
        words.push(...wordsOf(sent, id, FONT));
      }
      // each line of a paragraph is its own block, so a paragraph can run on to the next page
      wrap(words, pi === 0 ? 0 : FONT * 1.4, 0, FONT, null).forEach((l, k) => blocks.push({ lines: [l], before: k === 0 && pi > 0 ? lead * 0.25 : 0 }));
    });
  }

  // onto pages
  const pages: Line[][] = [[]];
  const bottom = PAGE.h - PAGE.bottom;
  for (const b of blocks) {
    const h = b.lines.length * lead;
    if (pages.at(-1)!.length && y + b.before + h > bottom) {
      pages.push([]);
      y = PAGE.top;
    } else y += pages.at(-1)!.length ? b.before : 0;
    for (const l of b.lines) {
      const size = l.size;
      l.y = y + size; // baseline
      y += l.title ? size * 1.35 : lead;
      pages.at(-1)!.push(l);
    }
  }
  return { pages: pages.filter((p) => p.length), sentences };
}

// The pages' entries: each line of a poem or sentence of prose, with the box
// of every word, as fractions of the page.
export function entriesOf(laid: Laid, kind: Exclude<DocKind, "paper">): PaperPage["sentences"][] {
  return laid.pages.map((lines, pi) => {
    const byId = new Map<number, { words: { text: string; box: Box }[] }>();
    const order: number[] = [];
    for (const l of lines)
      for (const w of l.words) {
        if (w.sentence < 0) continue;
        if (!byId.has(w.sentence)) {
          byId.set(w.sentence, { words: [] });
          order.push(w.sentence);
        }
        const box = { x: (PAGE.left + w.x) / PAGE.w, y: (l.y - l.size * 0.92) / PAGE.h, w: w.w / PAGE.w, h: (l.size * 1.22) / PAGE.h };
        byId.get(w.sentence)!.words.push({ text: w.text, box });
      }
    return order.map((id, k) => {
      const ws = byId.get(id)!.words;
      let at = 0;
      const words = ws.map((w) => {
        const out = { at, n: w.text.length, box: w.box };
        at += w.text.length + 1;
        return out;
      });
      const lineNo = laid.sentences[id]?.line;
      const entry: PaperSentence = {
        id: `p${pi + 1}.s${k + 1}`,
        text: ws.map((w) => w.text).join(" "),
        boxes: mergeLines(ws.map((w) => w.box)),
        words,
        ...(kind === "poem" && lineNo ? { line: lineNo } : {}),
      };
      return entry;
    });
  });
}

// Sets the text as page pictures and returns it as a document to read together.
export async function typesetText(title: string, text: string, kindChoice: Exclude<DocKind, "paper"> | "auto"): Promise<Paper> {
  const clipped = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
  const kind = kindChoice === "auto" ? guessKind(clipped) : kindChoice;
  const probe = document.createElement("canvas").getContext("2d")!;
  const measure: Measure = (t, font) => {
    probe.font = font;
    return probe.measureText(t).width;
  };
  if (document.fonts?.ready) await document.fonts.ready;
  const laid = layoutText(title, clipped, kind, measure);
  const entries = entriesOf(laid, kind);
  const pages: PaperPage[] = laid.pages.map((lines, pi) => {
    const c = document.createElement("canvas");
    c.width = PAGE.w;
    c.height = PAGE.h;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fffdf9";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.textBaseline = "alphabetic";
    for (const l of lines) {
      for (const w of l.words) {
        ctx.font = fontOf(l.size, w.italic, w.bold || !!l.title);
        ctx.fillStyle = l.title ? "#111827" : w.bold ? "#374151" : "#1f2937";
        ctx.fillText(w.text, PAGE.left + w.x, l.y);
      }
      if (l.number != null) {
        ctx.font = fontOf(20);
        ctx.fillStyle = "#9ca3af";
        const s = String(l.number);
        ctx.fillText(s, PAGE.left - 30 - measure(s, fontOf(20)), l.y);
      }
    }
    ctx.font = fontOf(18);
    ctx.fillStyle = "#9ca3af";
    const folio = String(pi + 1);
    ctx.fillText(folio, PAGE.w / 2 - measure(folio, fontOf(18)) / 2, PAGE.h - 60);
    return { n: pi + 1, src: c.toDataURL("image/jpeg", 0.86), w: PAGE.w, h: PAGE.h, sentences: entries[pi] ?? [] };
  });
  const name = title.trim() || firstWords(clipped);
  return { id: crypto.randomUUID(), title: name, pages, pageCount: pages.length, kind, ...(text.length > MAX_CHARS ? { clipped: true } : {}) };
}

function firstWords(text: string): string {
  const first = text.trim().split(/\n/)[0].trim();
  return first.length > 60 ? `${first.slice(0, 57)}…` : first || "Untitled";
}
