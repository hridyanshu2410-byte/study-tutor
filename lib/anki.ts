// Reads an Anki deck export (.apkg) into review cards. This is our own reader
// of Anki's published file format (a zip holding a SQLite collection); it uses
// no Anki code. Scheduling starts fresh under our FSRS scheduler.

import { unzipSync } from "fflate";
import { decompress as zstd } from "fzstd";
import type { Database } from "sql.js";

export type AnkiNote = { front: string; back: string; deck: string; tags: string[] };

// Newer Anki exports carry a placeholder `collection.anki2` next to the real,
// zstd-compressed `collection.anki21b`, so prefer the newest file present.
export function extractCollection(apkg: Uint8Array): Uint8Array {
  const files = unzipSync(apkg, {
    filter: (f) => ["collection.anki21b", "collection.anki21", "collection.anki2"].includes(f.name),
  });
  if (files["collection.anki21b"]) return zstd(files["collection.anki21b"]);
  const legacy = files["collection.anki21"] ?? files["collection.anki2"];
  if (!legacy) throw new Error("This file doesn't look like an Anki deck export (.apkg).");
  return legacy;
}

export function readNotes(db: Database, limit = 5000): AnkiNote[] {
  const decks = deckNames(db);
  const noteDeck = new Map<number, number>();
  for (const [nid, did] of rows(db, "SELECT nid, MIN(did) FROM cards GROUP BY nid")) noteDeck.set(Number(nid), Number(did));

  const notes: AnkiNote[] = [];
  for (const [id, flds, tags] of rows(db, `SELECT id, flds, tags FROM notes ORDER BY id LIMIT ${Math.floor(limit)}`)) {
    const fields = String(flds).split("\x1f");
    const card = toCard(fields[0] ?? "", fields[1] ?? "");
    if (!card) continue;
    notes.push({
      ...card,
      deck: decks.get(noteDeck.get(Number(id)) ?? -1) ?? "Imported",
      tags: String(tags).trim().split(/\s+/).filter(Boolean),
    });
  }
  return notes;
}

// Cloze notes ("{{c1::answer::hint}}") become a question with the gaps shown
// as [...], and the filled-in text as the answer. Other notes use their first
// two fields as front and back.
export function toCard(rawFront: string, rawBack: string): { front: string; back: string } | null {
  const cloze = /\{\{c\d+::(.*?)(?:::(.*?))?\}\}/gs;
  if (cloze.test(rawFront)) {
    const front = plain(rawFront.replace(cloze, (_m, _a, hint) => (hint ? `[${hint}]` : "[...]")));
    const filled = plain(rawFront.replace(cloze, (_m, answer) => answer));
    const extra = plain(rawBack);
    return front ? { front, back: extra ? `${filled}\n${extra}` : filled } : null;
  }
  const front = plain(rawFront);
  return front ? { front, back: plain(rawBack) } : null;
}

export function plain(html: string): string {
  return html
    .replace(/\[sound:[^\]]*\]/g, "")
    .replace(/<img[^>]*>/gi, " (image) ")
    .replace(/<br\s*\/?>|<\/(div|p|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim()
    .slice(0, 2000);
}

function deckNames(db: Database): Map<number, string> {
  const names = new Map<number, string>();
  try {
    // Schema 18 and later: a decks table, with \x1f between parent and child names.
    for (const [id, name] of rows(db, "SELECT id, name FROM decks")) names.set(Number(id), String(name).replaceAll("\x1f", "::"));
  } catch {
    // Older collections keep decks as JSON on the col row.
    const json = rows(db, "SELECT decks FROM col")[0]?.[0];
    for (const d of Object.values(JSON.parse(String(json ?? "{}")) as Record<string, { id: number; name: string }>)) {
      names.set(Number(d.id), d.name);
    }
  }
  return names;
}

function rows(db: Database, sql: string) {
  return db.exec(sql)[0]?.values ?? [];
}
