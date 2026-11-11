"use client";

// The tutor pen room: a live link between the student's device (the host)
// and a human tutor's device (the guest). Messages go over a Supabase
// Realtime broadcast channel when Supabase is configured (research mode), and
// otherwise through this app's own server, which is enough for a laptop and a
// tablet on the same network. The voice goes peer to peer over WebRTC, with
// the room carrying the call setup.

import { browserClient } from "./supabase/client";
import { researchMode } from "./supabase/env";
import type { Envelope, RoomMessage } from "./room-clock";

export type Role = "host" | "guest";

export interface RoomLink {
  send(m: RoomMessage): void;
  close(): void;
}

type Handlers = { onMessage: (m: RoomMessage) => void; onStatus?: (s: "connecting" | "open" | "closed") => void };

export function joinRoom(code: string, role: Role, h: Handlers): RoomLink {
  return researchMode ? supabaseLink(code, role, h) : relayLink(code, role, h);
}

function supabaseLink(code: string, role: Role, h: Handlers): RoomLink {
  const sb = browserClient();
  const ch = sb.channel(`coink-room-${code}`, { config: { broadcast: { self: false, ack: false } } });
  ch.on("broadcast", { event: "m" }, ({ payload }) => {
    const env = payload as Envelope;
    if (env?.from && env.from !== role) h.onMessage(env.m);
  });
  h.onStatus?.("connecting");
  let open = false;
  const queue: RoomMessage[] = [];
  ch.subscribe((status) => {
    if (status === "SUBSCRIBED") {
      open = true;
      h.onStatus?.("open");
      for (const m of queue.splice(0)) void ch.send({ type: "broadcast", event: "m", payload: { from: role, m } satisfies Envelope });
    } else if (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      open = false;
      h.onStatus?.("closed");
    }
  });
  return {
    send: (m) => {
      if (!open) return void queue.push(m);
      void ch.send({ type: "broadcast", event: "m", payload: { from: role, m } satisfies Envelope });
    },
    close: () => void sb.removeChannel(ch),
  };
}

// This app's server as the relay: messages in by POST (one request at a time,
// so they stay in order), out by a server-sent event stream.
function relayLink(code: string, role: Role, h: Handlers): RoomLink {
  h.onStatus?.("connecting");
  const es = new EventSource(`/api/room?code=${code}&role=${role}`);
  es.onopen = () => h.onStatus?.("open");
  es.onerror = () => h.onStatus?.(es.readyState === EventSource.CLOSED ? "closed" : "connecting");
  es.onmessage = (e) => {
    try {
      for (const m of JSON.parse(e.data) as RoomMessage[]) h.onMessage(m);
    } catch {
      // a garbled line is dropped
    }
  };
  let queue: RoomMessage[] = [];
  let busy = false;
  let closed = false;
  const flush = async () => {
    if (busy || closed || !queue.length) return;
    busy = true;
    const batch = queue;
    queue = [];
    try {
      await fetch("/api/room", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, role, messages: batch }) });
    } catch {
      // the next batch tries again; ink that was lost is resent with the page
    }
    busy = false;
    void flush();
  };
  return {
    send: (m) => {
      queue.push(m);
      void flush();
    },
    close: () => {
      closed = true;
      es.close();
    },
  };
}

// ---------- the voice call ----------
// The guest calls; the host answers. Both send their microphone and play the other's.
export class VoiceCall {
  private pc: RTCPeerConnection | null = null;
  private audio: HTMLAudioElement | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  onState: ((s: string) => void) | null = null;

  constructor(private role: Role, private send: (m: RoomMessage) => void, private mic: MediaStream) {}

  private make() {
    this.pc?.close();
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    this.mic.getAudioTracks().forEach((t) => pc.addTrack(t, this.mic));
    pc.onicecandidate = (e) => e.candidate && this.send({ k: "rtc", ice: e.candidate.toJSON() });
    pc.ontrack = (e) => {
      this.audio ??= new Audio();
      this.audio.autoplay = true;
      this.audio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      void this.audio.play().catch(() => undefined);
    };
    pc.onconnectionstatechange = () => this.onState?.(pc.connectionState);
    this.pc = pc;
    this.pendingIce = [];
    return pc;
  }

  async call() {
    const pc = this.make();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.send({ k: "rtc", sdp: { type: "offer", sdp: offer.sdp ?? "" } });
  }

  async handle(m: Extract<RoomMessage, { k: "rtc" }>) {
    if (m.sdp?.type === "offer" && this.role === "host") {
      const pc = this.make();
      await pc.setRemoteDescription(m.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.send({ k: "rtc", sdp: { type: "answer", sdp: answer.sdp ?? "" } });
      for (const c of this.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => undefined);
    } else if (m.sdp?.type === "answer" && this.pc) {
      await this.pc.setRemoteDescription(m.sdp);
      for (const c of this.pendingIce.splice(0)) await this.pc.addIceCandidate(c).catch(() => undefined);
    } else if (m.ice) {
      const c = m.ice as RTCIceCandidateInit;
      if (this.pc?.remoteDescription) await this.pc.addIceCandidate(c).catch(() => undefined);
      else this.pendingIce.push(c);
    }
  }

  hangUp() {
    this.pc?.close();
    this.pc = null;
    if (this.audio) this.audio.srcObject = null;
  }
}
