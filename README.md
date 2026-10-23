# Tutor

A private tutor on an infinite page. You work a problem by hand with an Apple Pencil, a stylus, a finger or a mouse; the tutor watches, talks to you, and writes in the margin in its own handwriting. It is built to make you do the hard part: it waits while you are on track, points at the line where a mistake starts, and climbs a hint ladder one rung at a time instead of handing over the answer.

The full plan (pedagogy, architecture, roadmap) lives in the project doc: [Study Tutor: Architecture and Plan](https://claude.ai/code/artifact/54c9fb88-e4fc-4f6a-bef3-8d65961628bb).

## Run it

```bash
npm install
cp .env.example .env.local   # add ANTHROPIC_API_KEY, or OPENAI_API_KEY to run the tutor on GPT-6 Luna
npm run dev                   # http://localhost:3000
```

That runs the tutor on one device with everything saved in the browser. To put it online for research testers, with sign-up, consent, cloud saving and a researcher dashboard, follow [DEPLOY.md](DEPLOY.md).

To use it on an iPad, run `npm run dev -- -H 0.0.0.0` and open your computer's local address in Safari. Voice input needs HTTPS or localhost, so for the microphone on a tablet use a tunnel such as `cloudflared tunnel --url http://localhost:3000`.

## Using it

- **Write** anywhere. With a pen in use, fingers only pan and pinch-zoom (palm rejection). With a mouse, drag to write, hold Space or right-drag to pan, Ctrl/Cmd + scroll to zoom.
- **Just talk and write.** The mic turns on with your first touch of the page (Mic off turns it off). The tutor glances at your work a moment after your pen lifts, and mostly stays quiet while you're on track. It answers when you finish a sentence, and writes the math it says, or sketches a graph, number line, triangle, table, flow or force diagram, as it talks. Tap the dot beside its words to interrupt.
- **Double-tap** part of your work to point at it ("what about this?"). **Scribble** over a stroke to erase it.
- **I'm stuck** asks for help now. **Finish** wraps up with a recap, your stats, and Save notes.
- **Add photo** puts a photo, screenshot or PDF of a worksheet under your ink, so you can write on it and the tutor reads it too.
- **Study a paper** opens a research paper (a PDF with a text layer, up to 30 pages) beside a blank work area, and the tutor reads it with you. It opens with the gist and a big-picture diagram, then talks it through: it highlights and underlines the passages it means, writes margin notes with arrows to them, and explains by drawing flowcharts, bar charts of the results, tables, graphs and labelled sketches in the space beside the paper. It asks for your read first and invites you to sketch your own picture. Double-tap a sentence to ask about it. The paper stays on this device and comes back when you reload.
- **Simulations**: for projectile and pendulum questions the tutor can set one up on the page. Mark your prediction, tap play, and it runs at real speed with the real physics; then the tutor asks you to explain what you saw.
- **Keep** (`k`): draw a loop around some of your writing to save it as a review card. You type the question it should ask you later; the circled ink is the answer side.
- **Review** shows how many cards are due and a mastery map of the concepts the tutor has seen you work on. Start review clears to a fresh page and asks each card by hand, from memory. The tutor helps less than usual, grades the attempt and suggests Again, Hard, Good or Easy; you can change it, or use Show answer to grade yourself.
- When the tutor helps you fix a real misconception, it saves a card for it on its own: a fresh problem of the same kind, plus a one-line takeaway shown after you answer.
- **Import a deck** in the Review panel reads an Anki `.apkg` export. Each note becomes a card (cloze gaps become `[...]`), and the back is used as the reference answer.
- Keys: `p` pen, `e` eraser, `h` move, `k` keep, `Ctrl/Cmd+Z` undo.

## How it works

| Piece | Where |
| --- | --- |
| Canvas, pen input, palm rejection, tutor ink rendering | `components/StudyCanvas.tsx` |
| Ink geometry: lines, tokens, camera, hit testing | `lib/ink.ts` |
| Tutor pen: circles, underlines, strikes, arrows, handwritten notes | `lib/handwriting.ts` |
| Tutor handwriting (single-stroke EMS Felix, OFL) | `lib/tutor-hand/` |
| Tutor prompt, hint ladder, response schema | `lib/tutor.ts` |
| Figures the tutor sketches, and the safe formula reader for graphs | `lib/figure-schema.ts`, `lib/figures.ts`, `lib/expr.ts` |
| Math checker that catches slips in the tutor's and student's steps | `lib/check.ts` |
| Projectile and pendulum simulations | `lib/sims.ts` |
| Photo and PDF pages under the ink | `lib/photo.ts` |
| Paper mode: sentences with ids and boxes, the text the tutor reads, PDF opening, saving on this device | `lib/paper.ts`, `lib/paper-pdf.ts`, `lib/paper-store.ts` |
| Study arms, quizzes and their items | `lib/study.ts`, `lib/study-tests.ts`, `app/quiz/` |
| Tutor API route (Claude or OpenAI, structured output) | `app/api/tutor/route.ts` |
| Browser voice in and out | `lib/voice.ts` |
| Review cards, FSRS scheduling, mastery map | `lib/review.ts` |
| Where cards and mastery are saved (this device for now) | `lib/memory-store.ts` |
| Review panel: due cards, mastery, deck import | `components/ReviewPanel.tsx` |
| Anki `.apkg` reader | `lib/anki.ts` |
| Research mode: sign-up, consent, account menu | `app/login/`, `app/consent/`, `components/AccountMenu.tsx`, `proxy.ts` |
| Cloud saving and study event logging | `lib/cloud.ts`, `app/api/tutor/route.ts` |
| Researcher dashboard and CSV export | `app/admin/`, `lib/research.ts` |
| Database schema and privacy rules | `supabase/migrations/` |
| Optional natural voice (OpenAI TTS) | `app/api/voice/route.ts` |

On each turn the browser groups your strokes into lines (L1, L2, …) and splits each line into tokens at the gaps between symbols. It sends two images to `/api/tutor`: your page as written, and the same page with each token boxed and numbered. Claude returns a structured turn: a private part (its reading of each line, the first wrong line, its diagnosis and the full solution) and a public part (the move, what to say, and the ink to add). Only the public part ever leaves the server, so the answer cannot leak into the page before the tutor decides to give it.

The ink is a list such as "circle tokens 4 to 7 of L2, then a note to the right with an arrow". `lib/handwriting.ts` turns that into timed pen strokes: a loop that starts at the upper left and overshoots, a bowed arrow with a flicked head, and words written glyph by glyph from a single-stroke font with a drifting baseline and small changes in size and slant. The canvas reveals each stroke at hand speed with pressure simulated from pen speed, while the tutor speaks.

### Review and mastery

Scheduling is FSRS through [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) (MIT), the same algorithm modern Anki uses; no Anki code is included. The `.apkg` reader is our own: it unzips the export, decompresses the newer zstd collection if present, and reads notes with SQLite in the browser ([sql.js](https://github.com/sql-js/sql.js), MIT). Imported cards start fresh rather than keeping their Anki schedule.

Each tutor turn also reports the concept the moment is about and whether the page shows a slip, progress or a solved step. That evidence (counted once per session) and how well each concept's cards are being recalled make up the mastery percentage. The weakest concepts go back to the tutor on every turn so it can watch for them.

## Scripts

- `npm test` runs the ink and handwriting tests.
- `npm run typecheck` and `npm run build` check the app.

## Not yet

Canvas and Moodle import and the study planner are later phases in the plan. The tutor's turn-by-turn memory within a session is in-process, so a server restart mid-session starts the hint ladder over (pages, cards and mastery are saved).
