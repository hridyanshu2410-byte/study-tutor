"use client";

import { useActionState, useRef } from "react";
import type { TestPhase } from "@/lib/study";
import { submitQuiz } from "./actions";

type Item = { id: string; prompt: string; choices: string[] };

export default function QuizForm({ phase, items }: { phase: TestPhase; items: Item[] }) {
  const [error, action, pending] = useActionState(submitQuiz, null);
  const started = useRef(Date.now());
  return (
    <form className="auth-form quiz" action={action}>
      <input type="hidden" name="phase" value={phase} />
      <input type="hidden" name="started" value={started.current} />
      {items.map((it, n) => (
        <fieldset key={it.id}>
          <legend>
            {n + 1}. {it.prompt}
          </legend>
          {it.choices.map((c, i) => (
            <label key={i} className="check">
              <input type="radio" name={it.id} value={i} /> {c}
            </label>
          ))}
          <label className="check skip">
            <input type="radio" name={it.id} value="" defaultChecked /> I don&apos;t know
          </label>
        </fieldset>
      ))}
      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={pending}>
        {pending ? "Saving…" : "Done"}
      </button>
    </form>
  );
}
