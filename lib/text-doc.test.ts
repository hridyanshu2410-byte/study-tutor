import { test } from "node:test";
import assert from "node:assert/strict";
import { entriesOf, guessKind, layoutText, splitSentences } from "./text-doc.ts";
import { paperDigest, phraseBoxes, type Paper } from "./paper.ts";

// a monospace stand-in for the browser's text measure
const measure = (t: string, font: string) => t.length * (Number(/(\d+)px/.exec(font)?.[1] ?? 30) * 0.5);

const OZYMANDIAS = `I met a traveller from an antique land,
Who said—"Two vast and trunkless legs of stone
Stand in the desert. . . . Near them, on the sand,
Half sunk a shattered visage lies, whose frown,
And wrinkled lip, and sneer of cold command,

Tell that its sculptor well those passions read`;

test("poems, plays and prose are told apart", () => {
  assert.equal(guessKind(OZYMANDIAS), "poem");
  assert.equal(guessKind("ROMEO. But soft!\nJULIET. Ay me!\nROMEO. She speaks.\nJULIET. O Romeo, Romeo!\nROMEO. Shall I hear more?"), "play");
  assert.equal(guessKind("It was a bright cold day in April, and the clocks were striking thirteen. Winston Smith, his chin nuzzled into his breast in an effort to escape the vile wind, slipped quickly through the glass doors of Victory Mansions."), "prose");
});

test("sentences keep titles and initials whole", () => {
  assert.deepEqual(splitSentences("Mr. Darcy bowed. She smiled! Then J. Austen wrote on."), ["Mr. Darcy bowed.", "She smiled!", "Then J. Austen wrote on."]);
});

test("a poem is set line by line, numbered, with every word's place", () => {
  const laid = layoutText("Ozymandias", OZYMANDIAS, "poem", measure);
  const [page] = entriesOf(laid, "poem");
  assert.equal(page.length, 6);
  assert.equal(page[0].text, "I met a traveller from an antique land,");
  assert.equal(page[5].line, 6);
  assert.equal(page[0].words?.length, 8);
  // the stanza break leaves more room before line 6 than between lines 4 and 5
  const gap = (a: number, b: number) => page[b].boxes[0].y - page[a].boxes[0].y;
  assert.ok(gap(4, 5) > gap(3, 4) * 1.3);
  // one word can be marked on its own
  const boxes = phraseBoxes(page[0], "antique")!;
  assert.equal(boxes.length, 1);
  const word = page[0].words![6];
  assert.ok(Math.abs(boxes[0].x - word.box.x) < 1e-9 && Math.abs(boxes[0].w - word.box.w) < 1e-9);
  assert.equal(phraseBoxes(page[0], "not in it"), null);
});

test("long prose runs on to more pages, and the digest says what it is", () => {
  const para = "The rain kept falling on the town. ".repeat(60);
  const text = Array.from({ length: 12 }, () => para).join("\n\n");
  const laid = layoutText("A wet day", text, "prose", measure);
  assert.ok(laid.pages.length > 3);
  const entries = entriesOf(laid, "prose");
  const paper: Paper = {
    id: "x",
    title: "A wet day",
    kind: "prose",
    pageCount: laid.pages.length,
    pages: entries.map((sentences, i) => ({ n: i + 1, src: "", w: 1200, h: 1553, sentences })),
  };
  const digest = paperDigest(paper);
  assert.match(digest.text, /^Prose: A wet day/);
  assert.match(digest.text, /=== Page 2 ===\n\[p2\.s1\] \w/);
});

test("a phrase in a PDF sentence is estimated along its lines", () => {
  const s = { id: "p1.s1", text: "abcdefghij", boxes: [{ x: 0.1, y: 0.1, w: 0.5, h: 0.02 }, { x: 0.1, y: 0.13, w: 0.5, h: 0.02 }] };
  const b = phraseBoxes(s, "efg")!;
  assert.equal(b.length, 2);
  assert.ok(Math.abs(b[0].x - 0.5) < 1e-9 && Math.abs(b[1].w - 0.2) < 1e-9);
});
