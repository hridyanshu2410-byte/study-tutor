"use client";

import { useState } from "react";
import { browserClient } from "@/lib/supabase/client";

export default function ResetPage() {
  const [message, setMessage] = useState<string | null>(null);
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get("password") ?? "");
    const { error } = await browserClient().auth.updateUser({ password });
    if (error) setMessage(error.message);
    else window.location.assign("/");
  };
  return (
    <main className="auth">
      <form className="auth-card auth-form" onSubmit={submit}>
        <h1 className="brand">Tutor</h1>
        <label>
          New password
          <input name="password" type="password" autoComplete="new-password" minLength={8} required />
        </label>
        <button className="primary" type="submit">
          Save password
        </button>
        {message && <p className="auth-message">{message}</p>}
      </form>
    </main>
  );
}
