# Running study sessions

Three tools for the DIS study with human tutors: a session recorder with a replay tool, a tutor pen for a human tutor on a second device, and switches that turn off one of the AI tutor's manners. They are for the researcher; testers never see them unless you open them.

## Opening the tools

The **Session** button sits in the top bar. It is always there when the app runs without Supabase (on your laptop). In research mode it shows for accounts in `ADMIN_EMAILS`, or on any device after opening the app once with `?tools=1` in the address (for the participant's iPad, which is signed in as the participant). `?tools=0` hides it again.

## What gets recorded

Every session is recorded on one clock, starting when the page opens and ending when a new page, a new problem, a new block or a tutor session begins:

- every stroke by the learner, the AI tutor and the human tutor, with the time of each point;
- every erase and undo, and every double tap that points at something;
- every phrase the AI tutor says, with its start and end, and the ink drawn with it;
- each trigger (a glance after a pause, the learner speaking, asking), the model call, each phrase as the model sent it, and how long the turn took;
- each interruption, and turns dropped because the learner started talking;
- the learner's words as the browser heard them, with when they started and ended;
- where the learner's view was, about four times a second while it moves.

On this device the last 40 sessions are kept in the browser. In research mode each session also goes to the private `recordings` bucket in Supabase, in a folder per tester and session, as `session.json`. Testers can write only to their own folder and cannot read anything back.

**Voice.** Tick *Record the learner's voice* in the panel to record the microphone for this and later sessions. The recording is a separate file (`student.webm`) in the same private folder, never in the events table. In a tutor session the human tutor's voice is recorded on their device; in research mode it goes to the bucket under their account, otherwise their browser downloads it when the session ends.

**Download** saves the session file and any voice files. **Replay** opens the replay tool.

## A pair session (a human tutor)

1. On the learner's device, open **Session**, tick voice recording if the protocol calls for it, and press **Invite a tutor**. The AI tutor turns off.
2. Copy the link and open it on the tutor's device. The tutor types their tutor code and joins, allowing the microphone.
3. The tutor sees the learner's page live, with a dashed box for what the learner has on screen. *Follow learner* keeps that view; touching the page to move or zoom turns it off. They write in orange with the pen, rub out their own ink with the eraser, and talk through a voice call between the two devices. Headphones on both sides stop echo.
4. When the session is over, press **End tutor session** on the learner's device. The tutor's device saves the tutor's voice and leaves.

Both devices log on the learner's clock: the tutor's device measures the offset with a few round trips when it joins and every ten seconds after, and the panel shows when the clocks are matched.

**Where the link works.** With Supabase configured the devices talk through Supabase Realtime, so they can be anywhere. Without it (on your laptop) they talk through the app's own server, so both devices must reach the laptop: the tutor's device opens `http://<laptop address>:3000/tutor-pen?room=…`. Microphones need HTTPS or localhost, so for a second device use a tunnel such as `cloudflared tunnel --url http://localhost:3000` and open the tunnel's address on both devices.

## A solo session (the AI tutor in blocks)

1. On the learner's device open **Session**, and under *Solo session in blocks* set this participant's order, for example *Standard tutor*, *Write over the learner's line*, *Ink appears all at once*, and the minutes per block (12 by default).
2. Press **Start blocks**. Each block starts a fresh page and its own recording, with that block's manner switched off.
3. When the time is up (or you press *End block now*), the tutor stops and the learner rates the block: four statements from 1 to 7 and the two questions. The answers are saved in that block's recording and, in research mode, as a `block_survey` event.
4. After the last block the tutor goes back to its usual manners.

The four switches, which can also be set one at a time in the panel or with `?break=overLine,inkAtOnce` in the address:

| Switch | What changes |
| --- | --- |
| Write over the learner's line | Notes and written math go on top of the learner's newest line instead of below or beside it. |
| Write the next step itself | The hint ladder is off: the tutor writes the next line of the learner's solution itself whenever they pause or are stuck. |
| Speak at once, no pause | The tutor glances 0.3 s after any pen lift, even mid-stroke, and talks even when the learner has started speaking. |
| Ink appears all at once | Each phrase's ink appears complete the moment the phrase starts, instead of being written stroke by stroke. |

## Replay

`/replay` lists the sessions on this device and, for researchers in research mode, every session in the bucket by participant code. You can also open a downloaded `.coink.json` with its voice files.

- **Play**, the slider, the speed menu, and the arrow keys move through the session; the strokes, both voices and the record on the right stay in step. Click a line in the record to jump to it.
- **Learner's view** shows exactly what the learner had on screen.
- **Mark error** (key E) marks the moment of an error, for the error-to-act count. **Note** (key M) adds a free note. Marks are saved with the session on this device; for other files, download the file to keep them.
- **Counts** shows the four counts the paper takes from each recording, and **Counts CSV** downloads them as one row:
  - where each tutor mark lands: on the learner's line, beside it, near it, apart from it, or on a blank page;
  - for each line of writing on the page, whether the learner or the tutor wrote on it first;
  - for each marked error, the time to the tutor's next act (its words, not the filler said while thinking, its ink, or the human tutor's strokes and words);
  - how often the tutor stopped within a second when the learner put pen down or started speaking while the tutor was speaking or writing.

  These are proxies computed from the record; `lib/session-measures.ts` says exactly how each is computed, so the paper can describe them as such.
- **Events CSV** gives one row per event.

## Setting up storage

Run `supabase/migrations/20261111000000_session_recordings.sql` in the Supabase SQL editor after the two earlier migrations (see DEPLOY.md). It creates the private bucket, the rules that let testers write only to their own folder, and the `block_survey` event kind.
