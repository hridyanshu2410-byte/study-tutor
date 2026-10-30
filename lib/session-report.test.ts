import { test } from "node:test";
import assert from "node:assert/strict";
import { journalText, reportAnalysisSchema, reportHtml, reportStats, type SessionReport } from "./session-report.ts";

const t0 = Date.UTC(2026, 9, 30, 10, 0, 0);
const report = (more: Partial<SessionReport> = {}): SessionReport => ({
  id: "r1",
  startedAt: t0,
  endedAt: t0 + 12 * 60000,
  paper: { title: "Social Simulacra" },
  problem: "",
  journal: [
    { at: t0 + 1000, who: "student", text: "Opened “Social Simulacra”.", trigger: "paper_opened" },
    {
      at: t0 + 5000,
      who: "tutor",
      text: "Say you're launching a forum. They have GPT-3 play its members. Why might a few testers miss trolls?",
      move: "next_step",
      concept: "social simulacra",
      highlights: [{ ref: "p1.s14", note: "their fix", text: "We introduce social simulacra, a prototyping technique.", page: 1 }],
      picture: "data:image/jpeg;base64,AAAA",
    },
    { at: t0 + 65000, who: "student", text: "Because <friends> are polite to each other", trigger: "spoke" },
  ],
  board: null,
  analysis: {
    title: "Social simulacra: prototyping with fake crowds",
    summary: "You got the core idea.",
    topics: [{ name: "Why small tests miss harms", understanding: 80, evidence: "You said friends are polite." }],
    strengths: [{ point: "Good prediction", evidence: "Friends are polite" }],
    weaknesses: [{ point: "How personas are made", evidence: "Not discussed", fix: "Reread section 4" }],
    next_session: [{ topic: "Generation pipeline", why: "Not covered", activity: "Sketch the pipeline from memory" }],
    reread: [{ ref: "p1.s14", what: "The contribution", why: "It frames everything" }],
    notes: [{ heading: "The idea", points: ["A designer's description becomes a populated prototype."] }],
    key_terms: [{ term: "social simulacra", meaning: "made-up community members and their posts" }],
    questions: ["What could the simulation never show?"],
  },
  passages: { "p1.s14": { text: "We introduce social simulacra, a prototyping technique.", page: 1 } },
  cards: [],
  ...more,
});

test("the conversation reads in order, with who said what, moves, ideas and highlights", () => {
  const text = journalText(report().journal);
  const lines = text.split("\n");
  assert.match(lines[0], /^\[0:00\] Student \(paper_opened\): Opened/);
  assert.match(lines[1], /^\[0:04\] Tutor \(next_step; about "social simulacra"\): Say you're/);
  assert.match(lines[2], /highlighted \[p1\.s14\] with note "their fix"/);
  assert.match(lines[3], /^\[1:04\] Student: Because <friends>/);
});

test("the report page holds the analysis, the conversation and the pictures, safely escaped", () => {
  const html = reportHtml(report());
  for (const want of ["Social simulacra: prototyping with fake crowds", "Why small tests miss harms", "Reread section 4", "Sketch the pipeline from memory", "page 1", "data:image/jpeg;base64,AAAA", "What could the simulation never show?"])
    assert.ok(html.includes(want), want);
  assert.ok(html.includes("Because &lt;friends&gt; are polite"), "what was said is escaped");
  assert.ok(!html.includes("<friends>"));
  // the data rides along for other tools, without the pictures
  const data = JSON.parse(/<script type="application\/json" id="session-data">([\s\S]*?)<\/script>/.exec(html)![1]);
  assert.equal(data.journal.length, 3);
  assert.equal(data.journal[1].picture, undefined);
});

test("without an analysis the report still has the conversation", () => {
  const html = reportHtml(report({ analysis: null }));
  assert.ok(html.includes("could not be made"));
  assert.ok(html.includes("Say you&#39;re launching a forum"));
});

test("talk share counts words on each side", () => {
  const st = reportStats(report());
  assert.equal(st.minutes, 12);
  assert.equal(st.exchanges, 2);
  assert.equal(st.drawings, 1);
  assert.ok(st.youShare > 20 && st.youShare < 50);
});

test("the analysis schema takes a full answer", () => {
  assert.ok(reportAnalysisSchema.safeParse(report().analysis).success);
});
