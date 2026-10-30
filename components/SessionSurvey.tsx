"use client";

import { useState } from "react";
import { logEvent, type Account } from "@/lib/cloud";

// Three quick ratings after a session, for the study. Skippable.
const QUESTIONS = [
  { id: "helpful", text: "How much did the tutor help you today?", low: "not at all", high: "a lot" },
  { id: "ownership", text: "How much did you figure things out yourself?", low: "it did it", high: "I did" },
  { id: "natural", text: "How natural did working with it feel?", low: "awkward", high: "natural" },
] as const;

export default function SessionSurvey({ account, sessionId }: { account: Account; sessionId: string }) {
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [note, setNote] = useState("");
  const [sent, setSent] = useState(false);

  if (sent) return <p className="survey detail">Thanks, that helps the study.</p>;
  const send = () => {
    logEvent(account, "survey", { ...ratings, note: note.trim().slice(0, 1000), condition: account.condition }, sessionId);
    setSent(true);
  };
  return (
    <div className="survey">
      {QUESTIONS.map((q) => (
        <div key={q.id}>
          <p>{q.text}</p>
          <div className="scale" role="radiogroup" aria-label={q.text}>
            <span>{q.low}</span>
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                role="radio"
                aria-checked={ratings[q.id] === n}
                className={ratings[q.id] === n ? "on" : ""}
                onClick={() => setRatings((r) => ({ ...r, [q.id]: n }))}
              >
                {n}
              </button>
            ))}
            <span>{q.high}</span>
          </div>
        </div>
      ))}
      <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything that got in the way? (optional)" />
      <button onClick={send} disabled={!Object.keys(ratings).length && !note.trim()}>
        Send answers
      </button>
    </div>
  );
}
