"use client";

// Where session recordings are kept. On this device they live in IndexedDB
// (the last 40 sessions), ready to replay or download. In research mode they
// also go to the project's private "recordings" storage bucket, one folder per
// tester and session. Voice recordings identify people, so they only ever go
// to that private bucket (or a file the researcher downloads), never to the
// events table.

import type { SessionFile } from "./session-log";
import { browserClient } from "./supabase/client";

const DB = "coink-recordings";
const STORE = "sessions";
const KEEP = 40;

export type StoredRecording = { id: string; startedAt: number; savedAt: number; file: SessionFile; audio?: { who: string; mime: string; blob: Blob }[] };

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

export async function saveRecording(file: SessionFile, audio?: StoredRecording["audio"]) {
  const prev = audio ? undefined : await run<StoredRecording | undefined>("readonly", (s) => s.get(file.id)).catch(() => undefined);
  await run("readwrite", (s) => s.put({ id: file.id, startedAt: file.startedAt, savedAt: file.savedAt, file, audio: audio ?? prev?.audio } satisfies StoredRecording));
  // keep the newest few
  const all = await listRecordings();
  for (const old of all.slice(KEEP)) await deleteRecording(old.id);
}

// Newest first, without the audio (which can be large).
export async function listRecordings(): Promise<{ id: string; startedAt: number; savedAt: number; duration: number; tutor: string; events: number; audio: number }[]> {
  try {
    const all = await run<StoredRecording[]>("readonly", (s) => s.getAll());
    return all
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((r) => ({ id: r.id, startedAt: r.startedAt, savedAt: r.savedAt, duration: r.file.duration, tutor: r.file.tutor, events: r.file.events.length, audio: r.audio?.length ?? 0 }));
  } catch {
    return [];
  }
}

export const loadRecording = (id: string) => run<StoredRecording | undefined>("readonly", (s) => s.get(id)).catch(() => undefined);
export const deleteRecording = (id: string) => run("readwrite", (s) => s.delete(id)).then(() => undefined).catch(() => undefined);

// ---------- research mode: the private bucket ----------
export const BUCKET = "recordings";

export async function uploadRecording(userId: string, file: SessionFile): Promise<string | null> {
  const path = `${userId}/${file.id}/session.json`;
  const { error } = await browserClient()
    .storage.from(BUCKET)
    .upload(path, new Blob([JSON.stringify(file)], { type: "application/json" }), { upsert: true, contentType: "application/json" });
  return error ? error.message : null;
}

export async function uploadAudio(userId: string, sessionId: string, name: string, blob: Blob): Promise<string | null> {
  const path = `${userId}/${sessionId}/${name}`;
  const { error } = await browserClient().storage.from(BUCKET).upload(path, blob, { upsert: true, contentType: blob.type || "audio/webm" });
  return error ? error.message : null;
}

// ---------- files ----------
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const fileStem = (f: { id: string; startedAt: number }) => `coink-${new Date(f.startedAt).toISOString().slice(0, 16).replace(/[:T]/g, "-")}-${f.id.slice(0, 8)}`;
export const audioExt = (mime: string) => (mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm");
