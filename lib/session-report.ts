// A record of one study session: what was said on both sides, what the tutor
// drew and pointed at, and an analysis of how it went. It is kept as a single
// self-contained HTML file, so it opens anywhere, prints, and can be shared.

import { z } from "zod";

// One exchange in the conversation, in the order it happened.
export type JournalEntry = {
  at: number;
  who: "student" | "tutor";
  text: string;
  // what kind of moment it was: the student spoke, asked for help, opened a paper...
  trigger?: string;
  // the tutor's move ("point", "simpler_example"...) and the idea it was about
  move?: string;
  concept?: string;
  evidence?: string;
  // passages of the paper it highlighted, with its margin note
  highlights?: { ref: string; note: string | null; text: string; page: number }[];
  // what the board looked like when the tutor finished this turn (a JPEG data URL)
  picture?: string;
};

// What the analysis is asked to fill in.
export const reportAnalysisSchema = z.object({
  title: z.string().describe("A short name for the session, like a meeting title: what was studied (at most 8 words)"),
  summary: z.string().describe("Two or three sentences: what the session covered and where the student ended up"),
  topics: z
    .array(
      z.object({
        name: z.string().describe("A topic or idea the session touched, in the source's own terms"),
        understanding: z.number().describe("0 to 100: how well the student showed they understand it, judged only from what they said and did"),
        evidence: z.string().describe("One sentence: what in the conversation shows this"),
      }),
    )
    .describe("Three to seven topics, most important first"),
  strengths: z.array(z.object({ point: z.string(), evidence: z.string().describe("What the student said or did that shows it") })).describe("Two to four things the student did well"),
  weaknesses: z
    .array(z.object({ point: z.string(), evidence: z.string(), fix: z.string().describe("A concrete way to work on it") }))
    .describe("One to four gaps or misconceptions, kindly put; empty only if there truly were none"),
  next_session: z
    .array(z.object({ topic: z.string(), why: z.string(), activity: z.string().describe("What to do in the next session, e.g. 'explain the figure on page 4 from memory'") }))
    .describe("Two to four things to cover next time, most important first"),
  reread: z
    .array(z.object({ ref: z.string().describe("The id of the sentence to start from, exactly as tagged, like p3.s12"), what: z.string().describe("The part to reread, in a few words"), why: z.string() }))
    .describe("Passages of the reading to go back to, most useful first; empty when there was no reading"),
  notes: z
    .array(z.object({ heading: z.string(), points: z.array(z.string()).describe("Short note lines in plain words") }))
    .describe("Study notes of what was covered, as a student would want them to revise from: the main ideas, how they work, examples used"),
  key_terms: z.array(z.object({ term: z.string(), meaning: z.string() })).describe("Terms that came up, with a plain one-line meaning"),
  questions: z.array(z.string()).describe("Two or three questions to think about before the next session"),
});
export type ReportAnalysis = z.infer<typeof reportAnalysisSchema>;

// What the browser sends to be analysed.
export type ReportRequest = {
  startedAt: number;
  endedAt: number;
  problem: string;
  paper: { title: string; text: string } | null;
  journal: Omit<JournalEntry, "picture">[];
  concepts: Record<string, { slips: number; solved: number }>;
  cards: string[];
};

export const REPORT_PROMPT = `You write the end-of-session report for a student who has just studied with an AI tutor. They talked (by voice) and wrote by hand on a shared page; when reading a paper, the tutor highlighted passages and drew pictures to explain them.

You get the conversation in order, with what each side said, the tutor's teaching move and the idea each turn was about, the passages it highlighted, and the reading itself with every sentence tagged by id.

Write a report the student will use to revise and to plan the next session:
- Judge only from the conversation. Something the tutor explained is not something the student understood: understanding shows in what the student said, asked, predicted or explained back. If the student mostly listened, say so kindly and score understanding as unknown-to-middling, not high.
- Be specific: name the ideas in the reading's own terms and point at moments ("when you predicted the simulated members would be polite..."). No generic praise.
- Notes are revision notes of the content covered: the main ideas, how they work, the examples and pictures used. Plain sentences, no markdown.
- Reread: point at sentence ids that exist in the reading, where the student's gaps are. Prefer the sentence where the relevant passage starts.
- Next session: what would most move their understanding forward, as concrete activities.
- Write to the student as "you". Warm, direct, short.`;

// The conversation as the analysis reads it.
export function journalText(journal: ReportRequest["journal"]): string {
  const t0 = journal[0]?.at ?? 0;
  return journal
    .map((e) => {
      const min = Math.floor((e.at - t0) / 60000), sec = Math.floor(((e.at - t0) % 60000) / 1000);
      const when = `[${min}:${String(sec).padStart(2, "0")}]`;
      if (e.who === "student") return `${when} Student${e.trigger && e.trigger !== "spoke" ? ` (${e.trigger})` : ""}: ${e.text}`;
      const tags = [e.move, e.concept ? `about "${e.concept}"${e.evidence && e.evidence !== "none" ? `, page shows ${e.evidence}` : ""}` : ""].filter(Boolean).join("; ");
      const marks = (e.highlights ?? []).map((h) => `\n    highlighted [${h.ref}]${h.note ? ` with note "${h.note}"` : ""}`).join("");
      return `${when} Tutor${tags ? ` (${tags})` : ""}: ${e.text || "(said nothing)"}${marks}`;
    })
    .join("\n");
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export type SessionReport = {
  id: string;
  startedAt: number;
  endedAt: number;
  paper: { title: string } | null;
  problem: string;
  journal: JournalEntry[];
  board: string | null;
  analysis: ReportAnalysis | null;
  // sentence id -> its text and page, for the passages to reread
  passages: Record<string, { text: string; page: number }>;
  cards: string[];
};

export function reportTitle(r: SessionReport): string {
  return r.analysis?.title || r.paper?.title || r.problem.trim().slice(0, 60) || "Study session";
}

// Talk shares and counts for the dashboard tiles.
export function reportStats(r: SessionReport) {
  const words = (who: JournalEntry["who"]) => r.journal.filter((e) => e.who === who).reduce((n, e) => n + e.text.split(/\s+/).filter(Boolean).length, 0);
  const you = words("student"), tutor = words("tutor");
  return {
    minutes: Math.max(1, Math.round((r.endedAt - r.startedAt) / 60000)),
    exchanges: r.journal.filter((e) => e.who === "student").length,
    youWords: you,
    tutorWords: tutor,
    youShare: you + tutor ? Math.round((you / (you + tutor)) * 100) : 0,
    highlights: r.journal.reduce((n, e) => n + (e.highlights?.length ?? 0), 0),
    drawings: r.journal.filter((e) => e.picture).length,
    cards: r.cards.length,
  };
}

// The report as one HTML page: a dashboard of the analysis, then the whole
// conversation with what was on the board at each turn.
export function reportHtml(r: SessionReport): string {
  const a = r.analysis;
  const st = reportStats(r);
  const title = reportTitle(r);
  const date = new Date(r.startedAt);
  const when = date.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const t0 = r.journal[0]?.at ?? r.startedAt;
  const stamp = (at: number) => {
    const s = Math.max(0, Math.round((at - t0) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const tile = (label: string, value: string, sub = "") => `<div class="tile"><div class="tile-label">${esc(label)}</div><div class="tile-value">${value}</div>${sub ? `<div class="tile-sub">${sub}</div>` : ""}</div>`;
  const level = (n: number) => (n >= 75 ? "strong" : n >= 45 ? "mid" : "weak");
  const section = (id: string, heading: string, body: string, wide = false) => (body ? `<section class="card${wide ? " wide" : ""}" id="${id}"><h2>${esc(heading)}</h2>${body}</section>` : "");

  const topics = a?.topics.length
    ? `<div class="bars">${a.topics
        .map((t) => {
          const n = Math.max(0, Math.min(100, Math.round(t.understanding)));
          return `<div class="bar-row"><div class="bar-name">${esc(t.name)}</div><div class="bar-track"><div class="bar-fill ${level(n)}" style="width:${n}%"></div></div><div class="bar-num">${n}</div><div class="bar-why">${esc(t.evidence)}</div></div>`;
        })
        .join("")}</div>`
    : "";
  const list = (items: string[]) => (items.length ? `<ul class="items">${items.join("")}</ul>` : "");
  const strengths = list((a?.strengths ?? []).map((s) => `<li><strong>${esc(s.point)}</strong><span>${esc(s.evidence)}</span></li>`));
  const weaknesses = list((a?.weaknesses ?? []).map((w) => `<li><strong>${esc(w.point)}</strong><span>${esc(w.evidence)}</span><span class="fix">Try: ${esc(w.fix)}</span></li>`));
  const next = a?.next_session.length
    ? `<ol class="plan">${a.next_session.map((n) => `<li><strong>${esc(n.topic)}</strong><span>${esc(n.why)}</span><span class="fix">${esc(n.activity)}</span></li>`).join("")}</ol>`
    : "";
  const reread = list(
    (a?.reread ?? []).map((x) => {
      const p = r.passages[x.ref];
      return `<li><strong>${esc(x.what)}${p ? ` <span class="pill">page ${p.page}</span>` : ""}</strong>${p ? `<blockquote>${esc(p.text)}</blockquote>` : ""}<span>${esc(x.why)}</span></li>`;
    }),
  );
  const notes = a?.notes.length ? a.notes.map((n) => `<h3>${esc(n.heading)}</h3><ul class="notes">${n.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`).join("") : "";
  const terms = a?.key_terms.length ? `<dl class="terms">${a.key_terms.map((t) => `<dt>${esc(t.term)}</dt><dd>${esc(t.meaning)}</dd>`).join("")}</dl>` : "";
  const questions = a?.questions.length ? `<ul class="notes">${a.questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>` : "";
  const marked = r.journal.flatMap((e) => e.highlights ?? []);
  const highlights = marked.length
    ? `<ul class="items">${marked.map((h) => `<li><strong>${h.note ? esc(h.note) : "Highlighted"} <span class="pill">page ${h.page}</span></strong><blockquote>${esc(h.text)}</blockquote></li>`).join("")}</ul>`
    : "";

  const talk = r.journal
    .map((e) => {
      const marks = (e.highlights ?? []).map((h) => `<div class="hl"><span class="pill">page ${h.page}</span>${h.note ? `<em>${esc(h.note)}</em> ` : ""}“${esc(h.text)}”</div>`).join("");
      const pic = e.picture ? `<figure><img src="${e.picture}" alt="The board after this turn"></figure>` : "";
      const who = e.who === "student" ? "You" : "Tutor";
      const meta = e.who === "tutor" && e.concept ? `<span class="tag">${esc(e.concept)}</span>` : e.who === "student" && e.trigger && e.trigger !== "spoke" ? `<span class="tag">${esc(e.trigger.replace("_", " "))}</span>` : "";
      return `<div class="msg ${e.who}"><div class="msg-head"><span class="who">${who}</span><span class="time">${stamp(e.at)}</span>${meta}</div>${e.text ? `<p>${esc(e.text)}</p>` : ""}${marks}${pic}</div>`;
    })
    .join("");

  const data = JSON.stringify({ ...r, journal: r.journal.map(({ picture: _p, ...e }) => e), board: undefined }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#f6f4ef;--card:#fff;--ink:#1f2a44;--muted:#6b7280;--line:#e7e2d8;--tutor:#c2410c;--tutor-soft:#fdf0e8;--you:#1f2a44;--you-soft:#eef1f7;--strong:#15803d;--mid:#ca8a04;--weak:#c2410c;--hl:rgba(250,204,21,.35)}
@media (prefers-color-scheme:dark){:root{--bg:#14161b;--card:#1d2027;--ink:#e8e6e1;--muted:#9aa0aa;--line:#2c3039;--tutor:#f08a4b;--tutor-soft:#2b211b;--you:#c9d3ea;--you-soft:#222838;--strong:#4ade80;--mid:#facc15;--weak:#f08a4b;--hl:rgba(250,204,21,.22)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:28px 16px 64px}
header{display:flex;flex-wrap:wrap;gap:8px 24px;align-items:flex-end;justify-content:space-between;margin-bottom:20px}
.brand{font-family:"Segoe Print","Bradley Hand",cursive;color:var(--tutor);font-size:22px}
h1{margin:2px 0 0;font-size:28px;line-height:1.2}.sub{color:var(--muted)}
.summary{font-size:17px;max-width:820px;margin:0 0 20px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.tile-label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em}.tile-value{font-size:28px;font-weight:650;margin-top:2px}.tile-sub{color:var(--muted);font-size:13px}
.share{height:8px;border-radius:4px;background:var(--tutor-soft);overflow:hidden;margin-top:8px}.share>div{height:100%;background:var(--you)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px}.card.wide{grid-column:1/-1}
h2{margin:0 0 12px;font-size:15px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}h3{margin:14px 0 6px;font-size:16px}
.bars{display:grid;gap:12px}.bar-row{display:grid;grid-template-columns:minmax(120px,220px) 1fr 36px;gap:4px 12px;align-items:center}
.bar-name{font-weight:600}.bar-track{height:12px;background:var(--line);border-radius:6px;overflow:hidden}.bar-fill{height:100%;border-radius:6px}
.bar-fill.strong{background:var(--strong)}.bar-fill.mid{background:var(--mid)}.bar-fill.weak{background:var(--weak)}.bar-num{font-variant-numeric:tabular-nums;text-align:right;font-weight:600}
.bar-why{grid-column:1/-1;color:var(--muted);font-size:13px;margin-top:-2px}
.items,.plan{margin:0;padding:0;list-style:none;display:grid;gap:12px}.plan{counter-reset:n}.plan li{counter-increment:n;padding-left:34px;position:relative}
.plan li::before{content:counter(n);position:absolute;left:0;top:0;width:24px;height:24px;border-radius:50%;background:var(--tutor);color:#fff;font-size:13px;display:grid;place-items:center}
.items li,.plan li{display:flex;flex-direction:column;gap:2px}.items span,.plan span{color:var(--muted)}.fix{color:var(--ink)!important}
blockquote{margin:6px 0;padding:6px 10px;background:var(--hl);border-radius:6px;font-family:Georgia,serif;font-size:14px}
.pill{display:inline-block;font-size:11px;font-weight:600;padding:1px 7px;border-radius:9px;background:var(--you-soft);color:var(--you);vertical-align:middle;margin-right:4px}
.notes{margin:0;padding-left:20px}.notes li{margin:3px 0}
.terms{display:grid;grid-template-columns:max-content 1fr;gap:6px 14px;margin:0}.terms dt{font-weight:650}.terms dd{margin:0;color:var(--muted)}
.convo{display:flex;flex-direction:column;gap:12px}.msg{max-width:min(760px,92%);padding:10px 14px;border-radius:14px}
.msg.student{align-self:flex-end;background:var(--you-soft)}.msg.tutor{align-self:flex-start;background:var(--tutor-soft)}
.msg p{margin:4px 0}.msg-head{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--muted)}.who{font-weight:700;color:var(--ink)}.msg.tutor .who{color:var(--tutor)}
.tag{border:1px solid var(--line);border-radius:9px;padding:0 7px}
.hl{font-family:Georgia,serif;font-size:14px;background:var(--hl);border-radius:6px;padding:4px 8px;margin:6px 0}.hl em{font-family:system-ui,sans-serif;color:var(--tutor);font-style:normal;font-weight:600}
figure{margin:8px 0 2px}figure img{max-width:100%;border-radius:8px;border:1px solid var(--line);background:#fff;display:block}
.board img{max-width:100%;border-radius:10px;border:1px solid var(--line);background:#fff}
nav{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 16px}nav a{color:var(--ink);text-decoration:none;border:1px solid var(--line);background:var(--card);border-radius:16px;padding:4px 12px;font-size:13px}
.empty{color:var(--muted);font-style:italic}
@media print{body{background:#fff}nav{display:none}.card,.tile{break-inside:avoid}}
@media (max-width:560px){.bar-row{grid-template-columns:1fr 36px}.bar-track{grid-column:1/-1;order:3}h1{font-size:23px}}
</style></head>
<body><div class="wrap">
<header><div><div class="brand">Tutor · session report</div><h1>${esc(title)}</h1><div class="sub">${esc(when)}, ${esc(time)}${r.paper ? ` · Reading: <em>${esc(r.paper.title)}</em>` : ""}${r.problem.trim() && !r.paper ? ` · ${esc(r.problem.trim().slice(0, 80))}` : ""}</div></div></header>
${a ? `<p class="summary">${esc(a.summary)}</p>` : `<p class="summary empty">The analysis could not be made for this session; the conversation is below.</p>`}
<nav><a href="#analysis">Analysis</a>${notes ? `<a href="#notes">Notes</a>` : ""}${reread ? `<a href="#reread">Reread</a>` : ""}<a href="#conversation">Conversation</a>${r.board ? `<a href="#board">Board</a>` : ""}</nav>
<div class="tiles">
${tile("Time", `${st.minutes}<small style="font-size:15px"> min</small>`)}
${tile("Your turns", String(st.exchanges))}
${tile("You talked", `${st.youShare}%`, `<div class="share"><div style="width:${st.youShare}%"></div></div><div style="margin-top:4px">${st.youWords} words you · ${st.tutorWords} tutor</div>`)}
${tile("Drawings", String(st.drawings))}
${r.paper ? tile("Passages marked", String(st.highlights)) : ""}
${st.cards ? tile("Review cards", String(st.cards), esc(r.cards.join(", "))) : ""}
</div>
<div class="grid" id="analysis">
${section("topics", "Understanding by topic", topics, true)}
${section("strengths", "What went well", strengths)}
${section("weak", "What to work on", weaknesses)}
${section("next", "Next session", next)}
${section("questions", "To think about", questions)}
${section("reread", "Reread", reread, true)}
${section("notes", "Notes", notes, true)}
${section("terms", "Key terms", terms)}
${section("marked", "What the tutor highlighted", highlights)}
${section("conversation", "Conversation", `<div class="convo">${talk || `<p class="empty">Nothing was said this session.</p>`}</div>`, true)}
${r.board ? section("board", "The board at the end", `<div class="board"><img src="${r.board}" alt="The whole board at the end of the session"></div>`, true) : ""}
</div>
</div>
<script type="application/json" id="session-data">${data}</script>
</body></html>`;
}
