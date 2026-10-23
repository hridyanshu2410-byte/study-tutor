"use client";

// Papers are big (a picture per page), so they live in IndexedDB on this
// device rather than with the saved page, which only remembers which paper is open.

import type { Paper } from "./paper";

const DB = "study-tutor-papers";
const STORE = "papers";

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const savePaper = (paper: Paper) => run("readwrite", (s) => s.put(paper, paper.id)).then(() => undefined);
export const loadPaper = (id: string) => run<Paper | undefined>("readonly", (s) => s.get(id)).catch(() => undefined);
export const deletePaper = (id: string) => run("readwrite", (s) => s.delete(id)).then(() => undefined).catch(() => undefined);
