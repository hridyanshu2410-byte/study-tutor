"use client";

// Replays a recorded session: the page as it was at any moment, strokes
// appearing as they were drawn, both people's voices in step, and what was
// said and why the tutor acted. A researcher can jump to a moment, mark
// errors and notes (for the error-to-act count), see the four counts the
// paper takes from each recording, and download the file, its events as CSV
// and its counts.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getStroke } from "perfect-freehand";
import { eventsCsv, inkBounds, isSessionFile, pageAt, type LogEvent, type SessionFile } from "@/lib/session-log";
import { measure, measureRow, MEASURE_COLUMNS } from "@/lib/session-measures";
import { brokenManners, MANNER_LABEL } from "@/lib/manners";
import { downloadBlob, fileStem, listRecordings, loadRecording, saveRecording } from "@/lib/recording-store";

type Clip = { who: string; name: string; url: string; el: HTMLAudioElement | null; start: number | null };
type Cam = { x: number; y: number; z: number };
const TUTOR_INK = "#c2410c";
const SPEEDS = [0.5, 1, 1.5, 2, 4];

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function outline(points: number[][], size: number, simulate: boolean, last: boolean): Path2D {
  const o = getStroke(points, { size, thinning: 0.5, smoothing: 0.5, streamline: 0.3, simulatePressure: simulate, last });
  const p = new Path2D();
  if (!o.length) return p;
  p.moveTo(o[0][0], o[0][1]);
  for (let i = 1; i < o.length; i++) {
    const [x0, y0] = o[i];
    const [x1, y1] = o[(i + 1) % o.length];
    p.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  p.closePath();
  return p;
}

type CloudSession = { participant: string; session: string; updated: string | null; files: { name: string; url: string | null; user: string }[] };

export default function Replay({ cloud }: { cloud: boolean }) {
  const [file, setFile] = useState<SessionFile | null>(null);
  const [stored, setStored] = useState<boolean>(false);
  const [clips, setClips] = useState<Clip[]>([]);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [learnerView, setLearnerView] = useState(false);
  const [local, setLocal] = useState<Awaited<ReturnType<typeof listRecordings>>>([]);
  const [remote, setRemote] = useState<CloudSession[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [showCounts, setShowCounts] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tRef = useRef(0);
  const playRef = useRef<{ wall: number; from: number } | null>(null);
  const clipsRef = useRef<Clip[]>([]);
  const speedRef = useRef(1);
  const fileInput = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    void listRecordings().then(setLocal);
    const q = new URLSearchParams(location.search).get("local");
    if (q) void openLocal(q);
    if (cloud)
      fetch("/api/admin/recordings")
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { sessions: (CloudSession & { user: string })[] } | null) => {
          if (!d) return;
          // a session's files can sit in two folders: the learner's, and the human tutor's voice
          const by = new Map<string, CloudSession>();
          for (const s of d.sessions) {
            const g = by.get(s.session) ?? { participant: s.participant, session: s.session, updated: s.updated, files: [] };
            if (s.files.some((f) => f.name === "session.json")) g.participant = s.participant;
            g.files.push(...s.files.map((f) => ({ ...f, user: s.user })));
            by.set(s.session, g);
          }
          setRemote([...by.values()].filter((s) => s.files.some((f) => f.name === "session.json")));
        })
        .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = (f: SessionFile, audio: { who: string; name: string; url: string }[], isStored: boolean) => {
    for (const c of clipsRef.current) {
      c.el?.pause();
      if (c.url.startsWith("blob:")) URL.revokeObjectURL(c.url);
    }
    const starts = new Map<string, number>();
    for (const e of f.events) if (e.type === "audio" && !starts.has(e.who)) starts.set(e.who, e.t);
    const made: Clip[] = audio.map((a) => {
      const el = new Audio(a.url);
      el.preload = "auto";
      return { ...a, el, start: starts.get(a.who) ?? 0 };
    });
    clipsRef.current = made;
    setClips(made);
    setFile(f);
    setStored(isStored);
    setPlaying(false);
    playRef.current = null;
    seek(0);
  };

  const openLocal = async (id: string) => {
    const r = await loadRecording(id);
    if (!r) return setMsg("That recording isn't on this device.");
    load(r.file, (r.audio ?? []).map((a) => ({ who: a.who, name: a.who, url: URL.createObjectURL(a.blob) })), true);
  };

  const openCloud = async (s: CloudSession) => {
    const json = s.files.find((f) => f.name === "session.json");
    if (!json?.url) return;
    setMsg("Loading…");
    try {
      const f = (await (await fetch(json.url)).json()) as unknown;
      if (!isSessionFile(f)) throw new Error("Not a CoInk session file");
      const audio = s.files.filter((x) => x.url && x.name !== "session.json").map((x) => ({ who: x.name.replace(/\.[a-z0-9]+$/, ""), name: x.name, url: x.url! }));
      load(f, audio, false);
      setMsg(null);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not load it");
    }
  };

  // A .coink.json file, with any audio files picked alongside it (named …-student.webm, …-human_tutor.webm).
  const openFiles = async (list: FileList) => {
    const files = [...list];
    const json = files.find((f) => /\.json$/i.test(f.name));
    if (!json) return setMsg("Pick the .coink.json file (and any audio files with it).");
    try {
      const f = JSON.parse(await json.text()) as unknown;
      if (!isSessionFile(f)) throw new Error("That isn't a CoInk session file.");
      const audio = files
        .filter((x) => x !== json)
        .map((x) => ({ who: /human_tutor/.test(x.name) ? "human_tutor" : "student", name: x.name, url: URL.createObjectURL(x) }));
      load(f, audio, false);
      setMsg(null);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not read that file");
    }
  };

  // ---------- the clock ----------
  const syncAudio = (now: number, force: boolean) => {
    for (const c of clipsRef.current) {
      const el = c.el;
      if (!el || c.start == null) continue;
      const at = (now - c.start) / 1000;
      const inside = at >= 0 && (Number.isNaN(el.duration) || at < el.duration);
      if (!playRef.current || !inside) {
        if (!el.paused) el.pause();
        if (inside && force) el.currentTime = at;
        continue;
      }
      el.playbackRate = speedRef.current;
      if (force || Math.abs(el.currentTime - at) > 0.3) el.currentTime = at;
      if (el.paused) void el.play().catch(() => undefined);
    }
  };

  const seek = useCallback((ms: number) => {
    const max = file?.duration ?? 0;
    const v = Math.max(0, Math.min(max || ms, ms));
    tRef.current = v;
    setT(v);
    if (playRef.current) playRef.current = { wall: performance.now(), from: v };
    syncAudio(v, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  const toggle = () => {
    if (!file) return;
    if (playRef.current) {
      playRef.current = null;
      setPlaying(false);
      syncAudio(tRef.current, true);
    } else {
      if (tRef.current >= file.duration) tRef.current = 0;
      playRef.current = { wall: performance.now(), from: tRef.current };
      setPlaying(true);
      syncAudio(tRef.current, true);
    }
  };

  useEffect(() => {
    speedRef.current = speed;
    if (playRef.current) playRef.current = { wall: performance.now(), from: tRef.current };
    syncAudio(tRef.current, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speed]);

  useEffect(() => {
    let raf = 0;
    let lastSync = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const p = playRef.current;
      if (p && file) {
        const v = p.from + (now - p.wall) * speedRef.current;
        if (v >= file.duration) {
          tRef.current = file.duration;
          playRef.current = null;
          setPlaying(false);
        } else tRef.current = v;
        setT(tRef.current);
        if (now - lastSync > 500) {
          lastSync = now;
          syncAudio(tRef.current, false);
        }
      }
      draw();
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, learnerView]);

  // ---------- drawing the page at time t ----------
  const bounds = useMemo(() => (file ? inkBounds(file) : null), [file]);
  const lastDrawn = useRef(-1);
  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas || !file) return;
    const dpr = window.devicePixelRatio || 1;
    const { clientWidth: w, clientHeight: h } = canvas;
    const sized = canvas.width === w * dpr && canvas.height === h * dpr;
    if (sized && lastDrawn.current === tRef.current) return;
    lastDrawn.current = tRef.current;
    if (!sized) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const page = pageAt(file, tRef.current);
    let cam: Cam = { x: -40, y: -40, z: 1 };
    const v = page.view;
    const target = learnerView && v ? { x: v.x, y: v.y, w: v.w / v.z, h: v.h / v.z } : bounds ? { x: bounds.x - 40, y: bounds.y - 40, w: bounds.w + 80, h: bounds.h + 80 } : null;
    if (target) {
      const z = Math.min(2, w / target.w, h / target.h);
      cam = { x: target.x - (w / z - target.w) / 2, y: target.y - (h / z - target.h) / 2, z };
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#fbfaf6";
    ctx.fillRect(0, 0, w, h);
    ctx.setTransform(dpr * cam.z, 0, 0, dpr * cam.z, -cam.x * cam.z * dpr, -cam.y * cam.z * dpr);
    if (v && !learnerView) {
      ctx.save();
      ctx.strokeStyle = "rgba(37, 99, 235, 0.3)";
      ctx.lineWidth = 1.5 / cam.z;
      ctx.setLineDash([8 / cam.z, 6 / cam.z]);
      ctx.strokeRect(v.x, v.y, v.w / v.z, v.h / v.z);
      ctx.restore();
    }
    for (const pass of [true, false])
      for (const s of page.strokes) {
        if ((s.kind === "highlight") !== pass) continue;
        ctx.fillStyle = s.color;
        ctx.fill(outline(s.points, s.size, !s.kind && s.points.every((q) => q[2] === 0.5), !s.drawing));
      }
    for (const ink of page.tutorInk) {
      ctx.fillStyle = "rgba(250, 204, 21, 0.38)";
      for (const b of ink.marks ?? []) ctx.fillRect(b.x, b.y, b.w * ink.sweep, b.h);
      ctx.fillStyle = TUTOR_INK;
      for (const b of ink.rules ?? []) ctx.fillRect(b.x, b.y, b.w * ink.sweep, b.h);
      for (const s of ink.strokes) ctx.fill(outline(s.points, s.w ?? 3.6, true, s.done));
    }
  };

  // ---------- the record beside it ----------
  const items = useMemo(() => {
    type Item = { e: LogEvent; label: string; who: string };
    if (!file) return [] as Item[];
    return file.events.flatMap((e): Item[] => {
      switch (e.type) {
        case "speech":
          return [{ e, who: e.who, label: `${e.aside ? "(while thinking) " : ""}${e.text}` }];
        case "trigger":
          return [{ e, who: "event", label: `Turn ${e.turn}: ${e.trigger === "pause" ? "glance after a pause" : e.trigger === "spoke" ? "the learner spoke" : e.trigger === "asked" ? "asked for help" : e.trigger}${e.focus ? `, pointing at ${e.focus.line_id}` : ""}` }];
        case "model_end":
          return [{ e, who: "event", label: `Turn ${e.turn}: ${e.move}, ${e.beats} phrase${e.beats === 1 ? "" : "s"}, ${(e.ms / 1000).toFixed(1)} s` }];
        case "turn_dropped":
          return [{ e, who: "event", label: `Turn ${e.turn} dropped: ${e.why}` }];
        case "interrupt":
          return [{ e, who: "event", label: `Interrupted (${e.by}) while ${e.during}` }];
        case "model_error":
          return [{ e, who: "event", label: `Model error: ${e.error}` }];
        case "erase":
          return e.how === "scribble" || e.how === "undo" || e.how === "eraser" ? [{ e, who: "event", label: `${e.who === "student" ? "Learner" : "Tutor"} erased ${e.ids.length} (${e.how})` }] : [];
        case "room":
          return [{ e, who: "event", label: `Tutor pen: ${e.what}${e.name ? ` (${e.name})` : ""}${e.offsetMs != null ? `, clocks ${e.offsetMs} ms apart, ${e.rttMs} ms round trip` : ""}` }];
        case "note":
          return [{ e, who: e.kind === "error" ? "error" : "note", label: e.kind === "error" ? `Error: ${e.text}` : e.kind === "problem" ? `Problem: ${e.text}` : e.text }];
        case "survey":
          return [{ e, who: "event", label: `Ratings: ${Object.entries(e.ratings).map(([k, v]) => `${k} ${v}`).join(", ")}` }];
        default:
          return [];
      }
    });
  }, [file]);
  const current = useMemo(() => {
    let k = -1;
    items.forEach((it, i) => {
      if (it.e.t <= t) k = i;
    });
    return k;
  }, [items, t]);
  useEffect(() => {
    if (!playing || current < 0) return;
    listRef.current?.children[current]?.scrollIntoView({ block: "nearest" });
  }, [current, playing]);

  const markers = useMemo(() => (file ? file.events.filter((e) => e.type === "trigger" || e.type === "interrupt" || (e.type === "note" && e.kind !== "problem")) : []), [file]);
  const counts = useMemo(() => (file && showCounts ? measure(file) : null), [file, showCounts]);

  const addMark = (kind: "error" | "mark") => {
    if (!file) return;
    const text = prompt(kind === "error" ? "What is the error? (a few words)" : "Note at this moment") ?? null;
    if (text == null) return;
    const e: LogEvent = { t: Math.round(tRef.current), type: "note", kind, text: text.trim() || (kind === "error" ? "error" : "note") };
    const next = { ...file, events: [...file.events, e].sort((a, b) => a.t - b.t) };
    setFile(next);
    if (stored) void saveRecording(next);
    else setMsg("Marks are kept in this replay. Download the file to keep them.");
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.code === "Space") {
        e.preventDefault();
        toggle();
      } else if (e.key === "ArrowLeft") seek(tRef.current - 5000);
      else if (e.key === "ArrowRight") seek(tRef.current + 5000);
      else if (e.key === "e") addMark("error");
      else if (e.key === "m") addMark("mark");
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  if (!file)
    return (
      <main className="replay-start">
        <h1 className="brand">Replay</h1>
        <p>Open a recorded session to watch it back: the strokes as they were drawn, the voices, and what the tutor did and why.</p>
        <div className="row">
          <button className="primary" onClick={() => fileInput.current?.click()}>
            Open a file…
          </button>
          <input ref={fileInput} type="file" multiple accept=".json,application/json,audio/*,.webm,.m4a,.ogg" hidden onChange={(e) => e.target.files && void openFiles(e.target.files)} />
          <a href="/">Back to the tutor</a>
        </div>
        {msg && <p className="warn">{msg}</p>}
        {remote && (
          <>
            <h2>Study recordings</h2>
            {remote.length ? (
              <ul className="rec-list">
                {remote.map((s) => (
                  <li key={s.session}>
                    <button onClick={() => void openCloud(s)}>
                      {s.participant} · {s.updated ? new Date(s.updated).toLocaleString() : s.session.slice(0, 8)} · {s.files.length - 1} audio
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="detail">None yet.</p>
            )}
          </>
        )}
        <h2>On this device</h2>
        {local.length ? (
          <ul className="rec-list">
            {local.map((r) => (
              <li key={r.id}>
                <button onClick={() => void openLocal(r.id)}>
                  {new Date(r.startedAt).toLocaleString()} · {fmt(r.duration)} · {r.tutor === "human" ? "human tutor" : "AI tutor"} · {r.events} events{r.audio ? ` · ${r.audio} audio` : ""}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="detail">No sessions recorded on this device yet.</p>
        )}
      </main>
    );

  const broken = brokenManners(file.manners);
  const stem = fileStem(file);
  return (
    <div className="replay">
      <header className="replay-head">
        <button onClick={() => setFile(null)}>← Sessions</button>
        <div className="replay-title">
          <strong>{new Date(file.startedAt).toLocaleString()}</strong>
          <span className="detail">
            {file.tutor === "human" ? "Human tutor" : "AI tutor"}
            {file.block ? ` · part ${file.block.n} of ${file.block.of}` : ""}
            {broken.length ? ` · ${broken.map((k) => MANNER_LABEL[k]).join(", ")}` : " · all manners kept"}
            {file.app.participant ? ` · ${file.app.participant}` : ""}
            {file.problem ? ` · ${file.problem}` : ""}
          </span>
        </div>
        <div className="row">
          <button className={learnerView ? "on" : ""} onClick={() => setLearnerView((v) => !v)} title="Show what the learner had on screen">
            Learner&apos;s view
          </button>
          <button className={showCounts ? "on" : ""} onClick={() => setShowCounts((c) => !c)}>
            Counts
          </button>
          <button onClick={() => downloadBlob(new Blob([JSON.stringify(file)], { type: "application/json" }), `${stem}.coink.json`)}>File</button>
          <button onClick={() => downloadBlob(new Blob([eventsCsv(file)], { type: "text/csv" }), `${stem}-events.csv`)}>Events CSV</button>
          <button
            onClick={() =>
              downloadBlob(new Blob([`${MEASURE_COLUMNS.join(",")}\n${measureRow(file).map((v) => (/[",]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(",")}\n`], { type: "text/csv" }), `${stem}-counts.csv`)
            }
          >
            Counts CSV
          </button>
        </div>
      </header>

      <div className="replay-body">
        <canvas ref={canvasRef} className="replay-canvas" />
        <aside className="replay-side">
          {counts && (
            <section className="counts">
              <h3>Counts</h3>
              <p>
                Tutor marks: {counts.marks.length} (on the learner&apos;s line {counts.placements.on}, beside {counts.placements.beside}, near {counts.placements.near}, apart {counts.placements.apart}, on a blank page {counts.placements.blank})
              </p>
              <p>
                Lines of writing: {counts.steps.lines.length}; first written by the learner {counts.steps.learnerFirst}, by the tutor {counts.steps.tutorFirst}
              </p>
              <p>
                Errors marked: {counts.errors.length}
                {counts.errors.length ? `; tutor's first act after ${counts.errors.map((e) => (e.ms == null ? "never" : `${(e.ms / 1000).toFixed(1)} s`)).join(", ")}` : " (press E at an error to mark it)"}
              </p>
              <p>
                Learner resumed while the tutor acted: {counts.yields.resumes}; tutor stopped within a second {counts.yields.stopped}
                {counts.yields.rate != null ? ` (${Math.round(counts.yields.rate * 100)}%)` : ""}
              </p>
            </section>
          )}
          <ol ref={listRef} className="replay-log">
            {items.map((it, i) => (
              <li key={i} className={`${it.who}${i === current ? " now" : ""}`} onClick={() => seek(it.e.t)}>
                <span className="at">{fmt(it.e.t)}</span>
                <span className="who">{it.who === "student" ? "Learner" : it.who === "tutor" ? "Tutor" : it.who === "human_tutor" ? "Human tutor" : ""}</span>
                <span className="what">{it.label}</span>
              </li>
            ))}
          </ol>
        </aside>
      </div>

      <footer className="replay-controls">
        <button className="primary play" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
          {playing ? "Pause" : "Play"}
        </button>
        <span className="time">
          {fmt(t)} / {fmt(file.duration)}
        </span>
        <div className="scrub">
          <input type="range" min={0} max={Math.max(1, file.duration)} step={50} value={t} onChange={(e) => seek(Number(e.target.value))} aria-label="Time" />
          <div className="ticks" aria-hidden="true">
            {markers.map((m, i) => (
              <span key={i} className={`tick ${m.type === "note" ? (m.kind === "error" ? "error" : "note") : m.type}`} style={{ left: `${(m.t / Math.max(1, file.duration)) * 100}%` }} />
            ))}
          </div>
        </div>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Speed">
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
        <button onClick={() => addMark("error")} title="Mark an error at this moment (E)">
          Mark error
        </button>
        <button onClick={() => addMark("mark")} title="Add a note at this moment (M)">
          Note
        </button>
        <span className="detail">{clips.length ? `${clips.length} voice recording${clips.length === 1 ? "" : "s"}` : "no voice recorded"}</span>
        {msg && <span className="detail">{msg}</span>}
      </footer>
    </div>
  );
}
