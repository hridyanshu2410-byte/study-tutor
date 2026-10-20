"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getStroke } from "perfect-freehand";
import {
  distanceToStroke,
  groupLines,
  screenToWorld,
  zoomAt,
  type Camera,
  type InkLine,
  type Point,
  type Stroke,
} from "@/lib/ink";
import type { PublicTurn, TutorRequest } from "@/lib/tutor";
import { planAnnotations, strokeAt, type PenPlan } from "@/lib/handwriting";
import { listen, speak, speechInputSupported, stopSpeaking } from "@/lib/voice";

type Tool = "pen" | "eraser" | "hand";
type TutorState = "idle" | "thinking" | "speaking" | "listening";

// One turn's worth of tutor pen strokes. `born` is when the pen started, in
// performance.now() time; 0 means already fully written (e.g. restored).
type TutorInk = { id: string; plan: PenPlan; born: number };

const STUDENT_INK = "#1f2a44";
const TUTOR_INK = "#c2410c";
const PAUSE_MS = 3200;
const STORAGE_KEY = "study-tutor:page:v2";

export default function StudyCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Stroke[]>([]);
  const paths = useRef(new Map<string, Path2D>());
  const tutorPaths = useRef(new Map<string, Path2D>());
  const tutorInk = useRef<TutorInk[]>([]);
  const camera = useRef<Camera>({ x: -40, y: -40, z: 1 });
  const glide = useRef<{ from: Camera; to: Camera; start: number } | null>(null);
  const drawing = useRef<{ stroke: Stroke; pointerId: number; simulate: boolean } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number; type: string }>());
  const pinch = useRef<{ dist: number; cx: number; cy: number } | null>(null);
  const penSeen = useRef(false);
  const spaceHeld = useRef(false);
  const dirty = useRef(true);
  const pauseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const changedSinceTutor = useRef(false);
  const undoStack = useRef<Stroke[][]>([]);
  const stopListening = useRef<(() => void) | null>(null);
  const sessionId = useRef("");

  const [tool, setTool] = useState<Tool>("pen");
  const [problem, setProblem] = useState("");
  const [tutorState, setTutorState] = useState<TutorState>("idle");
  const [caption, setCaption] = useState("Write your problem anywhere on the page. I'll be right here.");
  const [muted, setMuted] = useState(false);
  const [canListen, setCanListen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stateRef = useRef({ tutorState, problem, muted });
  stateRef.current = { tutorState, problem, muted };

  // ---------- persistence ----------
  useEffect(() => {
    sessionId.current = crypto.randomUUID();
    setCanListen(speechInputSupported());
    document.fonts?.ready.then(() => (dirty.current = true));
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
      if (saved?.strokes) strokes.current = saved.strokes;
      if (saved?.tutorInk) tutorInk.current = saved.tutorInk.map((t: TutorInk) => ({ ...t, born: 0 }));
      if (saved?.problem) setProblem(saved.problem);
    } catch {
      // A blocked or corrupt store just means a fresh page.
    }
    dirty.current = true;
  }, []);

  const save = useCallback(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ strokes: strokes.current, tutorInk: tutorInk.current, problem: stateRef.current.problem }),
      );
    } catch {
      // Storage is a convenience; the page keeps working without it.
    }
  }, []);

  // ---------- rendering ----------
  const pathFor = useCallback((s: Stroke, simulate = false) => {
    let p = paths.current.get(s.id);
    if (!p || drawing.current?.stroke.id === s.id) {
      const outline = getStroke(s.points, {
        size: s.size,
        thinning: 0.6,
        smoothing: 0.55,
        streamline: 0.45,
        simulatePressure: simulate,
        last: drawing.current?.stroke.id !== s.id,
      });
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
      paths.current.set(s.id, p);
    }
    return p;
  }, []);

  useEffect(() => {
    let raf = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (glide.current) {
        const g = glide.current;
        const f = Math.min(1, (now - g.start) / 450);
        const e = f * f * (3 - 2 * f);
        camera.current = { x: g.from.x + (g.to.x - g.from.x) * e, y: g.from.y + (g.to.y - g.from.y) * e, z: g.from.z };
        if (f === 1) glide.current = null;
        dirty.current = true;
      }
      const animating = tutorInk.current.some((t) => t.born > 0 && now - t.born < t.plan.duration + 50);
      if (!dirty.current && !animating) return;
      dirty.current = false;

      const dpr = window.devicePixelRatio || 1;
      const { clientWidth: w, clientHeight: h } = canvas;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      const ctx = canvas.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const cam = camera.current;
      drawPaper(ctx, cam, w, h);

      ctx.setTransform(dpr * cam.z, 0, 0, dpr * cam.z, -cam.x * cam.z * dpr, -cam.y * cam.z * dpr);
      for (const s of strokes.current) {
        ctx.fillStyle = s.color;
        ctx.fill(pathFor(s, drawing.current?.stroke.id === s.id ? drawing.current.simulate : false));
      }
      for (const t of tutorInk.current) drawTutorInk(ctx, t, now, tutorPaths.current);
    };
    raf = requestAnimationFrame(frame);
    const onResize = () => (dirty.current = true);
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, [pathFor]);

  // ---------- tutor ----------
  const askTutor = useCallback(
    async (trigger: TutorRequest["trigger"], speech: string | null = null) => {
      if (stateRef.current.tutorState === "thinking") return;
      if (pauseTimer.current) clearTimeout(pauseTimer.current);
      const lines = groupLines(strokes.current);
      if (!lines.length && !speech && !stateRef.current.problem.trim()) return;

      changedSinceTutor.current = false;
      setTutorState("thinking");
      setError(null);
      try {
        const res = await fetch("/api/tutor", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId: sessionId.current,
            problem: stateRef.current.problem,
            trigger,
            speech,
            lines: lines.map((l) => ({ id: l.id, tokens: l.tokens.length })),
            ...renderPageImages(strokes.current, lines),
          } satisfies TutorRequest),
        });
        const data = await res.json();
        if (!res.ok && !data.say) throw new Error(data.error ?? `Tutor error ${res.status}`);
        respond(data as PublicTurn, lines);
      } catch (e) {
        setError(e instanceof Error ? e.message : "The tutor could not be reached.");
        setTutorState("idle");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const respond = (turn: PublicTurn, lines: InkLine[]) => {
    if (turn.move === "wait" || (!turn.say && !turn.annotations.length)) {
      setTutorState("idle");
      return;
    }
    if (turn.annotations.length) {
      const plan = planAnnotations(turn.annotations, lines, Math.floor(Math.random() * 2 ** 31));
      if (plan.strokes.length) {
        tutorInk.current.push({ id: crypto.randomUUID(), plan, born: performance.now() + 250 });
        revealIfOffscreen(plan);
      }
    }
    dirty.current = true;
    save();
    if (turn.say) {
      setCaption(turn.say);
      if (stateRef.current.muted) {
        setTutorState("idle");
      } else {
        setTutorState("speaking");
        speak(turn.say, () => setTutorState("idle"));
      }
    } else {
      setTutorState("idle");
    }
  };

  // If the tutor writes somewhere off screen, glide the page so it is visible.
  const revealIfOffscreen = (plan: PenPlan) => {
    const canvas = canvasRef.current;
    if (!plan.box || !canvas) return;
    const cam = camera.current;
    const w = canvas.clientWidth / cam.z;
    const h = (canvas.clientHeight - 160) / cam.z;
    const b = plan.box;
    const dx = b.x + b.w > cam.x + w - 40 ? b.x + b.w - (cam.x + w - 40) : b.x < cam.x + 20 ? b.x - (cam.x + 20) : 0;
    const dy = b.y + b.h > cam.y + h ? b.y + b.h - (cam.y + h) : b.y < cam.y + 80 / cam.z ? b.y - (cam.y + 80 / cam.z) : 0;
    if (dx || dy) {
      glide.current = { from: cam, to: { ...cam, x: cam.x + dx, y: cam.y + dy }, start: performance.now() };
      dirty.current = true;
    }
  };

  const schedulePause = () => {
    if (pauseTimer.current) clearTimeout(pauseTimer.current);
    pauseTimer.current = setTimeout(() => {
      if (changedSinceTutor.current && !drawing.current && stateRef.current.tutorState === "idle") askTutor("pause");
    }, PAUSE_MS);
  };

  // ---------- input ----------
  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };

  const eraseAt = (sx: number, sy: number) => {
    const [wx, wy] = screenToWorld(camera.current, sx, sy);
    const before = strokes.current.length;
    strokes.current = strokes.current.filter((s) => distanceToStroke(s, wx, wy) > 12 / camera.current.z);
    const reach = 12 / camera.current.z;
    tutorInk.current = tutorInk.current.filter(
      (t) => !t.plan.strokes.some((st) => st.points.some(([x, y]) => Math.abs(x - wx) < reach && Math.abs(y - wy) < reach)),
    );
    if (strokes.current.length !== before) changedSinceTutor.current = true;
    dirty.current = true;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const canvas = canvasRef.current!;
    canvas.setPointerCapture(e.pointerId);
    const [sx, sy] = local(e);
    pointers.current.set(e.pointerId, { x: sx, y: sy, type: e.pointerType });
    if (e.pointerType === "pen") penSeen.current = true;
    stopSpeaking();
    glide.current = null;
    if (stateRef.current.tutorState === "speaking") setTutorState("idle");

    const touches = [...pointers.current.values()].filter((p) => p.type === "touch");
    if (touches.length >= 2) {
      // A second finger turns a stroke-in-progress into a pinch.
      if (drawing.current) {
        strokes.current = strokes.current.filter((s) => s.id !== drawing.current!.stroke.id);
        drawing.current = null;
      }
      pinch.current = pinchOf(touches);
      return;
    }

    const pans =
      tool === "hand" ||
      spaceHeld.current ||
      e.button === 1 ||
      e.button === 2 ||
      (e.pointerType === "touch" && penSeen.current); // palm rejection once a pen is in use
    if (pans) return;

    if (tool === "eraser" || e.button === 5) {
      undoStack.current.push([...strokes.current]);
      eraseAt(sx, sy);
      return;
    }

    undoStack.current.push([...strokes.current]);
    const [wx, wy] = screenToWorld(camera.current, sx, sy);
    const stroke: Stroke = {
      id: crypto.randomUUID(),
      points: [[wx, wy, e.pointerType === "pen" ? e.pressure : 0.5]],
      color: STUDENT_INK,
      size: 4.2,
      createdAt: Date.now(),
    };
    strokes.current.push(stroke);
    drawing.current = { stroke, pointerId: e.pointerId, simulate: e.pointerType !== "pen" };
    if (pauseTimer.current) clearTimeout(pauseTimer.current);
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
        const next = pinchOf(touches);
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
      const events = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];
      const r = canvasRef.current!.getBoundingClientRect();
      for (const ev of events) {
        const [wx, wy] = screenToWorld(camera.current, ev.clientX - r.left, ev.clientY - r.top);
        d.stroke.points.push([wx, wy, ev.pointerType === "pen" ? ev.pressure : 0.5] as Point);
      }
      dirty.current = true;
      return;
    }

    if (tool === "eraser" && e.buttons) {
      eraseAt(sx, sy);
      return;
    }

    if (e.buttons) {
      camera.current = {
        ...camera.current,
        x: camera.current.x - (sx - prev.x) / camera.current.z,
        y: camera.current.y - (sy - prev.y) / camera.current.z,
      };
      dirty.current = true;
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const d = drawing.current;
    if (d && d.pointerId === e.pointerId) {
      drawing.current = null;
      paths.current.delete(d.stroke.id); // rebuild with the finished tail
      changedSinceTutor.current = true;
      dirty.current = true;
      save();
      schedulePause();
    } else if (tool === "eraser") {
      save();
      schedulePause();
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const [sx, sy] = local(e);
    if (e.ctrlKey || e.metaKey) {
      camera.current = zoomAt(camera.current, sx, sy, Math.exp(-e.deltaY * 0.01));
    } else {
      camera.current = {
        ...camera.current,
        x: camera.current.x + e.deltaX / camera.current.z,
        y: camera.current.y + e.deltaY / camera.current.z,
      };
    }
    dirty.current = true;
  };

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    strokes.current = prev;
    changedSinceTutor.current = true;
    dirty.current = true;
    save();
  }, [save]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      if (e.code === "Space") spaceHeld.current = true;
      if ((e.metaKey || e.ctrlKey) && e.key === "z") {
        e.preventDefault();
        undo();
      }
      if (e.key === "p") setTool("pen");
      if (e.key === "e") setTool("eraser");
      if (e.key === "h") setTool("hand");
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceHeld.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [undo]);

  const clearPage = () => {
    if (!strokes.current.length && !tutorInk.current.length) return;
    if (!confirm("Clear the whole page?")) return;
    undoStack.current.push([...strokes.current]);
    strokes.current = [];
    tutorInk.current = [];
    paths.current.clear();
    tutorPaths.current.clear();
    sessionId.current = crypto.randomUUID();
    dirty.current = true;
    save();
  };

  const toggleListening = () => {
    if (stopListening.current) {
      stopListening.current();
      return;
    }
    stopSpeaking();
    setTutorState("listening");
    stopListening.current = listen(
      (text) => askTutor("spoke", text),
      () => {
        stopListening.current = null;
        setTutorState((s) => (s === "listening" ? "idle" : s));
      },
    );
  };

  return (
    <div className="shell">
      <header className="bar">
        <span className="brand">Tutor</span>
        <input
          className="problem"
          value={problem}
          placeholder="What are we working on? (optional)"
          onChange={(e) => setProblem(e.target.value)}
          onBlur={save}
        />
        <div className="tools" role="toolbar" aria-label="Drawing tools">
          {(["pen", "eraser", "hand"] as Tool[]).map((t) => (
            <button key={t} className={tool === t ? "on" : ""} onClick={() => setTool(t)} aria-pressed={tool === t}>
              {t === "pen" ? "Pen" : t === "eraser" ? "Eraser" : "Move"}
            </button>
          ))}
          <button onClick={undo}>Undo</button>
          <button onClick={clearPage}>Clear</button>
        </div>
      </header>

      <canvas
        ref={canvasRef}
        className={`page tool-${tool}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
      />

      <footer className="tutor">
        <div className={`presence ${tutorState}`} aria-hidden />
        <p className="caption" aria-live="polite">
          {error ?? (tutorState === "thinking" ? "Looking at your work…" : tutorState === "listening" ? "Listening…" : caption)}
        </p>
        <div className="actions">
          {canListen && (
            <button className={tutorState === "listening" ? "talk on" : "talk"} onClick={toggleListening}>
              {tutorState === "listening" ? "Done talking" : "Talk"}
            </button>
          )}
          <button onClick={() => askTutor("asked")} disabled={tutorState === "thinking"}>
            I&apos;m stuck
          </button>
          <button
            onClick={() => {
              setMuted((m) => !m);
              stopSpeaking();
            }}
            aria-pressed={muted}
          >
            {muted ? "Voice off" : "Voice on"}
          </button>
        </div>
      </footer>
    </div>
  );
}

function pinchOf(touches: { x: number; y: number }[]) {
  const [a, b] = touches;
  return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
}

function drawPaper(ctx: CanvasRenderingContext2D, cam: Camera, w: number, h: number) {
  ctx.fillStyle = "#fbfaf6";
  ctx.fillRect(0, 0, w, h);
  const step = 32 * cam.z;
  if (step < 8) return;
  ctx.fillStyle = "rgba(31, 42, 68, 0.13)";
  const ox = -((cam.x * cam.z) % step);
  const oy = -((cam.y * cam.z) % step);
  for (let x = ox; x < w; x += step) for (let y = oy; y < h; y += step) ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
}

// Tutor strokes go through the same pen model as the student's ink, with
// pressure simulated from speed so lines swell and taper like real ink.
function drawTutorInk(ctx: CanvasRenderingContext2D, ink: TutorInk, now: number, cache: Map<string, Path2D>) {
  const t = ink.born === 0 ? Infinity : now - ink.born;
  ctx.save();
  ctx.fillStyle = TUTOR_INK;
  ink.plan.strokes.forEach((s, i) => {
    const key = `${ink.id}:${i}`;
    let path = cache.get(key);
    if (!path) {
      const pts = strokeAt(s, t);
      if (!pts) return;
      const done = t >= s.end;
      path = outlinePath(
        getStroke(pts, {
          size: 3.6,
          thinning: 0.55,
          smoothing: 0.6,
          streamline: 0.2,
          simulatePressure: true,
          start: { taper: 10 },
          end: { taper: done ? 8 : 0 },
          last: done,
        }),
      );
      if (done) cache.set(key, path);
      else {
        // the pen nib, while it is moving
        const [x, y] = pts[pts.length - 1];
        ctx.beginPath();
        ctx.arc(x, y, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.fill(path);
  });
  ctx.restore();
}

function outlinePath(outline: number[][]): Path2D {
  const p = new Path2D();
  if (!outline.length) return p;
  p.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i++) {
    const [x0, y0] = outline[i];
    const [x1, y1] = outline[(i + 1) % outline.length];
    p.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  p.closePath();
  return p;
}

// The tutor gets two pictures: the clean page to read, and the same page with
// line ids and numbered token boxes so it can point at an exact part.
// Tutor ink is left out of both so it never "reads" itself.
function renderPageImages(strokes: Stroke[], lines: InkLine[]): { pageImage: string; tokenImage: string } {
  if (!lines.length) {
    const blank = document.createElement("canvas");
    blank.width = blank.height = 64;
    const ctx = blank.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, 64, 64);
    const url = blank.toDataURL("image/png");
    return { pageImage: url, tokenImage: url };
  }
  let box = lines[0].box;
  for (const l of lines) {
    const x = Math.min(box.x, l.box.x), y = Math.min(box.y, l.box.y);
    box = { x, y, w: Math.max(box.x + box.w, l.box.x + l.box.w) - x, h: Math.max(box.y + box.h, l.box.y + l.box.h) - y };
  }
  const margin = 60;
  const scale = Math.min(1.5, 1500 / (box.w + 2 * margin), 1500 / (box.h + 2 * margin));

  const draw = (labels: boolean) => {
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil((box.w + 2 * margin) * scale);
    canvas.height = Math.ceil((box.h + 2 * margin) * scale);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(scale, 0, 0, scale, (margin - box.x) * scale, (margin - box.y) * scale);
    ctx.fillStyle = STUDENT_INK;
    for (const s of strokes) {
      const outline = getStroke(s.points, { size: s.size, thinning: 0.6, smoothing: 0.55, streamline: 0.45 });
      if (outline.length) ctx.fill(outlinePath(outline));
    }
    if (labels) {
      const px = 1 / scale;
      ctx.font = `${13 * px}px sans-serif`;
      ctx.lineWidth = px;
      for (const l of lines) {
        ctx.fillStyle = "#6b7280";
        ctx.fillText(l.id, box.x - margin + 6 * px, l.box.y + l.box.h / 2 + 5 * px);
        for (const t of l.tokens) {
          ctx.strokeStyle = "rgba(37, 99, 235, 0.55)";
          ctx.strokeRect(t.box.x - 2 * px, t.box.y - 2 * px, t.box.w + 4 * px, t.box.h + 4 * px);
          ctx.fillStyle = "#2563eb";
          ctx.fillText(String(t.n), t.box.x, t.box.y - 4 * px);
        }
      }
    }
    return canvas.toDataURL("image/png");
  };
  return { pageImage: draw(false), tokenImage: draw(true) };
}
