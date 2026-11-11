"use client";

// Records one person's microphone for the session file. The recording starts
// at a known moment on the session clock, so a replay can play it in step
// with the ink. Opus at 32 kbit/s keeps an hour to about 15 MB.

export class MicRecorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private ownStream = false;
  stream: MediaStream | null = null;
  // performance.now() when recording began
  startedAt = 0;
  mime = "";

  get active() {
    return Boolean(this.rec && this.rec.state !== "inactive");
  }

  // Uses the given stream (one already shared with a call), or asks for the mic.
  async start(stream?: MediaStream): Promise<void> {
    if (this.active) return;
    if (typeof MediaRecorder === "undefined") throw new Error("This browser can't record audio.");
    this.ownStream = !stream;
    this.stream = stream ?? (await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }));
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((m) => MediaRecorder.isTypeSupported?.(m)) ?? "";
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
    this.mime = this.rec.mimeType || mime || "audio/webm";
    this.chunks = [];
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start(5000);
    this.startedAt = performance.now();
  }

  // What has been recorded so far, without stopping.
  snapshot(): Blob | null {
    return this.chunks.length ? new Blob(this.chunks, { type: this.mime }) : null;
  }

  stop(): Promise<Blob | null> {
    const rec = this.rec;
    this.rec = null;
    if (!rec) return Promise.resolve(this.snapshot());
    return new Promise((resolve) => {
      rec.onstop = () => {
        if (this.ownStream) this.stream?.getTracks().forEach((t) => t.stop());
        resolve(this.snapshot());
      };
      try {
        rec.stop();
      } catch {
        resolve(this.snapshot());
      }
    });
  }
}
