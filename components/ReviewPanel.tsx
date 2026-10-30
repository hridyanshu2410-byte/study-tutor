"use client";

import { useRef, useState } from "react";
import type { AnkiNote } from "@/lib/anki";
import { masteryMap, whenText, type StudyMemory } from "@/lib/review";

type Props = {
  memory: StudyMemory;
  due: number;
  storageFull: boolean;
  onStart: () => void;
  onImport: (notes: AnkiNote[], fileName: string) => number;
  onClose: () => void;
};

export default function ReviewPanel({ memory, due, storageFull, onStart, onImport, onClose }: Props) {
  const now = new Date();
  const concepts = masteryMap(memory, now);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState<string | null>(null);

  const importFile = async (file: File) => {
    setImporting("Reading your deck…");
    try {
      const notes = await loadApkg(file);
      const added = onImport(notes, file.name.replace(/\.apkg$/i, ""));
      setImporting(added ? `Added ${added} cards from ${file.name}.` : "No new cards found in that deck.");
    } catch (e) {
      setImporting(e instanceof Error ? e.message : "That deck could not be read.");
    }
  };

  return (
    <aside className="panel" aria-label="Review and mastery">
      <div className="panel-head">
        <h2>Review</h2>
        <button onClick={onClose} aria-label="Close">
          Close
        </button>
      </div>

      <section className="due">
        <p>
          {due
            ? `${due} card${due === 1 ? "" : "s"} due. You'll work each one by hand, from memory.`
            : memory.cards.length
              ? "Nothing due right now. Cards come back just before you'd forget them."
              : "No cards yet. When the tutor helps you fix a mistake, it saves a card here. You can also lasso part of your page with Keep."}
        </p>
        <button className="primary" onClick={onStart} disabled={!due}>
          Start review
        </button>
      </section>

      <section>
        <h3>What you know</h3>
        {concepts.length ? (
          <ul className="mastery">
            {concepts.map((c) => (
              <li key={c.concept}>
                <div className="mastery-row">
                  <span className="concept">{c.concept}</span>
                  <span className="pct">{Math.round(c.mastery * 100)}%</span>
                </div>
                <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(c.mastery * 100)} aria-label={c.concept}>
                  <span style={{ width: `${Math.max(4, c.mastery * 100)}%` }} className={c.mastery < 0.45 ? "low" : c.mastery < 0.7 ? "mid" : "high"} />
                </div>
                <p className="detail">
                  {[
                    c.slips ? `${c.slips} slip${c.slips === 1 ? "" : "s"}` : null,
                    c.solved ? `${c.solved} solved` : null,
                    c.cards ? `${c.cards} card${c.cards === 1 ? "" : "s"}` : null,
                    c.nextDue != null ? `next ${whenText(c.nextDue, now)}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="detail">Your concepts show up here as you work with the tutor.</p>
        )}
      </section>

      <section>
        <h3>Anki decks</h3>
        <p className="detail">Bring in a deck you already have (.apkg). Its cards join your reviews and you answer them by hand.</p>
        <input
          ref={fileRef}
          type="file"
          accept=".apkg"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importFile(f);
            e.target.value = "";
          }}
        />
        <button onClick={() => fileRef.current?.click()}>Import a deck</button>
        {importing && <p className="detail">{importing}</p>}
      </section>

      {storageFull && <p className="warn">This device's storage is full, so new cards may not be saved.</p>}
    </aside>
  );
}

async function loadApkg(file: File): Promise<AnkiNote[]> {
  const [{ extractCollection, readNotes }, { default: initSqlJs }] = await Promise.all([import("@/lib/anki"), import("sql.js")]);
  const SQL = await initSqlJs({ locateFile: () => "/sql-wasm-browser.wasm" });
  const db = new SQL.Database(extractCollection(new Uint8Array(await file.arrayBuffer())));
  try {
    return readNotes(db);
  } finally {
    db.close();
  }
}
