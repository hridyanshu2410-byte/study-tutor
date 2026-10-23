"use client";

import { useActionState } from "react";
import { giveConsent } from "./actions";

export default function ConsentForm({ levels, aiUse }: { levels: string[]; aiUse: string[] }) {
  const [error, action, pending] = useActionState(giveConsent, null);
  return (
    <form className="auth-form" action={action}>
      <h2>About your studies</h2>
      <label>
        Where are you studying?
        <select name="level" required defaultValue="">
          <option value="" disabled>
            Choose one
          </option>
          {levels.map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
      </label>
      <label>
        Which course will you use it for? (optional)
        <input name="course" placeholder="e.g. Calculus I" maxLength={120} />
      </label>
      <label>
        How often do you use AI tools like ChatGPT for studying?
        <select name="aiUse" required defaultValue="">
          <option value="" disabled>
            Choose one
          </option>
          {aiUse.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
      </label>
      <label className="check">
        <input type="checkbox" name="adult" required /> I am 18 or older.
      </label>
      <label className="check">
        <input type="checkbox" name="agree" required /> I've read the above and agree to take part.
      </label>
      <button className="primary" type="submit" disabled={pending}>
        {pending ? "Saving…" : "Start studying"}
      </button>
      {error && (
        <p className="auth-message" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
