"use client";

// The researcher's panel for study sessions: the session recording, a human
// tutor through the tutor pen, the tutor's manners for this session, and a
// solo session run as timed blocks with ratings after each.

import { useState } from "react";
import { MANNER_INFO, MANNER_LABEL, MANNERS, type MannerKey, type Manners } from "@/lib/manners";

export type RoomInfo = { code: string; status: string; guest: string | null; call: string | null; offsetMs: number | null; link: string };
export type BlockRun = { order: BlockKind[]; minutes: number; index: number; endsAt: number };
export type BlockKind = "standard" | MannerKey;
export const BLOCK_LABEL: Record<BlockKind, string> = { standard: "Standard tutor", ...MANNER_LABEL };

type Props = {
  manners: Manners;
  onManners: (m: Manners) => void;
  recordVoice: boolean;
  onRecordVoice: (on: boolean) => void;
  recording: { id: string; events: number; savedAt: number | null; error: string | null } | null;
  onSaveNow: () => void;
  onDownload: () => void;
  room: RoomInfo | null;
  onOpenRoom: () => void;
  onCloseRoom: () => void;
  blocks: BlockRun | null;
  onStartBlocks: (order: BlockKind[], minutes: number) => void;
  onEndBlock: () => void;
  onStopBlocks: () => void;
  cloud: boolean;
  onClose: () => void;
};

const KINDS: BlockKind[] = ["standard", ...MANNERS];

export default function StudyToolsPanel(p: Props) {
  const [order, setOrder] = useState<BlockKind[]>(["standard", "overLine", "inkAtOnce"]);
  const [minutes, setMinutes] = useState(12);
  const [copied, setCopied] = useState(false);
  const running = Boolean(p.blocks);

  return (
    <aside className="panel tools-panel" aria-label="Study session tools">
      <div className="panel-head">
        <h2>Session</h2>
        <button onClick={p.onClose} aria-label="Close">
          Close
        </button>
      </div>

      <h3>Recording</h3>
      <p className="detail">
        Every stroke, phrase, trigger and interruption is recorded on one clock{p.cloud ? " and saved to the study's private storage" : " and kept on this device"}.
      </p>
      {p.recording && (
        <p className="detail">
          {p.recording.events} events{p.recording.savedAt ? `, saved ${new Date(p.recording.savedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}` : ""}
          {p.recording.error ? <span className="warn"> · {p.recording.error}</span> : null}
        </p>
      )}
      <label className="switch">
        <input type="checkbox" checked={p.recordVoice} onChange={(e) => p.onRecordVoice(e.target.checked)} />
        Record the learner&apos;s voice
      </label>
      <div className="row">
        <button onClick={p.onSaveNow}>Save now</button>
        <button onClick={p.onDownload}>Download</button>
        <a className="menu-link" href="/replay" target="_blank" rel="noopener">
          Replay
        </a>
      </div>

      <h3>Human tutor</h3>
      {p.room ? (
        <>
          <p>
            Room <strong className="code">{p.room.code}</strong> · {p.room.guest ? `${p.room.guest} is here` : p.room.status === "open" ? "waiting for the tutor" : p.room.status}
            {p.room.call ? ` · voice ${p.room.call}` : ""}
          </p>
          <p className="detail">The AI tutor is off while the room is open. On the tutor&apos;s device, open:</p>
          <div className="row">
            <input className="link-box" readOnly value={p.room.link} onFocus={(e) => e.target.select()} />
            <button
              onClick={() => {
                navigator.clipboard?.writeText(p.room!.link).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          {p.room.offsetMs != null && <p className="detail">Clocks matched (offset {p.room.offsetMs} ms).</p>}
          <button onClick={p.onCloseRoom}>End tutor session</button>
        </>
      ) : (
        <>
          <p className="detail">A person tutors from another device: they see this page live, write in tutor ink and talk. Both are recorded on this session&apos;s clock.</p>
          <button onClick={p.onOpenRoom} disabled={running}>
            Invite a tutor
          </button>
        </>
      )}

      <h3>Tutor manners</h3>
      <p className="detail">Turn one off for this session. The default keeps them all.</p>
      {MANNERS.map((k) => (
        <label key={k} className="switch" title={MANNER_INFO[k].broken}>
          <input type="checkbox" checked={p.manners[k]} disabled={running || Boolean(p.room)} onChange={(e) => p.onManners({ ...p.manners, [k]: e.target.checked })} />
          <span>
            {MANNER_LABEL[k]}
            <span className="detail block">{MANNER_INFO[k][p.manners[k] ? "broken" : "kept"]}</span>
          </span>
        </label>
      ))}

      <h3>Solo session in blocks</h3>
      {p.blocks ? (
        <>
          <p>
            Block {p.blocks.index + 1} of {p.blocks.order.length}: {BLOCK_LABEL[p.blocks.order[p.blocks.index]]}
          </p>
          <p className="detail">Ends at {new Date(p.blocks.endsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}, then the learner rates it.</p>
          <div className="row">
            <button onClick={p.onEndBlock}>End block now</button>
            <button className="danger" onClick={p.onStopBlocks}>
              Stop
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="detail">Each block starts a fresh page and its own recording. Set this participant&apos;s order:</p>
          {order.map((kind, i) => (
            <div className="row" key={i}>
              <span className="detail">{i + 1}.</span>
              <select value={kind} onChange={(e) => setOrder(order.map((o, j) => (j === i ? (e.target.value as BlockKind) : o)))}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {BLOCK_LABEL[k]}
                  </option>
                ))}
              </select>
              {order.length > 1 && (
                <button className="link" onClick={() => setOrder(order.filter((_, j) => j !== i))} aria-label="Remove block">
                  Remove
                </button>
              )}
            </div>
          ))}
          <div className="row">
            {order.length < 5 && (
              <button className="link" onClick={() => setOrder([...order, "standard"])}>
                Add a block
              </button>
            )}
            <label className="detail">
              Minutes each{" "}
              <input className="minutes" type="number" min={1} max={60} value={minutes} onChange={(e) => setMinutes(Math.max(1, Math.min(60, Number(e.target.value) || 12)))} />
            </label>
          </div>
          <button className="primary" onClick={() => p.onStartBlocks(order, minutes)} disabled={Boolean(p.room)}>
            Start blocks
          </button>
        </>
      )}
    </aside>
  );
}

// After each block: four ratings from 1 to 7 and two questions (from the study protocol).
export const BLOCK_ITEMS = [
  ["control", "I felt in control of my own work."],
  ["in_my_way", "The tutor got in my way."],
  ["mine", "The work on the page feels like mine."],
  ["right_moments", "The tutor acted at the right moments."],
] as const;
export const BLOCK_QUESTIONS = [
  ["liked", "What did this tutor do that you liked?"],
  ["bothered", "What did it do that bothered you?"],
] as const;

export function BlockSurvey({ n, of, onSubmit }: { n: number; of: number; onSubmit: (r: { ratings: Record<string, number>; answers: Record<string, string> }) => void }) {
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const done = BLOCK_ITEMS.every(([k]) => ratings[k]);
  return (
    <form
      className="keep survey block-survey"
      onSubmit={(e) => {
        e.preventDefault();
        if (done) onSubmit({ ratings, answers });
      }}
    >
      <h2>
        That&apos;s part {n} of {of}
      </h2>
      <p className="detail">How much do you agree? 1 is not at all, 7 is completely.</p>
      {BLOCK_ITEMS.map(([k, text]) => (
        <div key={k} className="item">
          <span>{text}</span>
          <div className="scale" role="group" aria-label={text}>
            {[1, 2, 3, 4, 5, 6, 7].map((v) => (
              <button type="button" key={v} className={ratings[k] === v ? "on" : ""} onClick={() => setRatings({ ...ratings, [k]: v })} aria-pressed={ratings[k] === v}>
                {v}
              </button>
            ))}
          </div>
        </div>
      ))}
      {BLOCK_QUESTIONS.map(([k, text]) => (
        <label key={k}>
          {text}
          <textarea rows={2} value={answers[k] ?? ""} onChange={(e) => setAnswers({ ...answers, [k]: e.target.value })} />
        </label>
      ))}
      <div className="keep-actions">
        <button className="primary" type="submit" disabled={!done}>
          {n < of ? "Next part" : "Done"}
        </button>
      </div>
    </form>
  );
}
