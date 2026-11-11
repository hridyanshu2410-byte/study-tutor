"use client";

// The tutor pen: a person tutors a learner from their own device. They see
// the learner's page live, write on it in tutor ink, and talk over a voice
// call. Their strokes and words are sent with times on the learner's session
// clock, so the learner's device records both people on one clock.

import { useCallback, useEffect, useRef, useState } from "react";
import { getStroke } from "perfect-freehand";
import { distanceToStroke, screenToWorld, zoomAt, type Camera, type Point, type Stroke } from "@/lib/ink";
import { ClockSync, validRoomCode, type PlainStroke, type Pt, type RoomMessage } from "@/lib/room-clock";
import { joinRoom, VoiceCall, type RoomLink } from "@/lib/tutor-room";
import { MicRecorder } from "@/lib/mic-recorder";
import { Conversation, speechInputSupported } from "@/lib/voice";
import { audioExt, downloadBlob, uploadAudio } from "@/lib/recording-store";
import { browserClient } from "@/lib/supabase/client";
import { researchMode } from "@/lib/supabase/env";

const TUTOR_INK = "#c2410c";
type Tool = "pen" | "eraser" | "hand";
type Phase = "start" | "joining" | "live" | "ended";

const toStroke = (p: PlainStroke): Stroke => ({ id: p.id, color: p.color, size: p.size, createdAt: 0, points: p.points as Point[], ...(p.kind ? { kind: p.kind as Stroke["kind"] } : {}) });

export default function TutorPen() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [code, setCode] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [phase, setPhase] = useState<Phase>("start");
  const [status, setStatus] = useState("");
  const [call, setCall] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("pen");
  const [follow, setFollow] = useState(true);
  const [heard, setHeard] = useState("");
  const [problem, setProblem] = useState("");
  const [recording, setRecording] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const link = useRef<RoomLink | null>(null);
  const clock = useRef(new ClockSync());
  const voice = useRef<VoiceCall | null>(null);
  const mic = useRef<MediaStream | null>(null);
  const micRec = useRef<MicRecorder | null>(null);
  const ear = useRef<Conversation | null>(null);
  const session = useRef<string | null>(null);
  const student = useRef(new Map<string, Stroke>());
  const ai = useRef(new Map<string, Stroke>());
  const mine = useRef(new Map<string, Stroke>());
  const view = useRef<{ x: number; y: number; z: number; w: number; h: number } | null>(null);
  const camera = useRef<Camera>({ x: -40, y: -40, z: 1 });
  const followRef = useRef(true);
  const dirty = useRef(true);
  const drawing = useRef<{ stroke: Stroke; pointerId: number; sent: number; t: number[] } | null>(null);
  const lastSend = useRef(0);
  const pointers = useRef(new Map<number, { x: number; y: number; type: string }>());
  const pinch = useRef<{ dist: number; cx: number; cy: number } | null>(null);
  const penSeen = useRef(false);
  const space = useRef(false);
  const spokeFrom = useRef<number | null>(null);

  useEffect(() => {
    const c = new URLSearchParams(location.search).get("room");
    if (validRoomCode(c)) setCode(c);
    try {
      setName(localStorage.getItem("coink:tutor-name") ?? "");
    } catch {
      // fine
    }
  }, []);
  useEffect(() => {
    followRef.current = follow;
    dirty.current = true;
  }, [follow]);

  const send = (m: RoomMessage) => link.current?.send(m);
  const hostNow = () => clock.current.toHost(performance.now());

  // ---------- what comes from the learner's device ----------
  const handle = useCallback(async (m: RoomMessage) => {
    switch (m.k) {
      case "pong": {
        const sample = clock.current.add(m.a, m.b, performance.now());
        const best = clock.current.best();
        if (best && best === sample) send({ k: "clock", offset: best.offset, rtt: best.rtt });
        break;
      }
      case "welcome":
        session.current = m.session;
        setPhase("live");
        if (m.recordVoice && mic.current && !micRec.current?.active) {
          const r = new MicRecorder();
          try {
            await r.start(mic.current);
            micRec.current = r;
            setRecording(true);
            // wait for the clock to settle before saying when the recording began
            setTimeout(() => send({ k: "voice", t: clock.current.toHost(r.startedAt), file: null, mime: r.mime }), 1200);
          } catch {
            setNote("Your voice can't be recorded in this browser.");
          }
        }
        if (mic.current) {
          voice.current?.hangUp();
          voice.current = new VoiceCall("guest", send, mic.current);
          voice.current.onState = setCall;
          await voice.current.call().catch(() => setCall("failed"));
        }
        break;
      case "page":
        student.current = new Map(m.strokes.map((s) => [s.id, toStroke(s)]));
        ai.current = new Map(m.tutor.map((s) => [s.id, toStroke(s)]));
        mine.current = new Map(m.guest.map((s) => [s.id, toStroke(s)]));
        setProblem(m.problem);
        dirty.current = true;
        break;
      case "s_ink": {
        const s = student.current.get(m.id) ?? { id: m.id, color: m.color, size: m.size, createdAt: 0, points: [], ...(m.kind ? { kind: m.kind as Stroke["kind"] } : {}) };
        s.points = m.full ? (m.pts as Point[]) : [...s.points, ...(m.pts as Point[])];
        student.current.set(m.id, s);
        dirty.current = true;
        break;
      }
      case "s_rub":
        for (const id of m.ids) {
          student.current.delete(id);
          mine.current.delete(id);
          for (const k of [...ai.current.keys()]) if (k === id || k.startsWith(`${id}:`)) ai.current.delete(k);
        }
        dirty.current = true;
        break;
      case "view":
        view.current = m;
        dirty.current = true;
        break;
      case "rtc":
        await voice.current?.handle(m);
        break;
      case "end":
        await leave(true);
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const join = async () => {
    if (!code) return;
    try {
      localStorage.setItem("coink:tutor-name", name);
    } catch {
      // fine
    }
    setPhase("joining");
    try {
      mic.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      setNote("No microphone: you can write, but the learner won't hear you.");
    }
    link.current = joinRoom(code, "guest", { onMessage: (m) => void handle(m), onStatus: setStatus });
    send({ k: "hello", name: name.trim() || "Tutor" });
    // match clocks: a few pings now, then one every ten seconds
    for (let i = 0; i < 6; i++) setTimeout(() => send({ k: "ping", a: performance.now() }), 150 + i * 250);
    const ping = setInterval(() => send({ k: "ping", a: performance.now() }), 10_000);
    pingTimer.current = ping;
    // say hello again until the learner's device answers
    const retry = setInterval(() => {
      if (session.current) return clearInterval(retry);
      send({ k: "hello", name: name.trim() || "Tutor" });
    }, 2000);
    retryTimer.current = retry;
    // the tutor's words, transcribed here, for the record
    if (speechInputSupported()) {
      ear.current = new Conversation({
        onHearing: (h) => {
          if (h && spokeFrom.current == null) spokeFrom.current = performance.now();
        },
        onUtterance: (text) => {
          const from = spokeFrom.current ?? performance.now();
          spokeFrom.current = null;
          setHeard(text);
          send({ k: "said", text, t: clock.current.toHost(from), end: hostNow() });
        },
        onBlocked: (reason) => setNote(reason),
      });
      ear.current.start();
    }
  };
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const leave = async (byHost = false) => {
    if (pingTimer.current) clearInterval(pingTimer.current);
    if (retryTimer.current) clearInterval(retryTimer.current);
    ear.current?.stop();
    if (!byHost) send({ k: "bye" });
    voice.current?.hangUp();
    const r = micRec.current;
    micRec.current = null;
    setRecording(false);
    if (r) {
      const blob = await r.stop();
      const sid = session.current ?? "session";
      const fileName = `human_tutor.${audioExt(r.mime)}`;
      let saved: string | null = null;
      if (blob && researchMode) {
        const { data } = await browserClient().auth.getUser();
        if (data.user) {
          const err = await uploadAudio(data.user.id, sid, fileName, blob);
          if (!err) saved = `${data.user.id}/${sid}/${fileName}`;
        }
      }
      if (blob && !saved) downloadBlob(blob, `coink-${sid.slice(0, 8)}-${fileName}`);
      send({ k: "voice", t: hostNow(), file: saved ?? `downloaded on the tutor's device: coink-${sid.slice(0, 8)}-${fileName}`, mime: r.mime });
      setNote(saved ? "Your voice recording was saved to the study's private storage." : "Your voice recording was downloaded to this device. Keep it with the session.");
    }
    setTimeout(() => {
      link.current?.close();
      link.current = null;
      mic.current?.getTracks().forEach((t) => t.stop());
      mic.current = null;
    }, 400);
    setPhase("ended");
  };

  // ---------- drawing ----------
  const pathCache = useRef(new Map<string, Path2D>());
  const pathOf = (s: Stroke, live: boolean) => {
    const key = `${s.id}:${s.points.length}`;
    let p = pathCache.current.get(key);
    if (p) return p;
    const outline = getStroke(s.points, { size: s.size, thinning: s.kind ? 0 : 0.35, smoothing: 0.5, streamline: 0.4, simulatePressure: !s.kind && s.points.every((q) => q[2] === 0.5), last: !live });
    p = new Path2D();
    if (outline.length) {
      p.moveTo(outline[0][0], outline[0][1]);
      for (let i = 1; i < outline.length; i++) {
        const [x0, y0] = outline[i];
        const [x1, y1] = outline[(i + 1) % outline.length];
        p.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
      }
      p.closePath();
    }
    if (!live) pathCache.current.set(key, p);
    return p;
  };

  useEffect(() => {
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const canvas = canvasRef.current;
      if (!canvas || !dirty.current) return;
      dirty.current = false;
      const dpr = window.devicePixelRatio || 1;
      const { clientWidth: w, clientHeight: h } = canvas;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      // follow the learner's view: show what they see, as large as fits
      const v = view.current;
      if (followRef.current && v) {
        const vw = v.w / v.z, vh = v.h / v.z;
        const z = Math.min(w / vw, h / vh);
        camera.current = { x: v.x - (w / z - vw) / 2, y: v.y - (h / z - vh) / 2, z };
      }
      const cam = camera.current;
      const ctx = canvas.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#fbfaf6";
      ctx.fillRect(0, 0, w, h);
      ctx.setTransform(dpr * cam.z, 0, 0, dpr * cam.z, -cam.x * cam.z * dpr, -cam.y * cam.z * dpr);
      if (v) {
        ctx.save();
        ctx.strokeStyle = "rgba(37, 99, 235, 0.35)";
        ctx.lineWidth = 1.5 / cam.z;
        ctx.setLineDash([8 / cam.z, 6 / cam.z]);
        ctx.strokeRect(v.x, v.y, v.w / v.z, v.h / v.z);
        ctx.restore();
      }
      for (const pass of [true, false])
        for (const s of student.current.values()) {
          if ((s.kind === "highlight") !== pass) continue;
          ctx.fillStyle = s.color;
          ctx.fill(pathOf(s, false));
        }
      for (const s of ai.current.values()) {
        ctx.fillStyle = TUTOR_INK;
        ctx.fill(pathOf(s, false));
      }
      for (const s of mine.current.values()) {
        ctx.fillStyle = s.color;
        ctx.fill(pathOf(s, drawing.current?.stroke === s));
      }
    };
    raf = requestAnimationFrame(frame);
    const onResize = () => (dirty.current = true);
    window.addEventListener("resize", onResize);
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space") space.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") space.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setFollow(false);
      const r = canvas.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50)) camera.current = zoomAt(camera.current, e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
      else camera.current = { ...camera.current, x: camera.current.x + e.deltaX / camera.current.z, y: camera.current.y + e.deltaY / camera.current.z };
      dirty.current = true;
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [phase]);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };

  const sendInk = (done: boolean) => {
    const d = drawing.current;
    if (!d) return;
    const now = performance.now();
    if (!done && now - lastSend.current < 100) return;
    lastSend.current = now;
    const pts: Pt[] = d.stroke.points.slice(d.sent).map((p, i) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10, Math.round(p[2] * 100) / 100, Math.round(clock.current.toHost(d.t[d.sent + i]))]);
    d.sent = d.stroke.points.length;
    send({ k: "ink", id: d.stroke.id, color: d.stroke.color, size: d.stroke.size, pts, done });
  };

  const eraseAt = (sx: number, sy: number) => {
    const [wx, wy] = screenToWorld(camera.current, sx, sy);
    const hit = [...mine.current.values()].filter((s) => distanceToStroke(s, wx, wy) < 12 / camera.current.z).map((s) => s.id);
    if (!hit.length) return;
    hit.forEach((id) => mine.current.delete(id));
    send({ k: "rub", ids: hit });
    dirty.current = true;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const canvas = canvasRef.current!;
    canvas.setPointerCapture(e.pointerId);
    const [sx, sy] = local(e);
    pointers.current.set(e.pointerId, { x: sx, y: sy, type: e.pointerType });
    if (e.pointerType === "pen") penSeen.current = true;
    const touches = [...pointers.current.values()].filter((p) => p.type === "touch");
    if (touches.length >= 2) {
      if (drawing.current) {
        mine.current.delete(drawing.current.stroke.id);
        send({ k: "rub", ids: [drawing.current.stroke.id] });
        drawing.current = null;
      }
      const [a, b] = touches;
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      setFollow(false);
      return;
    }
    if (tool === "hand" || space.current || e.button === 1 || e.button === 2 || (e.pointerType === "touch" && penSeen.current)) {
      setFollow(false);
      return;
    }
    if (tool === "eraser" || e.button === 5) return eraseAt(sx, sy);
    const [wx, wy] = screenToWorld(camera.current, sx, sy);
    const stroke: Stroke = { id: crypto.randomUUID(), color: TUTOR_INK, size: 4.6, createdAt: Date.now(), points: [[wx, wy, e.pointerType === "pen" ? e.pressure : 0.5]] };
    mine.current.set(stroke.id, stroke);
    drawing.current = { stroke, pointerId: e.pointerId, sent: 0, t: [e.nativeEvent.timeStamp || performance.now()] };
    sendInk(false);
    dirty.current = true;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const [sx, sy] = local(e);
    pointers.current.set(e.pointerId, { ...prev, x: sx, y: sy });
    if (pinch.current) {
      const touches = [...pointers.current.values()].filter((p) => p.type === "touch");
      if (touches.length >= 2) {
        const [a, b] = touches;
        const next = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
        let cam = zoomAt(camera.current, next.cx, next.cy, next.dist / pinch.current.dist);
        cam = { ...cam, x: cam.x - (next.cx - pinch.current.cx) / cam.z, y: cam.y - (next.cy - pinch.current.cy) / cam.z };
        camera.current = cam;
        pinch.current = next;
        dirty.current = true;
      }
      return;
    }
    const d = drawing.current;
    if (d && d.pointerId === e.pointerId) {
      const r = canvasRef.current!.getBoundingClientRect();
      for (const ev of e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent]) {
        const [wx, wy] = screenToWorld(camera.current, ev.clientX - r.left, ev.clientY - r.top);
        d.stroke.points.push([wx, wy, ev.pointerType === "pen" ? ev.pressure : 0.5]);
        d.t.push(ev.timeStamp || performance.now());
      }
      sendInk(false);
      dirty.current = true;
      return;
    }
    if (tool === "eraser" && e.buttons) return eraseAt(sx, sy);
    if (e.buttons) {
      camera.current = { ...camera.current, x: camera.current.x - (sx - prev.x) / camera.current.z, y: camera.current.y - (sy - prev.y) / camera.current.z };
      dirty.current = true;
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const d = drawing.current;
    if (d && d.pointerId === e.pointerId) {
      sendInk(true);
      drawing.current = null;
      dirty.current = true;
    }
  };

  if (!code)
    return (
      <main className="tutor-pen-start">
        <h1 className="brand">CoInk tutor pen</h1>
        <p>Open the link from the learner&apos;s Session panel. It looks like /tutor-pen?room=…</p>
      </main>
    );

  if (phase === "start" || phase === "ended")
    return (
      <main className="tutor-pen-start">
        <h1 className="brand">CoInk tutor pen</h1>
        {phase === "ended" ? (
          <>
            <p>The session has ended. Thank you.</p>
            {note && <p className="detail">{note}</p>}
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void join();
            }}
          >
            <p>
              You are joining room <strong className="code">{code}</strong> as the tutor. The AI tutor is off. The learner sees your writing in orange as you write it, and hears you.
            </p>
            <p className="detail">Your strokes and words are recorded with the session{researchMode ? ", and your voice is saved to the study's private storage if the researcher turned voice recording on" : ""}. Use headphones so the learner doesn&apos;t hear themselves.</p>
            <label>
              Your name or tutor code
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. T03" autoFocus />
            </label>
            <button className="primary" type="submit">
              Join and allow the microphone
            </button>
          </form>
        )}
      </main>
    );

  return (
    <div className="shell">
      <header className="bar">
        <span className="brand">CoInk · tutor pen</span>
        <span className="problem readonly">{problem || "The learner's page"}</span>
        <div className="tools" role="toolbar" aria-label="Tools">
          {(["pen", "eraser", "hand"] as Tool[]).map((t) => (
            <button key={t} className={tool === t ? "on" : ""} onClick={() => setTool(t)} aria-pressed={tool === t}>
              {t === "pen" ? "Pen" : t === "eraser" ? "Eraser" : "Move"}
            </button>
          ))}
          <button className={follow ? "on" : ""} onClick={() => setFollow((f) => !f)} aria-pressed={follow} title="Keep the learner's view on screen">
            Follow learner
          </button>
          <button className="danger" onClick={() => void leave()}>
            Leave
          </button>
        </div>
      </header>
      <canvas
        ref={canvasRef}
        className={`page tool-${tool}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
      />
      <footer className="tutor">
        <div className="caption-wrap">
          <p className="caption">{note ?? (heard ? `You said: ${heard}` : phase === "joining" ? "Waiting for the learner's device…" : "You're on. Write and talk as you would beside them.")}</p>
          <span className="status">
            {status}
            {call ? ` · voice ${call}` : ""}
            {recording ? " · recording your voice" : ""}
          </span>
        </div>
      </footer>
    </div>
  );
}
