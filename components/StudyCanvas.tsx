"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getStroke } from "perfect-freehand";
import {
  distanceToStroke,
  groupLines,
  screenToWorld,
  zoomAt,
  type Box,
  type Camera,
  type InkLine,
  type Point,
  type Stroke,
} from "@/lib/ink";
import type { PublicTurn, TutorRequest } from "@/lib/tutor";
import { listen, speak, speechInputSupported, stopSpeaking } from "@/lib/voice";

type Tool = "pen" | "eraser" | "hand";
type TutorState = "idle" | "thinking" | "speaking" | "listening";

type TutorInk =
  | { id: string; kind: "text"; text: string; x: number; y: number; size: number; born: number; duration: number }
  | { id: string; kind: "mark"; mark: "circle" | "underline" | "question" | "check"; box: Box; born: number; duration: number };

const STUDENT_INK = "#1f2a44";
const TUTOR_INK = "#c2410c";
const PAUSE_MS = 3200;
const STORAGE_KEY = "study-tutor:page:v1";

export default function StudyCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Stroke[]>([]);
  const paths = useRef(new Map<string, Path2D>());
  const tutorInk = useRef<TutorInk[]>([]);
  const camera = useRef<Camera>({ x: -40, y: -40, z: 1 });
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
  const fontFamily = useRef("cursive");

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
    fontFamily.current =
      getComputedStyle(document.documentElement).getPropertyValue("--font-tutor").trim() || "cursive";
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
      const animating = tutorInk.current.some((t) => t.born > 0 && now - t.born < t.duration);
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
      for (const t of tutorInk.current) drawTutorInk(ctx, t, now, fontFamily.current);
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
            lines: lines.map(({ id, box }) => ({ id, box })),
            pageImage: renderPageImage(strokes.current, lines),
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
    if (turn.move === "wait" || (!turn.say && !turn.write && !turn.mark)) {
      setTutorState("idle");
      return;
    }
    const now = performance.now();
    const target = turn.mark ? lines.find((l) => l.id === turn.mark!.line_id) : lines.at(-1);
    let delay = 0;
    if (turn.mark && target) {
      tutorInk.current.push({ id: crypto.randomUUID(), kind: "mark", mark: turn.mark.kind, box: target.box, born: now, duration: 650 });
      delay = 500;
    }
    if (turn.write) {
      const anchor = target?.box ?? visibleTopLeft();
      const size = Math.max(26, Math.min(44, (target?.box.h ?? 40) * 0.8));
      tutorInk.current.push({
        id: crypto.randomUUID(),
        kind: "text",
        text: turn.write,
        x: anchor.x + anchor.w + 40,
        y: anchor.y + anchor.h / 2 + size / 3,
        size,
        born: now + delay,
        duration: 260 + turn.write.length * 75,
      });
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

  const visibleTopLeft = (): Box => {
    const c = camera.current;
    return { x: c.x + 40 / c.z, y: c.y + 80 / c.z, w: 0, h: 40 };
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
    tutorInk.current = tutorInk.current.filter((t) => {
      const b = t.kind === "mark" ? t.box : { x: t.x, y: t.y - t.size, w: t.text.length * t.size * 0.45, h: t.size };
      return !(wx > b.x && wx < b.x + b.w && wy > b.y && wy < b.y + b.h);
    });
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

function drawTutorInk(ctx: CanvasRenderingContext2D, t: TutorInk, now: number, family: string) {
  const p = t.born === 0 ? 1 : Math.max(0, Math.min(1, (now - t.born) / t.duration));
  if (p === 0) return;
  ctx.save();
  ctx.strokeStyle = TUTOR_INK;
  ctx.fillStyle = TUTOR_INK;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = 2.6;

  if (t.kind === "text") {
    // Written left to right like a pen: reveal the glyphs through a moving clip.
    ctx.font = `${t.size}px ${family}`;
    const width = ctx.measureText(t.text).width;
    ctx.beginPath();
    ctx.rect(t.x - 4, t.y - t.size * 1.2, (width + 8) * easeOut(p), t.size * 1.8);
    ctx.clip();
    ctx.fillText(t.text, t.x, t.y);
  } else {
    const { x, y, w, h } = t.box;
    const e = easeOut(p);
    ctx.beginPath();
    if (t.mark === "circle") {
      // Slightly tilted and overshooting, the way a hand circles something.
      const cx = x + w / 2, cy = y + h / 2;
      const start = -Math.PI * 0.6;
      ctx.ellipse(cx, cy, w / 2 + 18, h / 2 + 14, -0.04, start, start + Math.PI * 2.15 * e);
    } else if (t.mark === "underline") {
      ctx.moveTo(x - 4, y + h + 8);
      ctx.quadraticCurveTo(x + w / 2, y + h + 14, x - 4 + (w + 8) * e, y + h + 7);
    } else if (t.mark === "check") {
      const cx = x + w + 24, cy = y + h / 2;
      const pts: [number, number][] = [[cx - 10, cy], [cx - 2, cy + 10], [cx + 16, cy - 16]];
      ctx.moveTo(...pts[0]);
      if (e < 0.35) ctx.lineTo(pts[0][0] + (pts[1][0] - pts[0][0]) * (e / 0.35), pts[0][1] + (pts[1][1] - pts[0][1]) * (e / 0.35));
      else {
        ctx.lineTo(...pts[1]);
        const k = (e - 0.35) / 0.65;
        ctx.lineTo(pts[1][0] + (pts[2][0] - pts[1][0]) * k, pts[1][1] + (pts[2][1] - pts[1][1]) * k);
      }
    } else {
      ctx.font = `${Math.max(30, h)}px ${family}`;
      ctx.globalAlpha = e;
      ctx.fillText("?", x - 34, y + h * 0.8);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function easeOut(p: number) {
  return 1 - Math.pow(1 - p, 2);
}

// The tutor sees exactly the student's ink, with each line labelled so it can
// refer to lines by id. Tutor ink is left out so it never "reads" itself.
function renderPageImage(strokes: Stroke[], lines: InkLine[]): string {
  const canvas = document.createElement("canvas");
  if (!lines.length) {
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, 64, 64);
    return canvas.toDataURL("image/png");
  }
  let box = lines[0].box;
  for (const l of lines) {
    const x = Math.min(box.x, l.box.x), y = Math.min(box.y, l.box.y);
    box = { x, y, w: Math.max(box.x + box.w, l.box.x + l.box.w) - x, h: Math.max(box.y + box.h, l.box.y + l.box.h) - y };
  }
  const margin = 60;
  const scale = Math.min(1.5, 1600 / (box.w + 2 * margin), 1600 / (box.h + 2 * margin));
  canvas.width = Math.ceil((box.w + 2 * margin) * scale);
  canvas.height = Math.ceil((box.h + 2 * margin) * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, (margin - box.x) * scale, (margin - box.y) * scale);
  ctx.fillStyle = STUDENT_INK;
  for (const s of strokes) {
    const outline = getStroke(s.points, { size: s.size, thinning: 0.6, smoothing: 0.55, streamline: 0.45 });
    if (!outline.length) continue;
    ctx.beginPath();
    ctx.moveTo(outline[0][0], outline[0][1]);
    for (const [x, y] of outline.slice(1)) ctx.lineTo(x, y);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = "#9aa1ad";
  ctx.font = `${14 / scale}px sans-serif`;
  for (const l of lines) ctx.fillText(l.id, box.x - margin + 6 / scale, l.box.y + l.box.h / 2 + 5 / scale);
  return canvas.toDataURL("image/png");
}
