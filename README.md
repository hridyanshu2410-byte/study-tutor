# Tutor

A private tutor on an infinite page. You work a problem by hand with an Apple Pencil, a stylus, a finger or a mouse; the tutor watches, talks to you, and writes in the margin in its own handwriting. It is built to make you do the hard part: it waits while you are on track, points at the line where a mistake starts, and climbs a hint ladder one rung at a time instead of handing over the answer.

The full plan (pedagogy, architecture, roadmap) lives in the project doc: [Study Tutor: Architecture and Plan](https://claude.ai/code/artifact/54c9fb88-e4fc-4f6a-bef3-8d65961628bb).

## Run it

```bash
npm install
cp .env.example .env.local   # add your ANTHROPIC_API_KEY
npm run dev                   # http://localhost:3000
```

To use it on an iPad, run `npm run dev -- -H 0.0.0.0` and open your computer's local address in Safari. Voice input needs HTTPS or localhost, so for the microphone on a tablet use a tunnel such as `cloudflared tunnel --url http://localhost:3000`.

## Using it

- **Write** anywhere. With a pen in use, fingers only pan and pinch-zoom (palm rejection). With a mouse, drag to write, hold Space or right-drag to pan, Ctrl/Cmd + scroll to zoom.
- **Pause** for about three seconds and the tutor looks at your work. Most of the time it stays quiet, because you are on track.
- **I'm stuck** asks for help now. **Talk** lets you ask out loud.
- Keys: `p` pen, `e` eraser, `h` move, `Ctrl/Cmd+Z` undo.

## How it works

| Piece | Where |
| --- | --- |
| Canvas, pen input, palm rejection, tutor ink animation | `components/StudyCanvas.tsx` |
| Ink geometry: lines, camera, hit testing | `lib/ink.ts` (tests in `lib/ink.test.ts`) |
| Tutor prompt, hint ladder, response schema | `lib/tutor.ts` |
| Tutor API route (Claude, structured output) | `app/api/tutor/route.ts` |
| Browser voice in and out | `lib/voice.ts` |

On each turn the browser groups your strokes into lines (L1, L2, …), renders them as an image with those labels, and sends it to `/api/tutor`. Claude returns a structured turn: a private part (its reading of each line, the first wrong line, its diagnosis and the full solution) and a public part (the move, what to say, what to write, which line to mark). Only the public part ever leaves the server, so the answer cannot leak into the page before the tutor decides to give it.

## Scripts

- `npm test` runs the ink geometry tests.
- `npm run typecheck` and `npm run build` check the app.

## Not yet

Accounts and sync, mastery tracking and spaced review, Canvas and Moodle import, the study planner, and a custom single-stroke tutor hand are later phases in the plan. Session memory is in-process for now and resets when the server restarts.
