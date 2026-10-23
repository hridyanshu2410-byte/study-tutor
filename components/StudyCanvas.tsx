"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getStroke } from "perfect-freehand";
import {
  distanceToStroke,
  groupLines,
  screenToWorld,
  strokesInLasso,
  zoomAt,
  type Camera,
  type InkLine,
  type Point,
  type Stroke,
} from "@/lib/ink";
import type { PublicTurn, TutorRequest } from "@/lib/tutor";
import { planAnnotations, strokeAt, type PenPlan } from "@/lib/handwriting";
import type { Box } from "@/lib/ink";
import { Conversation, speak, speechInputSupported, stopSpeaking } from "@/lib/voice";
import { useStudyMemory } from "@/lib/memory-store";
import type { AnkiNote } from "@/lib/anki";
import {
  dueCards,
  gradeCard,
  newCard,
  OUTCOME_RATING,
  RATING_LABEL,
  recordEvidence,
  shouldAddMistakeCard,
  weakSpots,
  whenText,
  type ReviewCard,
} from "@/lib/review";
import type { Grade } from "ts-fsrs";
import ReviewPanel from "./ReviewPanel";
import AccountMenu from "./AccountMenu";
import { flushCloud, loadCloud, logEvent, saveCloud, type Account } from "@/lib/cloud";

type Tool = "pen" | "eraser" | "hand" | "keep";
type Mode = "study" | "review";
type KeepDraft = { image: string; prompt: string; concept: string };
type ReviewRun = { ids: string[]; index: number; suggested: Grade | null; revealed: boolean; done: number };

const GRADES: Grade[] = [1, 2, 3, 4] as Grade[];
type TutorState = "idle" | "thinking" | "speaking";

// One turn's worth of tutor pen strokes. `born` is when the pen started, in
// performance.now() time; 0 means already fully written (e.g. restored), and
// Infinity means waiting to start with the voice.
type TutorInk = { id: string; plan: PenPlan; born: number };
type SavedPage = { strokes: Stroke[]; tutorInk: TutorInk[]; problem: string };

const STUDENT_INK = "#1f2a44";
const TUTOR_INK = "#c2410c";
// The tutor glances at the page this long after the pen lifts.
const WATCH_MS = 1500;
const STORAGE_KEY = "study-tutor:page:v2";

export default function StudyCanvas({ account }: { account: Account | null }) {
  const pageKey = account ? `${STORAGE_KEY}:${account.userId}` : STORAGE_KEY;
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
  const ear = useRef<Conversation | null>(null);
  const hearing = useRef(false);
  const inFlight = useRef<{ trigger: TutorRequest["trigger"]; speech: string | null; abort: AbortController } | null>(null);
  const lastPenAt = useRef(0);
  const sessionId = useRef("");
  const lasso = useRef<[number, number][] | null>(null);

  const [tool, setTool] = useState<Tool>("pen");
  const [problem, setProblem] = useState("");
  const [tutorState, setTutorState] = useState<TutorState>("idle");
  const [caption, setCaption] = useState("Write your problem anywhere on the page. I'll be right here.");
  const [muted, setMuted] = useState(false);
  const [canListen, setCanListen] = useState(false);
  // The mic turns on with the first touch of the page, unless the student turned it off.
  const [micOn, setMicOn] = useState(false);
  const micDeclined = useRef(false);
  const [heard, setHeard] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("study");
  const [panelOpen, setPanelOpen] = useState(false);
  const [keepDraft, setKeepDraft] = useState<KeepDraft | null>(null);
  const [run, setRun] = useState<ReviewRun | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const { memory, memoryRef, update: updateMemory, storageFull, loaded } = useStudyMemory(account);

  // Re-check what's due every minute, as well as whenever cards change.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  const now = useMemo(() => new Date(), [memory, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const due = useMemo(() => dueCards(memory.cards, now), [memory, now]);
  const currentCard: ReviewCard | null = run ? (memory.cards.find((c) => c.id === run.ids[run.index]) ?? null) : null;

  const stateRef = useRef({ tutorState, problem, muted, mode, currentCard });
  stateRef.current = { tutorState, problem, muted, mode, currentCard };

  // ---------- persistence ----------
  useEffect(() => {
    sessionId.current = crypto.randomUUID();
    setCanListen(speechInputSupported());
    ear.current = new Conversation({
      onUtterance: (text) => askTutor("spoke", text),
      onHearing: (h) => {
        hearing.current = h;
        setHeard(h);
      },
      onBlocked: (reason) => {
        micDeclined.current = true;
        setMicOn(false);
        setError(reason);
      },
    });
    document.fonts?.ready.then(() => (dirty.current = true));
    restorePage();
    // In research mode the account copy of the page wins, unless the tester
    // has already started writing before it arrived.
    if (account) {
      const before = strokes.current.length;
      loadCloud(account.userId, "page")
        .then((page) => {
          if (stateRef.current.mode !== "study" || strokes.current.length !== before || !page) return;
          applyPage(page as SavedPage);
          try {
            localStorage.setItem(pageKey, JSON.stringify(page));
          } catch {
            // Local copy is only a cache.
          }
        })
        .catch(() => {
          // Offline: the local copy is shown and syncs on the next save.
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyPage = (saved: SavedPage | null) => {
    strokes.current = saved?.strokes ?? [];
    tutorInk.current = (saved?.tutorInk ?? []).map((t) => ({ ...t, born: 0 }));
    paths.current.clear();
    tutorPaths.current.clear();
    setProblem(saved?.problem ?? "");
    undoStack.current = [];
    dirty.current = true;
  };

  // The study page lives in storage; a review session uses a scratch page
  // and puts the study page back when it ends.
  const restorePage = () => {
    let saved: SavedPage | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(pageKey) ?? "null");
    } catch {
      // A blocked or corrupt store just means a fresh page.
    }
    applyPage(saved);
  };

  // Mention due cards once, when the page opens, like a tutor starting with a warm-up.
  const greeted = useRef(false);
  useEffect(() => {
    if (greeted.current || !loaded) return;
    greeted.current = true;
    const n = dueCards(memoryRef.current.cards, new Date()).length;
    if (n) setCaption(`Welcome back. ${n} review card${n === 1 ? " is" : "s are"} due. Want to warm up with Review first?`);
  }, [loaded, memoryRef]);

  const save = useCallback(() => {
    if (stateRef.current.mode === "review") return;
    const page: SavedPage = { strokes: strokes.current, tutorInk: tutorInk.current, problem: stateRef.current.problem };
    if (account) saveCloud(account.userId, "page", page);
    try {
      localStorage.setItem(pageKey, JSON.stringify(page));
    } catch {
      // Storage is a convenience; the page keeps working without it.
    }
  }, [account, pageKey]);

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
      if (lasso.current && lasso.current.length > 1) {
        ctx.save();
        ctx.strokeStyle = "rgba(37, 99, 235, 0.8)";
        ctx.lineWidth = 1.5 / cam.z;
        ctx.setLineDash([6 / cam.z, 5 / cam.z]);
        ctx.beginPath();
        lasso.current.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
        ctx.restore();
      }
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
      const busy = inFlight.current;
      if (busy) {
        // A glance at the page waits its turn; the student's own words never do.
        if (trigger === "pause") return;
        busy.abort.abort();
        // If they spoke twice before the tutor answered, it hears both.
        if (busy.speech && trigger === "spoke") speech = `${busy.speech} ${speech ?? ""}`.trim();
      }
      if (pauseTimer.current) clearTimeout(pauseTimer.current);
      const lines = groupLines(strokes.current);
      if (!lines.length && !speech && !stateRef.current.problem.trim()) return;
      if (trigger !== "pause") stopSpeaking();

      const abort = new AbortController();
      const mine = { trigger, speech, abort };
      inFlight.current = mine;
      changedSinceTutor.current = false;
      setTutorState("thinking");
      setError(null);
      try {
        const res = await fetch("/api/tutor", {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: abort.signal,
          body: JSON.stringify({
            sessionId: sessionId.current,
            mode: stateRef.current.mode,
            review:
              stateRef.current.mode === "review" && stateRef.current.currentCard
                ? {
                    concept: stateRef.current.currentCard.concept,
                    answerText: stateRef.current.currentCard.answerText,
                    answerImage: stateRef.current.currentCard.answerImage,
                  }
                : null,
            weakSpots: weakSpots(memoryRef.current, new Date()),
            problem: stateRef.current.problem,
            trigger,
            speech,
            idleSeconds: lastPenAt.current ? (Date.now() - lastPenAt.current) / 1000 : undefined,
            lines: lines.map((l) => ({ id: l.id, tokens: l.tokens.length })),
            ...renderPageImages(strokes.current, lines),
          } satisfies TutorRequest),
        });
        const data = await res.json();
        if (inFlight.current !== mine) return;
        inFlight.current = null;
        if (!res.ok && !data.say) throw new Error(data.error ?? `Tutor error ${res.status}`);
        // Don't talk over a student who started speaking while we looked.
        if (trigger === "pause" && hearing.current) {
          setTutorState("idle");
          return;
        }
        respond(data as PublicTurn, lines);
      } catch (e) {
        if (abort.signal.aborted) return; // replaced by a newer turn
        if (inFlight.current === mine) inFlight.current = null;
        setError(e instanceof Error ? e.message : "The tutor could not be reached.");
        settle();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const respond = (turn: PublicTurn, lines: InkLine[]) => {
    remember(turn);
    const write = turn.write ?? [];
    if (turn.move === "wait" || (!turn.say && !turn.annotations.length && !write.length)) {
      settle();
      return;
    }
    // The pen starts when the voice does, so the math appears as it is said.
    let ink: TutorInk | null = null;
    if (turn.annotations.length || write.length) {
      const cam = camera.current;
      const plan = planAnnotations(turn.annotations, lines, Math.floor(Math.random() * 2 ** 31), {
        write,
        avoid: tutorInk.current.map((t) => t.plan.box).filter((b): b is Box => b != null),
        origin: { x: cam.x, y: cam.y + 60 / cam.z },
      });
      if (plan.strokes.length) {
        ink = { id: crypto.randomUUID(), plan, born: Infinity };
        tutorInk.current.push(ink);
        revealIfOffscreen(plan);
      }
    }
    const startPen = () => {
      if (ink && ink.born === Infinity) ink.born = performance.now();
      dirty.current = true;
    };
    dirty.current = true;
    save();
    if (turn.say) setCaption(turn.say);
    if (!turn.say || stateRef.current.muted) {
      startPen();
      settle();
      return;
    }
    setTutorState("speaking");
    ear.current?.pause();
    setTimeout(startPen, 2500); // if the voice is slow to start, write anyway
    speak(turn.say, settle, startPen);
  };

  // Stop talking now (a new page, a new card) and go back to listening.
  const hush = () => {
    stopSpeaking();
    inFlight.current?.abort.abort();
    inFlight.current = null;
    setTutorState("idle");
    stateRef.current.tutorState = "idle";
    ear.current?.resume();
  };

  // Back to listening and watching after a turn.
  const settle = () => {
    setTutorState("idle");
    stateRef.current.tutorState = "idle";
    ear.current?.resume();
    if (changedSinceTutor.current) schedulePause();
  };

  // What a turn teaches us about the student: mastery evidence, a new review
  // card after a fixed mistake, or the result of a review attempt.
  const remember = (turn: PublicTurn) => {
    const at = new Date();
    if (stateRef.current.mode === "study") {
      if (turn.skill?.concept) {
        updateMemory((m) => ({ ...m, skills: recordEvidence(m.skills, turn.skill.concept, turn.skill.evidence, sessionId.current, at) }));
      }
      const c = turn.card;
      if (c?.prompt && shouldAddMistakeCard(memoryRef.current.cards, c.concept, sessionId.current, at)) {
        const card = newCard(
          { concept: c.concept, source: "mistake", prompt: c.prompt, takeaway: c.takeaway, sessionId: sessionId.current },
          at,
          crypto.randomUUID(),
        );
        updateMemory((m) => ({ ...m, cards: [...m.cards, card] }));
        logEvent(account, "card_created", { source: "mistake", concept: card.concept, card_id: card.id }, sessionId.current);
        flash(`Saved a review card on ${card.concept}`);
      }
    } else if (turn.review_result) {
      const grade = OUTCOME_RATING[turn.review_result];
      setRun((r) => (r ? { ...r, suggested: grade, revealed: true } : r));
    }
  };

  const flash = (text: string) => {
    setToast(text);
    setTimeout(() => setToast((t) => (t === text ? null : t)), 3500);
  };

  // ---------- review ----------
  const freshPage = () => {
    strokes.current = [];
    tutorInk.current = [];
    paths.current.clear();
    tutorPaths.current.clear();
    undoStack.current = [];
    sessionId.current = crypto.randomUUID();
    changedSinceTutor.current = false;
    if (pauseTimer.current) clearTimeout(pauseTimer.current);
    dirty.current = true;
  };

  const startReview = () => {
    const ids = dueCards(memoryRef.current.cards, new Date())
      .slice(0, 20)
      .map((c) => c.id);
    if (!ids.length) return;
    save();
    hush();
    setPanelOpen(false);
    stateRef.current.mode = "review";
    setMode("review");
    freshPage();
    const first = memoryRef.current.cards.find((c) => c.id === ids[0])!;
    setProblem(first.prompt);
    setRun({ ids, index: 0, suggested: null, revealed: false, done: 0 });
    logEvent(account, "review_started", { due: ids.length }, null);
    setTool("pen");
    setCaption(`From memory: ${first.prompt}`);
  };

  const nextCard = (grade: Grade | null) => {
    if (!run) return;
    const id = run.ids[run.index];
    const card = memoryRef.current.cards.find((c) => c.id === id);
    if (grade != null) {
      updateMemory((m) => ({ ...m, cards: m.cards.map((c) => (c.id === id ? gradeCard(c, grade, new Date()) : c)) }));
    }
    logEvent(
      account,
      "review_graded",
      {
        card_id: id,
        concept: card?.concept,
        source: card?.source,
        rating: grade,
        suggested: run.suggested,
        skipped: grade == null,
        prior_reviews: card?.reviews.length ?? 0,
      },
      sessionId.current,
    );
    hush();
    const index = run.index + 1;
    const done = run.done + (grade != null ? 1 : 0);
    if (index >= run.ids.length) {
      finishReview(done);
      return;
    }
    freshPage();
    const nextUp = memoryRef.current.cards.find((c) => c.id === run.ids[index]);
    setProblem(nextUp?.prompt ?? "");
    setRun({ ...run, index, suggested: null, revealed: false, done });
    setCaption(nextUp ? `Next one: ${nextUp.prompt}` : "");
  };

  const finishReview = (done: number) => {
    stateRef.current.mode = "study";
    setMode("study");
    setRun(null);
    restorePage();
    sessionId.current = crypto.randomUUID();
    const upcoming = memoryRef.current.cards.map((c) => new Date(c.fsrs.due).getTime()).filter((d) => d > Date.now());
    const next = upcoming.length ? Math.min(...upcoming) : null;
    setCaption(
      done
        ? `Nice work: ${done} card${done === 1 ? "" : "s"} reviewed.${next ? ` The next one comes back ${whenText(next, new Date())}.` : ""}`
        : "Back to your page.",
    );
  };

  const importDeck = (notes: AnkiNote[], fileName: string) => {
    const at = new Date();
    const seen = new Set(memoryRef.current.cards.filter((c) => c.source === "anki").map((c) => `${c.deck}\u0000${c.prompt}`));
    const cards = notes
      .filter((n) => !seen.has(`${n.deck}\u0000${n.front}`))
      .map((n) =>
        newCard(
          {
            concept: n.tags.find((t) => !/^(leech|marked)$/i.test(t))?.replace(/[_-]+/g, " ") ?? n.deck.split("::").pop() ?? fileName,
            source: "anki",
            prompt: n.front,
            answerText: n.back || null,
            takeaway: n.back || null,
            deck: n.deck,
          },
          at,
          crypto.randomUUID(),
        ),
      );
    if (cards.length) updateMemory((m) => ({ ...m, cards: [...m.cards, ...cards] }));
    logEvent(account, "deck_imported", { notes: notes.length, added: cards.length }, null);
    return cards.length;
  };

  const saveKept = () => {
    if (!keepDraft) return;
    const card = newCard(
      {
        concept: keepDraft.concept || "my notes",
        source: "kept",
        prompt: keepDraft.prompt.trim() || "Write this out again from memory.",
        answerImage: keepDraft.image,
      },
      new Date(),
      crypto.randomUUID(),
    );
    updateMemory((m) => ({ ...m, cards: [...m.cards, card] }));
    logEvent(account, "card_created", { source: "kept", concept: card.concept, card_id: card.id }, sessionId.current);
    setKeepDraft(null);
    setTool("pen");
    flash("Kept as a review card. It comes back tomorrow-ish, then less often.");
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

  // Look at the page shortly after the pen lifts, whether or not the mic is on.
  // While the tutor is talking or the student is mid-sentence it holds off;
  // the next turn sees the page anyway.
  const schedulePause = () => {
    if (pauseTimer.current) clearTimeout(pauseTimer.current);
    pauseTimer.current = setTimeout(() => {
      if (!changedSinceTutor.current || drawing.current) return;
      if (stateRef.current.tutorState === "speaking" || hearing.current) return schedulePause();
      askTutor("pause");
    }, WATCH_MS);
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
    glide.current = null;
    // The first touch of the page starts the conversation.
    if (!ear.current?.active && !micDeclined.current && speechInputSupported()) {
      ear.current?.start();
      setMicOn(true);
      if (stateRef.current.tutorState === "speaking") ear.current?.pause();
    }

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

    if (tool === "keep") {
      lasso.current = [screenToWorld(camera.current, sx, sy)];
      return;
    }

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

    if (lasso.current && tool === "keep") {
      lasso.current.push(screenToWorld(camera.current, sx, sy));
      dirty.current = true;
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
    if (lasso.current) {
      const picked = strokesInLasso(strokes.current, lasso.current);
      lasso.current = null;
      dirty.current = true;
      if (picked.length) {
        setKeepDraft({ image: renderInkImage(picked, 640), prompt: "", concept: "" });
      } else {
        flash("Draw a loop around the writing you want to keep.");
      }
      return;
    }
    const d = drawing.current;
    if (d && d.pointerId === e.pointerId) {
      drawing.current = null;
      paths.current.delete(d.stroke.id); // rebuild with the finished tail
      changedSinceTutor.current = true;
      lastPenAt.current = Date.now();
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
      if (e.key === "k" && stateRef.current.mode === "study") setTool("keep");
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
    hush();
    undoStack.current.push([...strokes.current]);
    strokes.current = [];
    tutorInk.current = [];
    paths.current.clear();
    tutorPaths.current.clear();
    sessionId.current = crypto.randomUUID();
    dirty.current = true;
    save();
  };

  const toggleMic = () => {
    if (ear.current?.active) {
      ear.current.stop();
      micDeclined.current = true;
      setMicOn(false);
      return;
    }
    micDeclined.current = false;
    setError(null);
    ear.current?.start();
    setMicOn(true);
    if (stateRef.current.tutorState === "speaking") ear.current?.pause();
  };

  // Tapping the tutor while it talks cuts it short, like raising a hand.
  const interrupt = () => {
    if (stateRef.current.tutorState !== "speaking") return;
    stopSpeaking();
    tutorInk.current.forEach((t) => t.born === Infinity && (t.born = performance.now()));
    settle();
  };

  const status =
    tutorState === "speaking"
      ? "Tap to interrupt"
      : tutorState === "thinking"
        ? inFlight.current?.trigger === "pause"
          ? "Looking"
          : "Thinking"
        : heard
          ? "Hearing you"
          : micOn
            ? "Listening"
            : "";

  return (
    <div className="shell">
      <header className="bar">
        <span className="brand">Tutor</span>
        {mode === "review" && run && currentCard ? (
          <div className="card-now" aria-live="polite">
            <span className="card-meta">
              Card {run.index + 1} of {run.ids.length} · {currentCard.concept}
            </span>
            <p className="card-prompt">{currentCard.prompt}</p>
            {run.revealed && (currentCard.takeaway || currentCard.answerImage) && (
              <div className="card-answer">
                {currentCard.answerImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={currentCard.answerImage} alt="The writing you kept for this card" />
                ) : (
                  <p>{currentCard.takeaway}</p>
                )}
              </div>
            )}
          </div>
        ) : (
          <input
            className="problem"
            value={problem}
            placeholder="What are we working on? (optional)"
            onChange={(e) => setProblem(e.target.value)}
            onBlur={save}
          />
        )}
        <div className="tools" role="toolbar" aria-label="Drawing tools">
          {(["pen", "eraser", "hand", "keep"] as Tool[])
            .filter((t) => mode === "study" || t !== "keep")
            .map((t) => (
              <button
                key={t}
                className={tool === t ? "on" : ""}
                onClick={() => setTool(t)}
                aria-pressed={tool === t}
                title={t === "keep" ? "Draw a loop around writing to keep it as a review card" : undefined}
              >
                {t === "pen" ? "Pen" : t === "eraser" ? "Eraser" : t === "hand" ? "Move" : "Keep"}
              </button>
            ))}
          <button onClick={undo}>Undo</button>
          <button onClick={clearPage}>Clear</button>
          {mode === "study" ? (
            <button className={panelOpen ? "on" : ""} onClick={() => setPanelOpen((o) => !o)} aria-expanded={panelOpen}>
              Review{due.length ? <span className="badge">{due.length}</span> : null}
            </button>
          ) : (
            <button onClick={() => finishReview(run?.done ?? 0)}>End review</button>
          )}
        </div>
        {account && <AccountMenu account={account} sessionId={sessionId} onSignOut={flushCloud} />}
      </header>

      {panelOpen && mode === "study" && (
        <ReviewPanel
          memory={memory}
          due={due.length}
          storageFull={storageFull}
          onStart={startReview}
          onImport={importDeck}
          onClose={() => setPanelOpen(false)}
        />
      )}

      {keepDraft && (
        <form
          className="keep"
          onSubmit={(e) => {
            e.preventDefault();
            saveKept();
          }}
        >
          <h2>Keep as a review card</h2>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={keepDraft.image} alt="The writing you circled" />
          <label>
            What should I ask you later?
            <input
              autoFocus
              value={keepDraft.prompt}
              placeholder="e.g. Differentiate sin(x²)"
              onChange={(e) => setKeepDraft({ ...keepDraft, prompt: e.target.value })}
            />
          </label>
          <label>
            Topic
            <input
              value={keepDraft.concept}
              placeholder="e.g. chain rule"
              onChange={(e) => setKeepDraft({ ...keepDraft, concept: e.target.value })}
            />
          </label>
          <div className="keep-actions">
            <button type="button" onClick={() => setKeepDraft(null)}>
              Cancel
            </button>
            <button type="submit" className="primary">
              Keep card
            </button>
          </div>
        </form>
      )}

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}

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

      <footer className={mode === "review" ? "tutor reviewing" : "tutor"}>
        <button
          className={`presence ${tutorState}${heard ? " hearing" : micOn ? " listening" : ""}`}
          onClick={interrupt}
          aria-label={tutorState === "speaking" ? "Stop talking" : "Tutor"}
          title={status}
        />
        <div className="caption-wrap">
          <p className="caption" aria-live="polite">
            {error ?? caption}
          </p>
          {status && <span className="status">{status}</span>}
        </div>
        {mode === "review" && run && (
          <div className="grades" role="group" aria-label="How well did you remember?">
            {run.revealed ? (
              <>
                <span className="grades-label">How did it go?</span>
                {GRADES.map((g) => (
                  <button key={g} className={run.suggested === g ? "on" : ""} onClick={() => nextCard(g)}>
                    {RATING_LABEL[g]}
                  </button>
                ))}
              </>
            ) : (
              <>
                <button onClick={() => askTutor("spoke", "I'm done with this card. Can you check it?")} disabled={tutorState === "thinking"}>
                  Check my answer
                </button>
                <button onClick={() => setRun({ ...run, revealed: true })}>Show answer</button>
                <button onClick={() => nextCard(null)}>Skip</button>
              </>
            )}
          </div>
        )}
        <div className="actions">
          {canListen && (
            <button className={micOn ? "talk on" : "talk"} onClick={toggleMic} aria-pressed={micOn}>
              {micOn ? "Mic on" : "Mic off"}
            </button>
          )}
          <button onClick={() => askTutor("asked")} disabled={tutorState === "thinking"}>
            I&apos;m stuck
          </button>
          <button
            onClick={() => {
              setMuted((m) => !m);
              hush();
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

// A small picture of some of the student's ink, for a kept review card.
function renderInkImage(strokes: Stroke[], maxSize: number): string {
  let box = { x: Infinity, y: Infinity, w: 0, h: 0 };
  let x2 = -Infinity, y2 = -Infinity;
  for (const s of strokes)
    for (const [x, y] of s.points) {
      box.x = Math.min(box.x, x);
      box.y = Math.min(box.y, y);
      x2 = Math.max(x2, x);
      y2 = Math.max(y2, y);
    }
  const margin = 16;
  box = { x: box.x - margin, y: box.y - margin, w: x2 - box.x + 2 * margin, h: y2 - box.y + 2 * margin };
  const scale = Math.min(1.5, maxSize / box.w, maxSize / box.h);
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(box.w * scale);
  canvas.height = Math.ceil(box.h * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, -box.x * scale, -box.y * scale);
  ctx.fillStyle = STUDENT_INK;
  for (const s of strokes) {
    const outline = getStroke(s.points, { size: s.size, thinning: 0.6, smoothing: 0.55, streamline: 0.45 });
    if (outline.length) ctx.fill(outlinePath(outline));
  }
  return canvas.toDataURL("image/png");
}
