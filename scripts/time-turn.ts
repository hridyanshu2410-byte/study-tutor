// Times real tutor turns against a running app, the way the browser asks for
// them, to see where the wait goes: when the first words are known, when each
// phrase's ink arrives, when the turn ends, and how soon its voice could start.
//
//   npm run time-turn -- --pdf paper.pdf
//   npm run time-turn -- --pdf https://arxiv.org/pdf/2208.04024 --base http://localhost:3101 \
//     --then "why not just test with real people?" --runs 2 --out run.json
//
// It reads the paper with the app's own sentence splitter, sends blank page
// pictures, and never needs an API key: the app's server holds those.

import fs from "node:fs";
import zlib from "node:zlib";
import { guessTitle, paperDigest, sentencesOf, type Paper, type TextRun } from "../lib/paper.ts";
import type { Beat, TurnEnd, TutorRequest } from "../lib/tutor.ts";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string | null = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const all = (name: string) => args.flatMap((a, i) => (a === `--${name}` && i + 1 < args.length ? [args[i + 1]] : []));
const base = (opt("base", "http://localhost:3000") ?? "").replace(/\/+$/, "");
const pdf = opt("pdf");
const trigger = (opt("trigger", pdf ? "paper_opened" : "asked") ?? "asked") as TutorRequest["trigger"];
const problem = opt("problem", "") ?? "";
const runs = Number(opt("runs", "1"));
const out = opt("out");
const follow = all("then");

// A plain white picture of the screen, so the model is sent as much image as the browser would.
function whitePng(w: number, h: number): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.alloc(1 + w * 3, 0xff);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

// The paper's sentences with ids, as the browser builds them when a PDF is opened.
async function readPaper(src: string): Promise<Paper> {
  const data = /^https?:\/\//.test(src) ? new Uint8Array(await (await fetch(src)).arrayBuffer()) : new Uint8Array(fs.readFileSync(src));
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data, disableFontFace: true, verbosity: 0 }).promise;
  const pages: Paper["pages"] = [];
  let firstRuns: TextRun[] = [];
  for (let n = 1; n <= Math.min(doc.numPages, 30); n++) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: 1200 / page.getViewport({ scale: 1 }).width });
    const runs: TextRun[] = [];
    for (const item of (await page.getTextContent()).items) {
      if (!("str" in item)) continue;
      const tx = pdfjs.Util.transform(viewport.transform, item.transform) as number[];
      const fontH = Math.hypot(tx[2], tx[3]);
      runs.push({
        str: item.str,
        eol: item.hasEOL,
        box: { x: tx[4] / viewport.width, y: (tx[5] - fontH) / viewport.height, w: (item.width * viewport.scale) / viewport.width, h: (fontH * 1.2) / viewport.height },
      });
    }
    if (n === 1) firstRuns = runs;
    pages.push({ n, src: "", w: viewport.width, h: viewport.height, sentences: sentencesOf(runs, n, viewport.height / viewport.width) });
  }
  const meta = (await doc.getMetadata().catch(() => null))?.info as { Title?: string } | undefined;
  const title = meta?.Title?.trim() || guessTitle(firstRuns, "paper");
  await doc.destroy();
  return { id: "timing", title, pages, pageCount: doc.numPages };
}

type Event = { at: number; kind: string; text: string };
type Run = { trigger: string; speech: string | null; status: number; events: Event[]; beats: Beat[]; end: TurnEnd | null; voice: { firstByte: number; done: number; bytes: number } | null; error?: string };

const s = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

function inkOf(b: Beat): string {
  const parts = [
    ...b.write.map((w) => `write "${w}"`),
    b.draw ? `${b.continue_figure ? "+" : ""}${b.draw.kind} (${JSON.stringify(b.draw).length} chars)` : "",
    ...b.highlights.map((h) => `${h.kind} ${h.ref}${h.note ? ` "${h.note}"` : ""}`),
    ...b.annotations.map((a) => `${a.kind} ${a.line_id}${a.text ? ` "${a.text}"` : ""}`),
  ].filter(Boolean);
  return parts.join(" | ") || "no ink";
}

async function timeVoice(text: string) {
  const t0 = performance.now();
  const res = await fetch(`${base}/api/voice`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
  if (!res.ok || !res.body) return null;
  let firstByte = -1;
  let bytes = 0;
  const reader = res.body.getReader();
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    if (firstByte < 0) firstByte = performance.now() - t0;
    bytes += r.value.length;
  }
  return { firstByte, done: performance.now() - t0, bytes };
}

async function turn(body: TutorRequest): Promise<Run> {
  const t0 = performance.now();
  const at = () => performance.now() - t0;
  const run: Run = { trigger: body.trigger, speech: body.speech, status: 0, events: [], beats: [], end: null, voice: null };
  const res = await fetch(`${base}/api/tutor`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  run.status = res.status;
  run.events.push({ at: at(), kind: "headers", text: res.headers.get("content-type") ?? "" });
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("ndjson") || !res.body) {
    run.error = (await res.text()).slice(0, 300);
    return run;
  }
  let firstWords: string | null = null;
  const dec = new TextDecoder();
  let buf = "";
  const reader = res.body.getReader();
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    buf += dec.decode(r.value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const e = JSON.parse(buf.slice(0, i)) as { upcoming?: string; beat?: Beat; turn?: TurnEnd; error?: string };
      buf = buf.slice(i + 1);
      if (e.upcoming) {
        run.events.push({ at: at(), kind: "words", text: e.upcoming });
        firstWords ??= e.upcoming;
      } else if (e.beat) {
        run.events.push({ at: at(), kind: "beat", text: `"${e.beat.say}" ${inkOf(e.beat)}` });
        run.beats.push(e.beat);
        firstWords ??= e.beat.say;
      } else if (e.turn) {
        run.events.push({ at: at(), kind: "turn", text: e.turn.move });
        run.end = e.turn;
      } else if (e.error) run.events.push({ at: at(), kind: "error", text: e.error });
    }
  }
  if (firstWords) run.voice = await timeVoice(firstWords);
  return run;
}

function report(run: Run) {
  console.log(`\n${run.trigger}${run.speech ? ` "${run.speech}"` : ""}: HTTP ${run.status}${run.error ? ` ${run.error}` : ""}`);
  for (const e of run.events) console.log(`  ${s(e.at).padStart(8)}  ${e.kind.padEnd(7)} ${e.text}`);
  const words = run.events.find((e) => e.kind === "words" || e.kind === "beat");
  const beat = run.events.find((e) => e.kind === "beat");
  if (run.voice && words && beat) {
    // The browser fetches a phrase's voice once its words are known, and starts it with the phrase's ink.
    const heard = Math.max(beat.at, words.at + run.voice.firstByte + 150);
    console.log(`  voice: first audio ${s(run.voice.firstByte)} after asking for it, all of it ${s(run.voice.done)} (${Math.round(run.voice.bytes / 1024)} KB)`);
    console.log(`  the student would hear the first words at about ${s(heard)}`);
  }
  const words2 = run.beats.reduce((n, b) => n + b.say.split(/\s+/).filter(Boolean).length, 0);
  console.log(`  ${run.beats.length} beats, ${words2} words spoken`);
}

const paper = pdf ? await readPaper(pdf) : null;
const digest = paper ? paperDigest(paper) : null;
if (paper) console.log(`Paper "${paper.title}": ${paper.pages.length} pages, ${digest!.text.length} characters of text${digest!.truncated ? " (cut for length)" : ""}`);
const page = whitePng(1600, 1000);
const results: Run[] = [];
for (let r = 0; r < runs; r++) {
  const sessionId = `timing-${Date.now()}-${r}`;
  const ask = (trigger: TutorRequest["trigger"], speech: string | null): TutorRequest => ({
    sessionId,
    mode: "study",
    review: null,
    weakSpots: [],
    problem,
    trigger,
    speech,
    paper: paper && digest ? { title: paper.title, text: digest.text, truncated: digest.truncated, visiblePages: [1], pointedAt: null } : null,
    lines: [],
    hasPhoto: false,
    pageImage: page,
    tokenImage: page,
  });
  for (const [t, speech] of [[trigger, trigger === "spoke" ? (opt("speech") ?? "") : null] as const, ...follow.map((f) => ["spoke", f] as const)]) {
    const run = await turn(ask(t, speech));
    report(run);
    results.push(run);
    if (run.error) break;
  }
}
if (out) fs.writeFileSync(out, JSON.stringify(results, null, 1));
