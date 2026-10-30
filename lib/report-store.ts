"use client";

// Session reports carry pictures of the board, so like papers they live in
// IndexedDB on this device.

import type { SessionReport } from "./session-report";

const DB = "study-tutor-reports";
const STORE = "reports";

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
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

export const saveReport = (r: SessionReport) => run("readwrite", (s) => s.put(r)).then(() => undefined);
export const loadReports = () =>
  run<SessionReport[]>("readonly", (s) => s.getAll())
    .then((all) => all.sort((a, b) => b.startedAt - a.startedAt))
    .catch(() => [] as SessionReport[]);
export const deleteReport = (id: string) => run("readwrite", (s) => s.delete(id)).then(() => undefined).catch(() => undefined);
