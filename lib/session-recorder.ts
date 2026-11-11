"use client";

// Keeps the current session's log, saves it as it grows, and records the
// student's voice when that is switched on. One recorder lives for the page;
// each session (a fresh page, a new problem, a block of a solo session)
// starts a new log.

import { SessionLog, type SessionFile } from "./session-log";
import type { Manners } from "./manners";
import { MicRecorder } from "./mic-recorder";
import { audioExt, saveRecording, uploadAudio, uploadRecording } from "./recording-store";

type Meta = { userId: string | null; participant: string | null; condition: string | null };

export class Recorder {
  log: SessionLog | null = null;
  private mic: MicRecorder | null = null;
  private micFile: string | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private uploadedAt = 0;
  private meta: Meta = { userId: null, participant: null, condition: null };
  // other people's recordings that belong with this session (the human tutor's voice)
  extraAudio: { who: string; mime: string; blob: Blob }[] = [];
  onSaved: ((file: SessionFile, error: string | null) => void) | null = null;

  setMeta(m: Meta) {
    this.meta = m;
    if (this.log) this.log.app = { ...this.log.app, participant: m.participant, condition: m.condition };
  }

  // A new session: the last one is saved first.
  async begin(id: string, manners: Manners, setup?: (log: SessionLog) => void): Promise<void> {
    const keepVoice = this.mic?.active ? this.mic.stream : null;
    if (this.log) await this.end();
    const log = new SessionLog(id, manners, () => performance.now());
    log.app = { userAgent: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 200) : undefined, participant: this.meta.participant, condition: this.meta.condition };
    log.onChange = () => this.soon();
    this.log = log;
    setup?.(log);
    // a voice recording carries on into the next session, as a new file
    if (keepVoice) await this.startVoice(keepVoice.active ? keepVoice : undefined).catch(() => undefined);
  }

  private soon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save(false);
    }, 4000);
  }

  // Saves the log on this device, and in research mode to the private bucket
  // (at most once a minute while the session runs, and always at the end).
  async save(final: boolean): Promise<void> {
    const log = this.log;
    // a page opened and left alone is not a session worth keeping
    if (!log || !log.events.some((e) => e.type !== "view" && e.type !== "snapshot" && e.type !== "audio")) return;
    const file = log.toFile();
    let error: string | null = null;
    const audio = final ? await this.collectAudio() : undefined;
    try {
      await saveRecording(file, audio);
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not save on this device";
    }
    const uid = this.meta.userId;
    if (uid && (final || Date.now() - this.uploadedAt > 60_000)) {
      this.uploadedAt = Date.now();
      error = (await uploadRecording(uid, file).catch((e) => String(e))) ?? error;
      if (final) for (const a of audio ?? []) error = (await uploadAudio(uid, file.id, `${a.who}.${audioExt(a.mime)}`, a.blob).catch((e) => String(e))) ?? error;
    }
    this.onSaved?.(file, error);
  }

  private async collectAudio(): Promise<{ who: string; mime: string; blob: Blob }[]> {
    const out = [...this.extraAudio];
    if (this.mic) {
      const blob = this.mic.active ? this.mic.snapshot() : await this.mic.stop();
      if (blob) out.push({ who: "student", mime: this.mic.mime, blob });
    }
    return out;
  }

  // Ends the session: the voice recording stops and everything is saved.
  async end(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const log = this.log;
    if (this.mic) {
      const blob = await this.mic.stop();
      const audio = log?.events.find((e) => e.type === "audio" && e.who === "student" && e.file === this.micFile);
      if (audio && audio.type === "audio") audio.end = log!.now();
      if (blob) this.extraAudio.push({ who: "student", mime: this.mic.mime, blob });
      this.mic = null;
    }
    await this.save(true);
    this.extraAudio = [];
    this.log = null;
  }

  get recordingVoice() {
    return Boolean(this.mic?.active);
  }

  async startVoice(stream?: MediaStream): Promise<void> {
    if (!this.log || this.mic?.active) return;
    const mic = new MicRecorder();
    await mic.start(stream);
    this.mic = mic;
    this.micFile = `student.${audioExt(mic.mime)}`;
    this.log.push({ t: this.log.now(mic.startedAt), type: "audio", who: "student", file: this.micFile, mime: mic.mime, end: null });
  }

  async stopVoice(): Promise<void> {
    if (!this.mic || !this.log) return;
    const blob = await this.mic.stop();
    const e = this.log.events.find((x) => x.type === "audio" && x.who === "student" && x.file === this.micFile);
    if (e && e.type === "audio") e.end = this.log.now();
    if (blob) this.extraAudio.push({ who: "student", mime: this.mic.mime, blob });
    this.mic = null;
  }
}
