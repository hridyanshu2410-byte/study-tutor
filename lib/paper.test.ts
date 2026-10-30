import { test } from "node:test";
import assert from "node:assert/strict";
import { findSentence, guessTitle, mergeLines, paperDigest, sentencesOf, type Paper, type TextRun } from "./paper.ts";

const run = (str: string, x: number, y: number, w = 0.2, eol = false, h = 0.012): TextRun => ({ str, box: { x, y, w, h }, eol });

test("runs split into sentences, keeping abbreviations and hyphenated words whole", () => {
  const runs = [
    run("We propose a new attention mech-", 0.1, 0.2, 0.4, true),
    run("anism (see Fig. 2). It is fast.", 0.1, 0.22, 0.4, true),
    run("Smith et al. showed this", 0.1, 0.24, 0.3),
    run("earlier, e.g. in 2017.", 0.42, 0.24, 0.2, true),
  ];
  const s = sentencesOf(runs, 3);
  assert.deepEqual(
    s.map((x) => x.text),
    ["We propose a new attention mechanism (see Fig. 2).", "It is fast.", "Smith et al. showed this earlier, e.g. in 2017."],
  );
  assert.deepEqual(s.map((x) => x.id), ["p3.s1", "p3.s2", "p3.s3"]);
  // the third sentence's two runs sit on one line, so they merge into one box
  assert.equal(s[2].boxes.length, 1);
  assert.ok(Math.abs(s[2].boxes[0].w - 0.52) < 1e-9);
  // the first spans two lines
  assert.equal(s[0].boxes.length, 2);
});

test("boxes on different lines stay separate", () => {
  assert.equal(mergeLines([{ x: 0.1, y: 0.1, w: 0.2, h: 0.01 }, { x: 0.1, y: 0.2, w: 0.2, h: 0.01 }]).length, 2);
});

test("the digest tags sentences and keeps visible pages under a tight budget", () => {
  const page = (n: number, words: number) => ({ n, src: "", w: 1, h: 1, sentences: [{ id: `p${n}.s1`, text: "word ".repeat(words).trim() + ".", boxes: [] }] });
  const paper: Paper = { id: "x", title: "Attention", pages: [page(1, 10), page(2, 400), page(3, 10)], pageCount: 3 };
  const all = paperDigest(paper);
  assert.match(all.text, /\[p2\.s1\] word/);
  assert.equal(all.truncated, false);
  const tight = paperDigest(paper, 300, [3]);
  assert.equal(tight.truncated, true);
  assert.match(tight.text, /Page 2 === \(left out/);
  assert.match(tight.text, /\[p3\.s1\]/);
  assert.equal(findSentence(paper, "p2.s1")?.page.n, 2);
  assert.equal(findSentence(paper, "p9.s1"), null);
});

test("the title is the largest text near the top of the first page", () => {
  const runs = [run("Attention Is All", 0.2, 0.05, 0.3, false, 0.03), run("You Need", 0.5, 0.05, 0.2, true, 0.03), run("Abstract", 0.1, 0.2, 0.1, true)];
  assert.equal(guessTitle(runs, "paper.pdf"), "Attention Is All You Need");
  assert.equal(guessTitle([], "paper.pdf"), "paper.pdf");
});

test("headings, table rows and sentence ends inside a line get their own boxes", () => {
  const runs = [
    run("2 Method", 0.1, 0.1, 0.1, true, 0.016),
    run("Each token is routed. Attention is then", 0.1, 0.13, 0.4, true),
    run("computed within clusters.", 0.1, 0.15, 0.25, true),
    run("Model", 0.1, 0.2, 0.06), run("LongQA", 0.2, 0.2, 0.07), run("Speed", 0.32, 0.2, 0.05, true),
    run("Ours", 0.1, 0.22, 0.05), run("70.9", 0.2, 0.22, 0.04), run("3.1x", 0.32, 0.22, 0.04, true),
  ];
  const s = sentencesOf(runs, 2);
  assert.deepEqual(s.map((x) => x.text), ["2 Method", "Each token is routed.", "Attention is then computed within clusters.", "Model | LongQA | Speed", "Ours | 70.9 | 3.1x"]);
  // "Each token is routed." covers only the start of its line
  assert.ok(s[1].boxes[0].w < 0.4 * 0.6, `${s[1].boxes[0].w}`);
  assert.ok(s[2].boxes[0].x > 0.1 + 0.4 * 0.5);
});
