import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync } from "fflate";
import initSqlJs from "sql.js";
import { extractCollection, plain, readNotes, toCard } from "./anki.ts";

test("html and media are reduced to plain text", () => {
  assert.equal(plain("d/dx <b>sin x</b><br>= cos x&nbsp;[sound:a.mp3]"), "d/dx sin x\n= cos x");
  assert.equal(plain('<img src="g.png">'), "(image)");
});

test("cloze notes become a question with gaps", () => {
  assert.deepEqual(toCard("The derivative of {{c1::sin x}} is {{c2::cos x::trig}}", ""), {
    front: "The derivative of [...] is [trig]",
    back: "The derivative of sin x is cos x",
  });
  assert.equal(toCard("", "back"), null);
});

test("reads notes and deck names from a legacy .apkg", async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`CREATE TABLE col (decks TEXT); CREATE TABLE notes (id INTEGER, flds TEXT, tags TEXT);
          CREATE TABLE cards (id INTEGER, nid INTEGER, did INTEGER);`);
  db.run("INSERT INTO col VALUES (?)", [JSON.stringify({ 7: { id: 7, name: "Calc::Derivatives" } })]);
  db.run("INSERT INTO notes VALUES (1, ?, ' chain-rule calc ')", ["d/dx sin(x²)\x1f2x cos(x²)"]);
  db.run("INSERT INTO notes VALUES (2, ?, '')", ["\x1fempty front"]);
  db.run("INSERT INTO cards VALUES (10, 1, 7), (11, 2, 7)");
  const apkg = zipSync({ "collection.anki2": db.export(), media: new TextEncoder().encode("{}") });

  const notes = readNotes(new SQL.Database(extractCollection(apkg)));
  assert.deepEqual(notes, [{ front: "d/dx sin(x²)", back: "2x cos(x²)", deck: "Calc::Derivatives", tags: ["chain-rule", "calc"] }]);
});

test("a zip without a collection is rejected", () => {
  assert.throws(() => extractCollection(zipSync({ "notes.txt": new Uint8Array([1]) })), /Anki deck/);
});
