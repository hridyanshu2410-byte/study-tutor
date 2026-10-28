"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getStroke } from "perfect-freehand";
import {
  distanceToStroke,
  groupLines,
  screenToWorld,
  strokesInLasso,
  unionBox,
  zoomAt,
  type Camera,
  type InkLine,
  type Point,
  type Stroke,
} from "@/lib/ink";
import type { Beat, PublicTurn, TurnEnd, TutorRequest } from "@/lib/tutor";
import { retime, speechMs, strokeAt, TurnPlanner, type Mark, type PenPlan } from "@/lib/handwriting";
import type { Box } from "@/lib/ink";
import { Conversation, keepClips, keptClip, prepareClip, speechInputSupported, stopSpeaking, type Clip } from "@/lib/voice";
import { ALL_LINES, thinkingAloud } from "@/lib/thinking-aloud";
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
import SessionSurvey from "./SessionSurvey";
import { flushCloud, loadCloud, logEvent, saveCloud, type Account } from "@/lib/cloud";
import { picturesFrom, type PageImage } from "@/lib/photo";
import { drawSim, playButton, runSeconds, SIM_H, SIM_W, simResult, type PageSim } from "@/lib/sims";
import { findSentence, paperDigest, type Paper } from "@/lib/paper";
import { openPaper } from "@/lib/paper-pdf";
import { deletePaper, loadPaper, savePaper } from "@/lib/paper-store";

type Tool = "pen" | "eraser" | "hand" | "keep";
type Mode = "study" | "review";
type KeepDraft = { image: string; prompt: string; concept: string };
type ReviewRun = { ids: string[]; index: number; suggested: Grade | null; revealed: boolean; done: number };

const GRADES: Grade[] = [1, 2, 3, 4] as Grade[];
type TutorState = "idle" | "thinking" | "speaking";

// One phrase's worth of tutor pen strokes. `born` is when the pen started, in
// performance.now() time; 0 means already fully written (e.g. restored), and
// Infinity means waiting to start with the voice.
// `marks` are passages it highlighted in a paper, shown as the pen starts.
type TutorInk = { id: string; plan: PenPlan; born: number; marks?: Box[]; rules?: Box[] };
// One spoken phrase of a turn: its words, its ink and its voice, and how far along it is.
// `region` is everything the phrase marks or draws; `figure` the whole of the figure it draws or adds to.
type Act = { beat: Beat; ink: TutorInk | null; clip: Clip | null; region: Box | null; figure: Box | null; started: boolean; voiceDone: boolean; inkDone: boolean };
// A turn being performed. Phrases keep arriving while earlier ones are spoken;
// each one's ink is drawn while its words are heard, and the next follows
// when both are done.
type Show = {
  trigger: TutorRequest["trigger"];
  lines: InkLine[];
  planner: TurnPlanner;
  acts: Act[];
  next: number;
  playing: Act | null;
  // between two phrases, taking a breath
  breathing: boolean;
  end: TurnEnd | null;
  // everything the turn has said, and the sentence being said (it can run over several phrases)
  said: string;
  sentence: string;
  // the caption as it stands
  shown: string;
  timers: ReturnType<typeof setTimeout>[];
  // what of the turn is kept in view, and the figure it is drawing
  region: Box | null;
  figure: Box | null;
};
// Which paper is open and where its pages start; the paper itself lives in IndexedDB.
type PaperRef = { id: string; title: string; x: number; y: number; w: number };
type SavedPage = { strokes: Stroke[]; tutorInk: TutorInk[]; problem: string; images?: PageImage[]; sims?: PageSim[]; paper?: PaperRef | null };
// An open paper: its pages laid out in a column on the page.
type OpenPaper = { ref: PaperRef; data: Paper; pages: PageImage[]; digest: { text: string; truncated: boolean } };
const PAPER_W = 700;
const PAPER_GAP = 28;
// Reading a paper, the tutor waits longer before glancing at new writing.
const PAPER_WATCH_MS = 3500;

// What happened this session, for the wrap-up summary.
type SessionStats = { startedAt: number; turns: number; concepts: Record<string, { slips: number; solved: number }>; cards: string[] };
const newStats = (): SessionStats => ({ startedAt: Date.now(), turns: 0, concepts: {}, cards: [] });
// Where the student double-tapped to point, in page coordinates.
type Focus = { world: [number, number]; at: number };
const FOCUS_MS = 8000;

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
  // Photos and PDF pages under the ink, and their decoded pictures.
  const images = useRef<PageImage[]>([]);
  const imageEls = useRef(new Map<string, HTMLImageElement>());
  // Simulations on the page, and when each one started playing.
  const sims = useRef<PageSim[]>([]);
  const simRuns = useRef(new Map<string, number>());
  const tutorFont = useRef("cursive");
  const paper = useRef<OpenPaper | null>(null);
  const camera = useRef<Camera>({ x: -40, y: -40, z: 1 });
  // The turn the tutor is saying and drawing right now.
  const show = useRef<Show | null>(null);
  // A short line said while the tutor thinks ("let's see"), until its answer starts.
  const aside = useRef<{ clip: Clip; speaking: boolean } | null>(null);
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
  const stats = useRef<SessionStats>(newStats());
  const focus = useRef<Focus | null>(null);
  const lastTap = useRef<{ x: number; y: number; at: number; strokeId: string } | null>(null);
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
  const [summary, setSummary] = useState<{ recap: string; stats: SessionStats } | null>(null);
  const [hasPhoto, setHasPhoto] = useState(false);
  const [paperTitle, setPaperTitle] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const paperInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);
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
    stats.current = newStats();
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
    tutorFont.current = `${getComputedStyle(document.documentElement).getPropertyValue("--font-tutor").trim() || "cursive"}, cursive`;
    restorePage();
    // the voices of the things said while thinking, fetched once so they come out at once
    const warm = setTimeout(() => !stateRef.current.muted && keepClips(ALL_LINES), 2500);
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
    return () => clearTimeout(warm);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyPage = (saved: SavedPage | null) => {
    strokes.current = saved?.strokes ?? [];
    tutorInk.current = (saved?.tutorInk ?? []).map((t) => ({ ...t, born: 0 }));
    setImages(saved?.images ?? []);
    sims.current = saved?.sims ?? [];
    simRuns.current.clear();
    setPaper(null);
    const ref = saved?.paper;
    if (ref)
      loadPaper(ref.id).then((data) => {
        if (data) setPaper(layoutPaper(data, ref));
        else setCaption(`Open "${ref.title}" again with Study a paper to keep reading it here.`);
      });
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
    // ink for phrases not yet spoken isn't on the page yet
    const ink = tutorInk.current.filter((t) => t.born !== Infinity);
    const page: SavedPage = { strokes: strokes.current, tutorInk: ink, problem: stateRef.current.problem, images: images.current, sims: sims.current, paper: paper.current?.ref ?? null };
    if (account) saveCloud(account.userId, "page", page);
    try {
      localStorage.setItem(pageKey, JSON.stringify(page));
    } catch {
      // Storage is a convenience; the page keeps working without it.
    }
  }, [account, pageKey]);

  const layoutPaper = (data: Paper, ref: PaperRef): OpenPaper => {
    let y = ref.y;
    const pages = data.pages.map((p) => {
      const h = (ref.w * p.h) / p.w;
      const img: PageImage = { id: `paper:${data.id}:${p.n}`, src: p.src, x: ref.x, y, w: ref.w, h };
      y += h + PAPER_GAP;
      return img;
    });
    return { ref, data, pages, digest: paperDigest(data) };
  };
  const setPaper = (next: OpenPaper | null) => {
    paper.current = next;
    setPaperTitle(next?.ref.title ?? null);
    dirty.current = true;
  };
  // The paper's page boxes on the page, by page number.
  const paperPage = (n: number) => {
    const p = paper.current;
    const i = p ? p.data.pages.findIndex((pg) => pg.n === n) : -1;
    return p && i >= 0 ? p.pages[i] : null;
  };
  // What part of the page is on screen, in page coordinates.
  const viewBox = (): Box => {
    const c = canvasRef.current, cam = camera.current;
    return { x: cam.x, y: cam.y, w: (c?.clientWidth ?? 1200) / cam.z, h: (c?.clientHeight ?? 800) / cam.z };
  };
  const visiblePages = (): number[] => {
    const p = paper.current, v = viewBox();
    if (!p) return [];
    return p.data.pages
      .filter((_, i) => {
        const b = p.pages[i];
        return b.y < v.y + v.h - 80 / camera.current.z && b.y + b.h > v.y + 60 / camera.current.z && b.x < v.x + v.w && b.x + b.w > v.x;
      })
      .map((pg) => pg.n);
  };

  const setImages = (next: PageImage[]) => {
    images.current = next;
    for (const id of imageEls.current.keys()) if (!next.some((i) => i.id === id)) imageEls.current.delete(id);
    setHasPhoto(next.length > 0);
    dirty.current = true;
  };

  // The decoded picture for a page image, once it has loaded.
  const pictureFor = (img: PageImage): HTMLImageElement | null => {
    let el = imageEls.current.get(img.id);
    if (!el) {
      el = new Image();
      el.onload = () => (dirty.current = true);
      el.src = img.src;
      imageEls.current.set(img.id, el);
    }
    return el.complete && el.naturalWidth ? el : null;
  };
  const loadedPictures = () =>
    images.current.flatMap((img) => {
      const el = pictureFor(img);
      return el ? [{ img, el }] : [];
    });

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
        const f = Math.min(1, (now - g.start) / (g.to.z === g.from.z ? 450 : 800));
        const e = f * f * (3 - 2 * f);
        // zoom about the point that ends up fixed, so the move reads as one smooth motion
        const z = g.from.z * Math.pow(g.to.z / g.from.z, e);
        const k = g.to.z === g.from.z ? e : (1 / g.from.z - 1 / z) / (1 / g.from.z - 1 / g.to.z);
        camera.current = { x: g.from.x + (g.to.x - g.from.x) * k, y: g.from.y + (g.to.y - g.from.y) * k, z };
        if (f === 1) glide.current = null;
        dirty.current = true;
      }
      const animating = simRuns.current.size > 0 || tutorInk.current.some((t) => t.born > 0 && t.born !== Infinity && now - t.born < t.plan.duration + 50);
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
      for (const img of paper.current?.pages ?? []) drawPicture(ctx, img, pictureFor(img), cam.z);
      for (const img of images.current) drawPicture(ctx, img, pictureFor(img), cam.z);
      for (const sim of sims.current) {
        const start = simRuns.current.get(sim.id);
        const t = start == null ? null : (now - start) / 1000;
        drawSim(ctx, sim, t, tutorFont.current, cam.z);
        if (t != null && t >= runSeconds(sim.spec)) {
          simRuns.current.delete(sim.id);
          setTimeout(() => finishSim(sim), 0);
        }
      }
      for (const s of strokes.current) {
        ctx.fillStyle = s.color;
        ctx.fill(pathFor(s, drawing.current?.stroke.id === s.id ? drawing.current.simulate : false));
      }
      for (const t of tutorInk.current) drawTutorInk(ctx, t, now, tutorPaths.current);
      if (focus.current && Date.now() - focus.current.at < FOCUS_MS) {
        const [fx, fy] = focus.current.world;
        ctx.save();
        ctx.strokeStyle = "rgba(37, 99, 235, 0.7)";
        ctx.lineWidth = 2 / cam.z;
        ctx.beginPath();
        ctx.arc(fx, fy, 14 / cam.z, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
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
    async (trigger: TutorRequest["trigger"], speech: string | null = null, watched: string | null = null) => {
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
      if (!lines.length && !speech && !watched && !stateRef.current.problem.trim() && !images.current.length && !paper.current) return;
      if (trigger !== "pause") {
        stopShow();
        stopSpeaking();
        quietAside();
      } else if (show.current) return; // never glance while still talking

      const abort = new AbortController();
      const mine = { trigger, speech, abort };
      inFlight.current = mine;
      changedSinceTutor.current = false;
      setTutorState("thinking");
      setError(null);
      // Something natural, said at once while the answer is worked out, unless the answer starts first.
      const line = trigger === "pause" || stateRef.current.muted ? null : thinkingAloud(trigger, speech, paper.current?.ref.title ?? null);
      if (line) {
        const clip = keptClip(line.text);
        setTimeout(() => {
          if (inFlight.current !== mine || show.current?.acts.some((a) => a.started)) return clip.stop();
          sayAside(clip, line.text);
        }, line.after);
      }
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
            watched,
            idleSeconds: lastPenAt.current ? (Date.now() - lastPenAt.current) / 1000 : undefined,
            focus: trigger === "pause" ? null : focusOn(lines),
            hasPhoto: images.current.length > 0,
            paper: paper.current
              ? {
                  title: paper.current.ref.title,
                  text: paper.current.digest.text,
                  truncated: paper.current.digest.truncated,
                  visiblePages: visiblePages(),
                  pointedAt: trigger === "pause" ? null : sentenceAt(),
                }
              : null,
            lines: lines.map((l) => ({ id: l.id, tokens: l.tokens.length })),
            ...(paper.current
              ? {
                  pageImage: renderViewImage(viewBox(), [...(paper.current.pages ?? []), ...images.current], pictureFor, strokes.current, tutorInk.current),
                  tokenImage: renderPageImages(strokes.current, lines).tokenImage,
                }
              : renderPageImages(strokes.current, lines, loadedPictures())),
          } satisfies TutorRequest),
        });
        if (inFlight.current !== mine) return;
        const answered = () => {
          stats.current.turns++;
          if (trigger !== "pause" && focus.current) {
            focus.current = null; // the pointing has been answered
            dirty.current = true;
          }
        };
        if (!res.ok || !res.body || !(res.headers.get("content-type") ?? "").includes("ndjson")) {
          // a whole turn at once: an error, or a canned reply such as the daily limit
          const data = (await res.json()) as Partial<PublicTurn> & { error?: string };
          if (inFlight.current !== mine) return;
          inFlight.current = null;
          answered();
          if (!res.ok && !data.say) throw new Error(data.error ?? `Tutor error ${res.status}`);
          if (trigger === "pause" && hearing.current) return settle();
          const s = beginShow(trigger, lines);
          for (const b of data.beats ?? []) addBeat(s, b);
          endShow(s, data as TurnEnd);
          return;
        }
        // The turn arrives phrase by phrase; the first is spoken while the rest is still being written.
        answered();
        let s: Show | null = null;
        // voices fetched for phrases whose ink is still coming
        const ahead = new Map<string, Clip>();
        try {
          for await (const event of readLines(res.body)) {
            if (inFlight.current !== mine) return;
            const e = event as { upcoming?: string; beat?: Beat; turn?: TurnEnd; error?: string };
            if (e.error) throw new Error(e.error);
            if (e.upcoming) {
              if (!stateRef.current.muted && !ahead.has(e.upcoming) && !(trigger === "pause" && hearing.current)) ahead.set(e.upcoming, prepareClip(e.upcoming));
              continue;
            }
            if (!s && (e.beat || e.turn)) {
              // Don't talk over a student who started speaking while we looked.
              if (trigger === "pause" && hearing.current) {
                abort.abort();
                inFlight.current = null;
                return settle();
              }
              s = beginShow(trigger, lines);
            }
            if (s && e.beat) addBeat(s, e.beat, ahead);
            else if (s && e.turn) endShow(s, e.turn);
          }
        } finally {
          for (const c of ahead.values()) c.stop();
        }
        if (inFlight.current === mine) inFlight.current = null;
        if (!s) return settle();
        // the stream broke off before the end of the turn: finish what was said
        if (!s.end) endShow(s, { move: "ask_plan", say: s.acts.map((a) => a.beat.say).join(" "), simulate: null, skill: { concept: "", evidence: "none" }, card: null, review_result: null });
      } catch (e) {
        if (abort.signal.aborted) return; // replaced by a newer turn
        if (inFlight.current === mine) inFlight.current = null;
        setError(e instanceof Error ? e.message : "The tutor could not be reached.");
        if (show.current?.acts.length) {
          // say what has arrived, then stop
          const s = show.current;
          if (!s.end) endShow(s, { move: "ask_plan", say: s.acts.map((a) => a.beat.say).join(" "), simulate: null, skill: { concept: "", evidence: "none" }, card: null, review_result: null });
        } else {
          stopShow();
          settle();
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // The paper sentence the student double-tapped, if they did so recently.
  const sentenceAt = (): string | null => {
    const f = focus.current, p = paper.current;
    if (!f || !p || Date.now() - f.at > FOCUS_MS) return null;
    const [x, y] = f.world;
    let best: { id: string; d: number } | null = null;
    p.data.pages.forEach((pg, i) => {
      const at = p.pages[i];
      if (x < at.x || x > at.x + at.w || y < at.y || y > at.y + at.h) return;
      const u = (x - at.x) / at.w, v = (y - at.y) / at.h;
      for (const sn of pg.sentences)
        for (const b of sn.boxes) {
          const d = Math.max(0, b.x - u, u - (b.x + b.w)) + Math.max(0, b.y - v, v - (b.y + b.h)) * 2;
          if (!best || d < best.d) best = { id: sn.id, d };
        }
    });
    const found = best as { id: string; d: number } | null;
    return found && found.d < 0.02 ? found.id : null;
  };

  // The line and token the student pointed at, if they did so recently.
  const focusOn = (lines: InkLine[]): TutorRequest["focus"] => {
    const f = focus.current;
    if (!f || Date.now() - f.at > FOCUS_MS) return null;
    const [x, y] = f.world;
    let best: { line: InkLine; d: number } | null = null;
    for (const l of lines) {
      const d = Math.max(0, l.box.y - y, y - (l.box.y + l.box.h)) + Math.max(0, l.box.x - x, x - (l.box.x + l.box.w)) * 0.3;
      if (!best || d < best.d) best = { line: l, d };
    }
    if (!best || best.d > 60) return null;
    let token: number | null = null, td = Infinity;
    for (const t of best.line.tokens) {
      const d = Math.hypot(t.box.x + t.box.w / 2 - x, t.box.y + t.box.h / 2 - y);
      if (d < td) [token, td] = [t.n, d];
    }
    return { line_id: best.line.id, token: td < 80 ? token : null };
  };

  // ---------- performing a turn ----------
  // The short line said while thinking. The answer's first phrase waits for it to end.
  const sayAside = (clip: Clip, text: string) => {
    quietAside();
    const mine = { clip, speaking: false };
    aside.current = mine;
    clip.play(
      () => {
        if (aside.current !== mine) return;
        mine.speaking = true;
        setTutorState("speaking");
        stateRef.current.tutorState = "speaking";
        ear.current?.pause();
        setCaption(text);
      },
      () => {
        if (aside.current !== mine) return;
        aside.current = null;
        const s = show.current;
        if (s && !s.playing && !s.breathing) {
          // a breath, then the answer
          s.breathing = true;
          later(s, () => playNext(s), 160);
        } else if (!s && inFlight.current) {
          setTutorState("thinking");
          stateRef.current.tutorState = "thinking";
        } else if (!s) settle();
      },
    );
    // a line that can't be said right away isn't worth waiting for
    setTimeout(() => {
      if (aside.current !== mine || mine.speaking) return;
      quietAside();
      const s = show.current;
      if (s && !s.playing && !s.breathing) playNext(s);
    }, 1200);
  };
  const quietAside = () => {
    aside.current?.clip.stop();
    aside.current = null;
  };

  const beginShow = (trigger: TutorRequest["trigger"], lines: InkLine[]): Show => {
    stopShow();
    const cam = camera.current;
    const p = paper.current;
    const planner = new TurnPlanner(lines, Math.floor(Math.random() * 2 ** 31), {
      avoid: tutorInk.current.flatMap((t) => (p && t.plan.parts ? t.plan.parts : t.plan.box ? [t.plan.box] : [])),
      origin: { x: cam.x, y: cam.y + 60 / cam.z },
      // the caption panel covers the bottom of the screen
      column: p ? { x: p.ref.x + p.ref.w + 70, top: Math.max(p.ref.y, cam.y + 80 / cam.z), bottom: cam.y + viewBox().h - 180 / cam.z } : undefined,
      size: p ? 19 : undefined,
    });
    const s: Show = { trigger, lines, planner, acts: [], next: 0, playing: null, breathing: false, end: null, said: "", sentence: "", shown: "", timers: [], region: null, figure: null };
    show.current = s;
    return s;
  };

  const later = (s: Show, fn: () => void, ms: number) => {
    s.timers.push(setTimeout(() => show.current === s && fn(), Math.max(0, ms)));
  };

  // A phrase has arrived: plan its ink and fetch its voice now (unless it is
  // already coming), so both are ready when its turn comes.
  const addBeat = (s: Show, beat: Beat, ahead?: Map<string, Clip>) => {
    if (show.current !== s) return;
    // Passages it points at in the paper, in page coordinates.
    const marks: Mark[] = beat.highlights.flatMap((h) => {
      const found = paper.current ? findSentence(paper.current.data, h.ref) : null;
      const at = found ? paperPage(found.page.n) : null;
      if (!found || !at) return [];
      const boxes = found.sentence.boxes.map((b) => ({ x: at.x + b.x * at.w - 2, y: at.y + b.y * at.h - 1, w: b.w * at.w + 4, h: b.h * at.h + 2 }));
      return boxes.length ? [{ boxes, kind: h.kind, note: h.note, edge: at.x + at.w }] : [];
    });
    const plan = s.planner.plan({
      annotations: beat.annotations,
      marks,
      write: beat.write,
      figures: beat.draw ? [beat.draw] : [],
      continueFigure: beat.continue_figure,
    });
    const rects = marks.filter((m) => m.kind === "highlight").flatMap((m) => m.boxes);
    // Paper lines sit close together, so an underline is a neat rule just under the baseline (boxes run to 1.2× the font height).
    const rules = marks.filter((m) => m.kind === "underline").flatMap((m) => m.boxes.map((b) => ({ x: b.x, y: b.y + (b.h - 2) / 1.2 + 2, w: b.w, h: 1.6 })));
    let ink: TutorInk | null = null;
    if (plan.strokes.length || rects.length || rules.length) {
      ink = { id: crypto.randomUUID(), plan, born: Infinity, marks: rects, rules };
      tutorInk.current.push(ink);
    }
    const region = [...marks.flatMap((m) => m.boxes), ...(plan.box ? [plan.box] : [])].reduce<Box | null>((a, b) => (a ? unionBox(a, b) : b), null);
    let clip = ahead?.get(beat.say) ?? null;
    ahead?.delete(beat.say);
    if (!clip && beat.say && !stateRef.current.muted) clip = prepareClip(beat.say);
    s.acts.push({ beat, ink, clip, region, figure: plan.figure ?? null, started: false, voiceDone: false, inkDone: !ink });
    // the answer came before the line said while thinking could start: skip that line
    if (aside.current && !aside.current.speaking) quietAside();
    if (!s.playing && !s.breathing && !aside.current) playNext(s);
  };

  // The rest of the turn is known: what it teaches about the student, and any simulation.
  const endShow = (s: Show, end: TurnEnd) => {
    if (show.current !== s || s.end) return;
    s.end = end;
    if (end.simulate) placeSim(end.simulate, s.lines);
    if (!s.playing && s.next >= s.acts.length) finishShow(s);
  };

  const playNext = (s: Show) => {
    if (show.current !== s) return;
    const act = s.acts[s.next];
    s.breathing = false;
    if (!act) {
      // caught up: the next phrase is still being written, or the turn is over
      s.playing = null;
      if (s.end) finishShow(s);
      return;
    }
    s.next++;
    s.playing = act;
    setTutorState("speaking");
    stateRef.current.tutorState = "speaking";
    ear.current?.pause();
    follow(s, act);
    const words = act.beat.say;
    const begin = (ms: number | null) => {
      if (act.started || show.current !== s) return;
      act.started = true;
      const speaking = words ? (ms ?? speechMs(words)) : 0;
      if (act.ink) {
        // the pen keeps pace so the phrase's ink is done about when its words are
        if (words) act.ink.plan = retime(act.ink.plan, Math.min(1, speaking / Math.max(1, act.ink.plan.duration)));
        act.ink.born = performance.now();
        later(s, () => {
          act.inkDone = true;
          after(s, act);
        }, act.ink.plan.duration);
      }
      fillCaption(s, words, speaking, () => act.voiceDone);
      if (!act.clip) later(s, () => {
        act.voiceDone = true;
        after(s, act);
      }, speaking);
      dirty.current = true;
    };
    if (act.clip) {
      act.clip.play(begin, () => {
        act.voiceDone = true;
        begin(0);
        // the words are all said, whatever the estimate was
        if (show.current === s) setCaption(s.shown);
        after(s, act);
      });
      // the voice never came: go on without it
      later(s, () => {
        if (act.started) return;
        act.clip?.stop();
        act.clip = null;
        act.voiceDone = false;
        begin(null);
      }, 7000);
    } else begin(null);
  };

  // A phrase is over once its words and its ink both are; a breath, then the next.
  const after = (s: Show, act: Act) => {
    if (show.current !== s || s.playing !== act || !act.voiceDone || !act.inkDone) return;
    s.playing = null;
    s.breathing = true;
    save();
    later(s, () => playNext(s), 160);
  };

  // The caption shows the sentence being said, filling in word by word as the
  // words are spoken (until `over`, when the voice has said them all).
  const fillCaption = (s: Show, text: string, ms: number, over: () => boolean) => {
    const words = text.split(/\s+/).filter(Boolean);
    if (!words.length) return;
    s.said = `${s.said} ${text}`.trim();
    const before = s.sentence;
    s.shown = `${before} ${text}`.trim();
    s.sentence = /[.?!]["'”’)]*$/.test(text.trim()) ? "" : s.shown;
    const total = words.reduce((n, w) => n + w.length + 1, 0);
    let at = 0;
    words.forEach((w, i) => {
      later(s, () => !over() && setCaption(`${before} ${words.slice(0, i + 1).join(" ")}`.trim()), (at / total) * ms * 0.92);
      at += w.length + 1;
    });
  };

  // Keeps what the turn draws in view: all of it while that is still readable,
  // otherwise the figure being drawn and the newest marks.
  const follow = (s: Show, act: Act) => {
    if (!act.region) return;
    if (act.figure) s.figure = act.figure;
    const canvas = canvasRef.current;
    const readable = (b: Box) => !canvas || Math.min((canvas.clientWidth - 80) / b.w, (canvas.clientHeight - 260) / b.h) >= 0.8;
    const all = s.region ? unionBox(s.region, act.region) : act.region;
    const drawing = s.figure ? unionBox(s.figure, act.region) : act.region;
    s.region = readable(all) ? all : readable(drawing) ? drawing : act.region;
    reveal(s.region, Boolean(paper.current));
  };

  const finishShow = (s: Show) => {
    if (show.current !== s || !s.end) return;
    show.current = null;
    s.timers.forEach(clearTimeout);
    const end = s.end;
    if (s.shown) setCaption(s.shown);
    remember(end);
    if (s.trigger === "wrap_up") {
      const st = stats.current;
      setSummary({ recap: end.say || s.said, stats: { ...st } });
      logEvent(
        account,
        "session_finished",
        { minutes: Math.round((Date.now() - st.startedAt) / 60000), turns: st.turns, concepts: st.concepts, cards: st.cards.length },
        sessionId.current,
      );
    }
    dirty.current = true;
    save();
    settle();
  };

  // Cuts the turn short: the phrase being drawn finishes, the rest never reaches the page.
  const stopShow = () => {
    const s = show.current;
    if (!s) return;
    show.current = null;
    s.timers.forEach(clearTimeout);
    for (const a of s.acts) a.clip?.stop();
    tutorInk.current = tutorInk.current.filter((t) => t.born !== Infinity);
    if (s.shown) setCaption(s.shown);
    dirty.current = true;
    save();
  };

  // Voice off in the middle of a turn: the rest of it plays on in silence.
  const silenceShow = () => {
    quietAside();
    const s = show.current;
    if (!s) return;
    for (const a of s.acts) {
      if (!a.clip) continue;
      a.clip.stop();
      a.clip = null;
      if (a === s.playing) {
        if (!a.started) {
          a.voiceDone = false;
          playNextSilently(s, a);
        } else {
          a.voiceDone = true;
          after(s, a);
        }
      } else a.voiceDone = false;
    }
    // phrases waiting for the line said while thinking go on without it
    if (!s.playing && !s.breathing) playNext(s);
  };
  // The phrase now playing loses its voice before it was heard: time it by its words instead.
  const playNextSilently = (s: Show, a: Act) => {
    s.next = s.acts.indexOf(a);
    s.playing = null;
    playNext(s);
  };

  // Stop talking now (a new page, a new card) and go back to listening.
  const hush = () => {
    stopShow();
    stopSpeaking();
    quietAside();
    inFlight.current?.abort.abort();
    inFlight.current = null;
    setTutorState("idle");
    stateRef.current.tutorState = "idle";
    ear.current?.resume();
  };

  // Back to listening and watching after a turn.
  const settle = () => {
    // never listen while still saying the line said while thinking; it settles when done
    if (aside.current?.speaking) return;
    setTutorState("idle");
    stateRef.current.tutorState = "idle";
    ear.current?.resume();
    if (changedSinceTutor.current) schedulePause();
  };

  // What a turn teaches us about the student: mastery evidence, a new review
  // card after a fixed mistake, or the result of a review attempt.
  const remember = (turn: TurnEnd) => {
    const at = new Date();
    if (stateRef.current.mode === "study") {
      if (turn.skill?.concept && (turn.skill.evidence === "slip" || turn.skill.evidence === "solved")) {
        const c = (stats.current.concepts[turn.skill.concept.toLowerCase()] ??= { slips: 0, solved: 0 });
        if (turn.skill.evidence === "slip") c.slips = 1;
        else c.solved++;
      }
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
        stats.current.cards.push(card.concept);
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
    setImages([]);
    setPaper(null);
    sims.current = [];
    simRuns.current.clear();
    paths.current.clear();
    tutorPaths.current.clear();
    undoStack.current = [];
    sessionId.current = crypto.randomUUID();
    stats.current = newStats();
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
    stats.current = newStats();
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

  // A simulation goes below everything on the page, at the left of the view.
  const placeSim = (spec: PageSim["spec"], lines: InkLine[]) => {
    const cam = camera.current;
    const boxes: Box[] = [
      ...lines.map((l) => l.box),
      ...tutorInk.current.map((t) => t.plan.box).filter((b): b is Box => b != null),
      ...sims.current,
    ];
    const below = boxes.length ? Math.max(...boxes.map((b) => b.y + b.h)) + 36 : cam.y + 90 / cam.z;
    const sim: PageSim = { id: crypto.randomUUID(), spec, x: cam.x + 40 / cam.z, y: below, w: SIM_W, h: SIM_H, ran: false };
    sims.current.push(sim);
    reveal(sim);
  };

  // A run finished: keep its results on the page and let the tutor see what happened.
  const finishSim = (sim: PageSim) => {
    sim.ran = true;
    dirty.current = true;
    save();
    logEvent(account, "sim_watched", { kind: sim.spec.kind, spec: sim.spec }, sessionId.current);
    askTutor("watched", null, simResult(sim.spec));
  };

  // A tap on a simulation's play button, in page coordinates.
  const simPlayAt = (wx: number, wy: number) =>
    sims.current.find((sim) => {
      const b = playButton(sim);
      return wx >= b.x - 6 && wx <= b.x + b.w + 6 && wy >= b.y - 6 && wy <= b.y + b.h + 6;
    });

  // If the tutor writes somewhere off screen, glide the page so it is visible.
  // With `fit`, it also zooms: out until the whole thing fits, or in when it would look small.
  const reveal = (b: Box, fit = false) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cam = camera.current;
    const top = 80, bottom = 180; // the toolbar and the caption panel
    if (fit) {
      const sw = canvas.clientWidth - 80, sh = canvas.clientHeight - top - bottom;
      const best = Math.max(0.3, Math.min(1.1, sw / Math.max(1, b.w), sh / Math.max(1, b.h)));
      // At a comfortable size already: slide just enough to bring it all in, without zooming.
      if (cam.z <= best && cam.z >= best * 0.6) {
        const left = cam.x + 40 / cam.z, right = cam.x + (canvas.clientWidth - 40) / cam.z;
        const upper = cam.y + top / cam.z, lower = cam.y + (canvas.clientHeight - bottom) / cam.z;
        const dx = b.x < left ? b.x - left : b.x + b.w > right ? b.x + b.w - right : 0;
        const dy = b.y < upper ? b.y - upper : b.y + b.h > lower ? b.y + b.h - lower : 0;
        if (dx || dy) {
          glide.current = { from: cam, to: { ...cam, x: cam.x + dx, y: cam.y + dy }, start: performance.now() };
          dirty.current = true;
        }
        return;
      }
      const z = best;
      const to = { z, x: b.x + b.w / 2 - canvas.clientWidth / 2 / z, y: b.y + b.h / 2 - (top + sh / 2) / z };
      glide.current = { from: cam, to, start: performance.now() };
      dirty.current = true;
      return;
    }
    const w = canvas.clientWidth / cam.z;
    const h = (canvas.clientHeight - 160) / cam.z;
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
    // In the "on request" study arm the tutor only answers when asked or spoken to.
    if (account?.condition === "on_request") return;
    pauseTimer.current = setTimeout(() => {
      if (!changedSinceTutor.current || drawing.current) return;
      if (stateRef.current.tutorState === "speaking" || hearing.current) return schedulePause();
      askTutor("pause");
    }, paper.current ? PAPER_WATCH_MS : WATCH_MS);
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
    // Rubbing out a simulation's dashed frame takes it off the page.
    const onEdge = (b: Box) =>
      wx > b.x - reach && wx < b.x + b.w + reach && wy > b.y - reach && wy < b.y + b.h + reach &&
      (Math.abs(wx - b.x) < reach || Math.abs(wx - b.x - b.w) < reach || Math.abs(wy - b.y) < reach || Math.abs(wy - b.y - b.h) < reach);
    sims.current = sims.current.filter((sim) => !onEdge(sim));
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

    {
      const [wx, wy] = screenToWorld(camera.current, sx, sy);
      const sim = simPlayAt(wx, wy);
      if (sim && !simRuns.current.has(sim.id)) {
        simRuns.current.set(sim.id, performance.now());
        dirty.current = true;
        return;
      }
    }

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
      if (gesture(d.stroke)) {
        dirty.current = true;
        return;
      }
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

  // Pen gestures. A double tap points at that spot: the tutor answers about
  // it, right away or about what the student says next. A quick back-and-forth
  // scribble over ink erases it. Returns true when the stroke was a gesture.
  const gesture = (stroke: Stroke): boolean => {
    const pts = stroke.points;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    const z = camera.current.z;
    const remove = (ids: string[]) => {
      strokes.current = strokes.current.filter((s) => !ids.includes(s.id));
      ids.forEach((id) => paths.current.delete(id));
    };

    if (w * z < 6 && h * z < 6 && Date.now() - stroke.createdAt < 300) {
      const prev = lastTap.current;
      const [x, y] = pts[0];
      if (prev && Date.now() - prev.at < 450 && Math.hypot(prev.x - x, prev.y - y) * z < 24) {
        lastTap.current = null;
        remove([stroke.id, prev.strokeId]);
        undoStack.current.splice(-2);
        save();
        focus.current = { world: [x, y], at: Date.now() };
        setTimeout(() => (dirty.current = true), FOCUS_MS + 50);
        // Give them a moment to start speaking; if they don't, the tap is the question.
        setTimeout(() => {
          if (focus.current && Date.now() - focus.current.at < 2000 && !hearing.current && !inFlight.current) askTutor("asked");
        }, 1400);
        return true;
      }
      lastTap.current = { x, y, at: Date.now(), strokeId: stroke.id };
      return false;
    }

    // Scribble: the pen reverses left-right many times in a short, wide-ish stroke.
    let flips = 0, dir = 0, anchor = pts[0][0];
    for (const [x] of pts) {
      const dx = x - anchor;
      if (Math.abs(dx) * z < 6) continue;
      const nd = Math.sign(dx);
      if (dir && nd !== dir) flips++;
      dir = nd;
      anchor = x;
    }
    if (flips >= 6 && w * z > 24) {
      // Ink counts as scribbled out when most of it lies under the scribble.
      const x0 = Math.min(...xs) - 8, x1 = Math.max(...xs) + 8, y0 = Math.min(...ys) - 8, y1 = Math.max(...ys) + 8;
      const near = (s: Stroke) =>
        s.id !== stroke.id && s.points.filter(([sx, sy]) => sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1).length >= s.points.length * 0.5;
      const hit = strokes.current.filter(near).map((s) => s.id);
      if (hit.length) {
        remove([...hit, stroke.id]);
        changedSinceTutor.current = true;
        save();
        schedulePause();
        return true;
      }
    }
    return false;
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
    if (!strokes.current.length && !tutorInk.current.length && !images.current.length && !sims.current.length) return;
    if (!confirm("Clear the whole page?")) return;
    hush();
    undoStack.current.push([...strokes.current]);
    strokes.current = [];
    tutorInk.current = [];
    setImages([]);
    paths.current.clear();
    tutorPaths.current.clear();
    sessionId.current = crypto.randomUUID();
    sims.current = [];
    simRuns.current.clear();
    stats.current = newStats();
    dirty.current = true;
    save();
  };

  // A picture of the whole page, both inks, to keep or hand in.
  const saveNotes = () => {
    const tutorStrokes = tutorInk.current.flatMap((t) => t.plan.strokes.map((st) => st.points));
    const all = [
      ...strokes.current.flatMap((s) => s.points.map((p) => [p[0], p[1]])),
      ...tutorStrokes.flat(),
      ...images.current.flatMap((i) => [
        [i.x, i.y],
        [i.x + i.w, i.y + i.h],
      ]),
    ];
    if (!all.length) return;
    const m = 40;
    const x0 = Math.min(...all.map((p) => p[0])) - m, y0 = Math.min(...all.map((p) => p[1])) - m;
    const x1 = Math.max(...all.map((p) => p[0])) + m, y1 = Math.max(...all.map((p) => p[1])) + m;
    const scale = Math.min(2, 2400 / (x1 - x0), 3200 / (y1 - y0));
    const c = document.createElement("canvas");
    c.width = Math.ceil((x1 - x0) * scale);
    c.height = Math.ceil((y1 - y0) * scale);
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.setTransform(scale, 0, 0, scale, -x0 * scale, -y0 * scale);
    for (const { img, el } of loadedPictures()) ctx.drawImage(el, img.x, img.y, img.w, img.h);
    ctx.fillStyle = STUDENT_INK;
    for (const s of strokes.current) ctx.fill(outlinePath(getStroke(s.points, { size: s.size, thinning: 0.6, smoothing: 0.55, streamline: 0.45 })));
    ctx.fillStyle = TUTOR_INK;
    for (const pts of tutorStrokes) ctx.fill(outlinePath(getStroke(pts, { size: 3.6, thinning: 0.55, smoothing: 0.6, streamline: 0.2, simulatePressure: true })));
    const a = document.createElement("a");
    a.href = c.toDataURL("image/png");
    a.download = `study-notes-${new Date().toISOString().slice(0, 10)}.png`;
    a.click();
  };

  const newProblem = () => {
    hush();
    strokes.current = [];
    tutorInk.current = [];
    setImages([]);
    setPaper(null);
    sims.current = [];
    simRuns.current.clear();
    paths.current.clear();
    tutorPaths.current.clear();
    undoStack.current = [];
    sessionId.current = crypto.randomUUID();
    stats.current = newStats();
    setProblem("");
    setSummary(null);
    setCaption("Fresh page. What are we working on next?");
    dirty.current = true;
    save();
  };

  // A photo, screenshot or PDF of a worksheet goes under the ink, starting
  // where the student is looking, pages stacked downward.
  const addPhoto = async (file: File) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setImporting(true);
    setError(null);
    try {
      const pictures = await picturesFrom(file);
      const cam = camera.current;
      const viewW = canvas.clientWidth / cam.z;
      const width = Math.min(900, Math.max(320, viewW * 0.6));
      const x = cam.x + 30 / cam.z;
      let y = cam.y + 90 / cam.z;
      const added: PageImage[] = [];
      for (const p of pictures) {
        const h = (width * p.h) / p.w;
        added.push({ id: crypto.randomUUID(), src: p.src, x, y, w: width, h });
        y += h + 24;
      }
      setImages([...images.current, ...added]);
      save();
      logEvent(account, "photo_added", { pages: added.length, pdf: file.type === "application/pdf" }, sessionId.current);
      setCaption(
        added.length > 1
          ? `Got all ${added.length} pages. Write right on them, and tell me which problem you're on.`
          : "Got it. Write right on it, and tell me which problem you're on.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "That file couldn't be opened.");
    } finally {
      setImporting(false);
    }
  };

  const removePhotos = () => {
    if (!images.current.length || !confirm("Take the photo off the page? Your writing stays.")) return;
    setImages([]);
    save();
  };

  // Study a paper: its pages go down the left, the workspace is to the right,
  // and the tutor opens with the big picture.
  const studyPaper = async (file: File) => {
    const busyPage = strokes.current.length || tutorInk.current.length || images.current.length || paper.current;
    if (busyPage && !confirm("Start a fresh page for this paper? Your current page will be cleared.")) return;
    setError(null);
    setOpening("Reading the paper…");
    try {
      const data = await openPaper(file, (done, total) => setOpening(`Reading page ${Math.min(done + 1, total)} of ${total}…`));
      if (!data.pages.some((p) => p.sentences.length))
        throw new Error("That PDF has no text layer (it may be a scan), so I can't read it. Try the publisher's or arXiv's PDF.");
      await savePaper(data).catch(() => flash("This paper is too big to keep on this device; it'll need reopening next time."));
      if (paper.current) deletePaper(paper.current.ref.id);
      hush();
      strokes.current = [];
      tutorInk.current = [];
      paths.current.clear();
      tutorPaths.current.clear();
      undoStack.current = [];
      sims.current = [];
      simRuns.current.clear();
      setImages([]);
      sessionId.current = crypto.randomUUID();
      stats.current = newStats();
      setPaper(layoutPaper(data, { id: data.id, title: data.title, x: 0, y: 0, w: PAPER_W }));
      setProblem(data.title);
      stateRef.current.problem = data.title;
      const c = canvasRef.current;
      const z = c ? Math.min(1, Math.max(0.45, c.clientWidth / (PAPER_W + 70 + 620 + 60))) : 1;
      camera.current = { x: -30 / z, y: -70 / z, z };
      dirty.current = true;
      save();
      logEvent(account, "paper_opened", { pages: data.pages.length, page_count: data.pageCount, sentences: data.pages.reduce((n, p) => n + p.sentences.length, 0) }, sessionId.current);
      setCaption(`Got "${data.title}". Give me a second to read it…`);
      // The tutor's first look should see the pages, not blank paper.
      await Promise.all(
        (paper.current?.pages ?? []).slice(0, 2).map((img) => {
          pictureFor(img);
          return imageEls.current.get(img.id)?.decode().catch(() => undefined);
        }),
      );
      askTutor("paper_opened");
    } catch (e) {
      setError(e instanceof Error ? e.message : "That paper couldn't be opened.");
    } finally {
      setOpening(null);
    }
  };

  const closePaper = () => {
    if (!paper.current || !confirm("Close the paper? Your notes and the tutor's drawings stay on the page.")) return;
    deletePaper(paper.current.ref.id);
    setPaper(null);
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
    inFlight.current?.abort.abort();
    inFlight.current = null;
    stopShow();
    stopSpeaking();
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
          {mode === "study" && (
            <>
              <button onClick={() => photoInput.current?.click()} disabled={importing} title="Put a photo, screenshot or PDF of a worksheet under your writing">
                {importing ? "Opening…" : "Add photo"}
              </button>
              {hasPhoto && <button onClick={removePhotos}>Remove photo</button>}
              {paperTitle ? (
                <button onClick={closePaper} title={paperTitle}>
                  Close paper
                </button>
              ) : (
                <button onClick={() => paperInput.current?.click()} disabled={!!opening} title="Open a research paper (PDF) to read and discuss together">
                  {opening ?? "Study a paper"}
                </button>
              )}
              <input
                ref={paperInput}
                type="file"
                accept="application/pdf"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) studyPaper(f);
                }}
              />
              <input
                ref={photoInput}
                type="file"
                accept="image/*,application/pdf"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) addPhoto(f);
                }}
              />
            </>
          )}
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

      {summary && (
        <div className="summary" role="dialog" aria-label="Session summary">
          <h2>Nice session</h2>
          <p className="summary-recap">{summary.recap}</p>
          <dl>
            <div>
              <dt>Time</dt>
              <dd>{Math.max(1, Math.round((Date.now() - summary.stats.startedAt) / 60000))} min</dd>
            </div>
            <div>
              <dt>Back-and-forths</dt>
              <dd>{summary.stats.turns}</dd>
            </div>
            <div>
              <dt>Review cards saved</dt>
              <dd>{summary.stats.cards.length}</dd>
            </div>
          </dl>
          {Object.keys(summary.stats.concepts).length > 0 && (
            <ul className="summary-concepts">
              {Object.entries(summary.stats.concepts).map(([c, v]) => (
                <li key={c}>
                  <span>{c}</span>
                  <span className={v.solved && !v.slips ? "good" : v.solved ? "mixed" : "work"}>
                    {v.solved && !v.slips ? "solid" : v.solved ? "got there" : "keep practising"}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {account && <SessionSurvey key={summary.stats.startedAt} account={account} sessionId={sessionId.current} />}
          <div className="keep-actions">
            <button onClick={saveNotes}>Save notes</button>
            <button onClick={() => setSummary(null)}>Keep going</button>
            <button className="primary" onClick={newProblem}>
              New problem
            </button>
          </div>
        </div>
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
          {mode === "study" && (
            <button onClick={() => askTutor("wrap_up")} disabled={tutorState === "thinking"} title="Wrap up with a recap">
              Finish
            </button>
          )}
          <button
            onClick={() => {
              if (!stateRef.current.muted) {
                stateRef.current.muted = true;
                silenceShow();
              }
              setMuted((m) => !m);
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
// A photo or PDF page under the ink, with a faint edge so it reads as paper.
function drawPicture(ctx: CanvasRenderingContext2D, img: PageImage, el: HTMLImageElement | null, z: number) {
  ctx.save();
  ctx.shadowColor = "rgba(15, 23, 42, 0.12)";
  ctx.shadowBlur = 8; // shadows ignore the transform
  ctx.fillStyle = "#fff";
  ctx.fillRect(img.x, img.y, img.w, img.h);
  ctx.restore();
  if (el) ctx.drawImage(el, img.x, img.y, img.w, img.h);
  ctx.strokeStyle = "rgba(15, 23, 42, 0.15)";
  ctx.lineWidth = 1 / z;
  ctx.strokeRect(img.x, img.y, img.w, img.h);
}

function drawTutorInk(ctx: CanvasRenderingContext2D, ink: TutorInk, now: number, cache: Map<string, Path2D>) {
  const t = ink.born === 0 ? Infinity : now - ink.born;
  if ((ink.marks?.length || ink.rules?.length) && t > 0) {
    // a highlighter pass over the passage, sweeping in as the voice starts
    ctx.save();
    const sweep = Math.min(1, t / 500);
    ctx.fillStyle = "rgba(250, 204, 21, 0.38)";
    for (const b of ink.marks ?? []) ctx.fillRect(b.x, b.y, b.w * sweep, b.h);
    ctx.fillStyle = TUTOR_INK;
    for (const b of ink.rules ?? []) ctx.fillRect(b.x, b.y, b.w * sweep, b.h);
    ctx.restore();
  }
  ctx.save();
  ctx.fillStyle = TUTOR_INK;
  ink.plan.strokes.forEach((s, i) => {
    const key = `${ink.id}:${i}`;
    let path = cache.get(key);
    if (!path) {
      const pts = strokeAt(s, t);
      if (!pts) return;
      const done = t >= s.end;
      // Short marks (a full stop, a dot) would taper away to nothing.
      let len = 0;
      for (let k = 1; k < s.points.length; k++) len += Math.hypot(s.points[k][0] - s.points[k - 1][0], s.points[k][1] - s.points[k - 1][1]);
      path = outlinePath(
        getStroke(pts, {
          size: s.w ?? 3.6,
          thinning: 0.55,
          smoothing: 0.6,
          streamline: 0.2,
          simulatePressure: true,
          start: { taper: Math.min(10, len * 0.25) },
          end: { taper: done ? Math.min(8, len * 0.2) : 0 },
          last: done,
        }),
      );
      if (done) cache.set(key, path);
      else {
        // the pen nib, while it is moving
        const [x, y] = pts[pts.length - 1];
        ctx.beginPath();
        ctx.arc(x, y, (s.w ?? 3.6) * 0.6, 0, Math.PI * 2);
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
type LoadedPicture = { img: PageImage; el: HTMLImageElement };

function renderPageImages(strokes: Stroke[], lines: InkLine[], pictures: LoadedPicture[] = []): { pageImage: string; tokenImage: string } {
  if (!lines.length && !pictures.length) {
    const blank = document.createElement("canvas");
    blank.width = blank.height = 64;
    const ctx = blank.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, 64, 64);
    const url = blank.toDataURL("image/png");
    return { pageImage: url, tokenImage: url };
  }
  const boxes = [...lines.map((l) => l.box), ...pictures.map(({ img }) => ({ x: img.x, y: img.y, w: img.w, h: img.h }))];
  let box = boxes[0];
  for (const b of boxes) {
    const x = Math.min(box.x, b.x), y = Math.min(box.y, b.y);
    box = { x, y, w: Math.max(box.x + box.w, b.x + b.w) - x, h: Math.max(box.y + box.h, b.y + b.h) - y };
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
    for (const { img, el } of pictures) ctx.drawImage(el, img.x, img.y, img.w, img.h);
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
    // A photo makes a PNG huge; JPEG keeps the request small.
    return pictures.length ? canvas.toDataURL("image/jpeg", 0.85) : canvas.toDataURL("image/png");
  };
  return { pageImage: draw(false), tokenImage: draw(true) };
}

// Paper mode: a picture of what is on screen (paper, photos, both inks and
// highlights), since the tutor and student are talking about what they see.
function renderViewImage(
  view: Box,
  pictures: PageImage[],
  pictureFor: (img: PageImage) => HTMLImageElement | null,
  strokes: Stroke[],
  inks: TutorInk[],
): string {
  const scale = Math.min(2, 1400 / view.w);
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(view.w * scale);
  canvas.height = Math.ceil(view.h * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, -view.x * scale, -view.y * scale);
  for (const img of pictures) {
    const el = pictureFor(img);
    if (el) ctx.drawImage(el, img.x, img.y, img.w, img.h);
  }
  ctx.fillStyle = "rgba(250, 204, 21, 0.38)";
  for (const t of inks) for (const b of t.marks ?? []) if (t.born !== Infinity) ctx.fillRect(b.x, b.y, b.w, b.h);
  ctx.fillStyle = TUTOR_INK;
  for (const t of inks) for (const b of t.rules ?? []) if (t.born !== Infinity) ctx.fillRect(b.x, b.y, b.w, b.h);
  ctx.fillStyle = STUDENT_INK;
  for (const s of strokes) {
    const outline = getStroke(s.points, { size: s.size, thinning: 0.6, smoothing: 0.55, streamline: 0.45 });
    if (outline.length) ctx.fill(outlinePath(outline));
  }
  ctx.fillStyle = TUTOR_INK;
  for (const t of inks) {
    if (t.born === Infinity) continue;
    for (const st of t.plan.strokes) {
      const outline = getStroke(st.points, { size: st.w ?? 3.6, thinning: 0.55, smoothing: 0.6, streamline: 0.2, simulatePressure: true });
      if (outline.length) ctx.fill(outlinePath(outline));
    }
  }
  return canvas.toDataURL("image/jpeg", 0.82);
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

// The tutor's reply, one JSON value per line, as each line arrives.
async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const parse = (line: string) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      const v = line ? parse(line) : null;
      if (v) yield v;
    }
  }
  const last = buf.trim() ? parse(buf.trim()) : null;
  if (last) yield last;
}
