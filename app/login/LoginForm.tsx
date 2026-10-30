"use client";

import { useState } from "react";
import { browserClient } from "@/lib/supabase/client";

type View = "signin" | "signup" | "forgot";

export default function LoginForm({ needsInvite, linkError }: { needsInvite: boolean; linkError: boolean }) {
  const [view, setView] = useState<View>("signup");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(linkError ? "That link has expired or was already used. Sign in, or ask for a new one." : null);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    setBusy(true);
    setMessage(null);
    try {
      if (view === "signup") {
        const res = await fetch("/api/signup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password, invite: form.get("invite") }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        if (data.confirm) setMessage(`Check ${email} for a link to confirm your account.`);
        else window.location.assign("/consent");
      } else if (view === "signin") {
        const { error } = await browserClient().auth.signInWithPassword({ email, password });
        if (error) throw error;
        window.location.assign("/");
      } else {
        const { error } = await browserClient().auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/auth/callback?type=recovery`,
        });
        if (error) throw error;
        setMessage(`If ${email} has an account, a reset link is on its way.`);
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="auth-form" onSubmit={submit}>
      <div className="auth-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={view === "signup"} className={view === "signup" ? "on" : ""} onClick={() => setView("signup")}>
          Join the study
        </button>
        <button type="button" role="tab" aria-selected={view === "signin"} className={view === "signin" ? "on" : ""} onClick={() => setView("signin")}>
          Sign in
        </button>
      </div>
      <label>
        Email
        <input name="email" type="email" autoComplete="email" required />
      </label>
      {view !== "forgot" && (
        <label>
          Password
          <input
            name="password"
            type="password"
            autoComplete={view === "signup" ? "new-password" : "current-password"}
            minLength={view === "signup" ? 8 : undefined}
            required
          />
        </label>
      )}
      {view === "signup" && needsInvite && (
        <label>
          Invite code
          <input name="invite" autoComplete="off" required />
        </label>
      )}
      <button className="primary" type="submit" disabled={busy}>
        {busy ? "One moment…" : view === "signup" ? "Create account" : view === "signin" ? "Sign in" : "Send reset link"}
      </button>
      {view === "signin" && (
        <button type="button" className="link" onClick={() => setView("forgot")}>
          Forgot your password?
        </button>
      )}
      {message && (
        <p className="auth-message" role="status">
          {message}
        </p>
      )}
    </form>
  );
}
