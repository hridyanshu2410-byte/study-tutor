"use client";

import { useState, type RefObject } from "react";
import { browserClient } from "@/lib/supabase/client";
import { logEvent, type Account } from "@/lib/cloud";

type Props = { account: Account; sessionId: RefObject<string>; onSignOut: () => Promise<void> };

export default function AccountMenu({ account, sessionId, onSignOut }: Props) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"menu" | "feedback" | "delete">("menu");
  const [rating, setRating] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  const close = () => {
    setOpen(false);
    setView("menu");
    setStatus(null);
  };

  const signOut = async () => {
    await onSignOut();
    await browserClient().auth.signOut();
    window.location.assign("/login");
  };

  const sendFeedback = () => {
    if (!rating && !note.trim()) return;
    logEvent(account, "feedback", { rating, note: note.trim().slice(0, 2000) }, sessionId.current);
    setRating(null);
    setNote("");
    setStatus("Thank you. This really helps.");
    setView("menu");
  };

  const deleteAccount = async () => {
    setStatus("Deleting…");
    const res = await fetch("/api/account", { method: "DELETE" });
    if (!res.ok) {
      setStatus((await res.json().catch(() => null))?.error ?? "Couldn't delete your account. Please try again.");
      return;
    }
    for (const k of Object.keys(localStorage)) if (k.includes(account.userId)) localStorage.removeItem(k);
    await browserClient().auth.signOut();
    window.location.assign("/login");
  };

  return (
    <div className="account">
      <button className={open ? "on" : ""} onClick={() => (open ? close() : setOpen(true))} aria-expanded={open}>
        {account.participantCode}
      </button>
      {open && (
        <div className="account-menu" role="menu">
          {view === "menu" && (
            <>
              <p className="detail">
                Signed in as {account.email}
                <br />
                Participant {account.participantCode}
              </p>
              {account.postQuiz && (
                <a role="menuitem" className="menu-link" href="/quiz/post">
                  Take the final quiz
                </a>
              )}
              <button role="menuitem" onClick={() => setView("feedback")}>
                Send feedback
              </button>
              {account.admin && (
                <a role="menuitem" className="menu-link" href="/admin">
                  Researcher view
                </a>
              )}
              <button role="menuitem" onClick={signOut}>
                Sign out
              </button>
              <button role="menuitem" className="danger" onClick={() => setView("delete")}>
                Delete my account and data
              </button>
              {status && <p className="detail">{status}</p>}
            </>
          )}
          {view === "feedback" && (
            <>
              <p className="detail">How did the tutor feel today?</p>
              <div className="rating" role="radiogroup" aria-label="Rating from 1 to 5">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} role="radio" aria-checked={rating === n} className={rating === n ? "on" : ""} onClick={() => setRating(n)}>
                    {n}
                  </button>
                ))}
              </div>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="What worked, what was annoying, what you wish it did…" rows={4} />
              <div className="keep-actions">
                <button onClick={() => setView("menu")}>Back</button>
                <button className="primary" onClick={sendFeedback}>
                  Send
                </button>
              </div>
            </>
          )}
          {view === "delete" && (
            <>
              <p>This deletes your account, your pages, your cards and everything logged for the study. It can&apos;t be undone.</p>
              <div className="keep-actions">
                <button onClick={() => setView("menu")}>Cancel</button>
                <button className="danger-solid" onClick={deleteAccount}>
                  Delete everything
                </button>
              </div>
              {status && <p className="detail">{status}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
