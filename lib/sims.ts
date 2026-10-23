import { z } from "zod";

// Physics simulations the tutor can set up on the page for predict, then
// watch: the student marks what they think will happen, taps play, and sees
// it happen at real speed next to their prediction. The tutor only chooses
// numbers; the motion comes from the physics here, never from the model.

const label = z.string().nullable();

const Projectile = z.object({
  kind: z.literal("projectile"),
  height_m: z.number().describe("Launch height above the ground, 0 for level ground."),
  launches: z
    .array(z.object({ speed_ms: z.number().describe("Launch speed in m/s."), angle_deg: z.number().describe("Above horizontal, 0 to 90."), label }))
    .describe("One launch, or two to compare (such as 30° and 60° at the same speed)."),
  g: z.number().nullable().describe("Gravity in m/s², null for Earth's 9.8."),
});

const Pendulum = z.object({
  kind: z.literal("pendulum"),
  lengths_m: z.array(z.number()).describe("One string length in metres, or two to compare side by side."),
  amplitude_deg: z.number().describe("How far it is pulled back, 1 to 80 degrees."),
  g: z.number().nullable().describe("Gravity in m/s², null for Earth's 9.8."),
});

export const SimSchema = z.discriminatedUnion("kind", [Projectile, Pendulum]);
export type SimSpec = z.infer<typeof SimSchema>;

// A simulation on the page. `ran` is set once it has played, so its results stay shown.
export type PageSim = { id: string; spec: SimSpec; x: number; y: number; w: number; h: number; ran: boolean };

export const SIM_W = 500;
export const SIM_H = 330;

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

// Keep the model's numbers physical and drawable.
export function sanitizeSim(spec: SimSpec): SimSpec {
  const g = spec.g == null ? null : clamp(spec.g, 0.5, 30);
  if (spec.kind === "projectile") {
    const launches = spec.launches.slice(0, 2).map((l) => ({
      speed_ms: clamp(l.speed_ms, 0.5, 200),
      angle_deg: clamp(l.angle_deg, 0, 90),
      label: l.label?.slice(0, 16) ?? null,
    }));
    return { kind: "projectile", height_m: clamp(spec.height_m, 0, 500), launches: launches.length ? launches : [{ speed_ms: 15, angle_deg: 45, label: null }], g };
  }
  const lengths = spec.lengths_m.slice(0, 2).map((l) => clamp(l, 0.05, 50));
  return { kind: "pendulum", lengths_m: lengths.length ? lengths : [1], amplitude_deg: clamp(spec.amplitude_deg, 1, 80), g };
}

const gravity = (spec: SimSpec) => spec.g ?? 9.8;

// ---------- projectile ----------

export function flight(speed: number, angleDeg: number, height: number, g: number) {
  const a = (angleDeg * Math.PI) / 180;
  const vx = speed * Math.cos(a), vy = speed * Math.sin(a);
  const time = (vy + Math.sqrt(vy * vy + 2 * g * height)) / g;
  const peak = height + (vy * vy) / (2 * g);
  return {
    time,
    range: vx * time,
    peak,
    at: (t: number) => ({ x: vx * Math.min(t, time), y: Math.max(0, height + vy * Math.min(t, time) - (g * Math.min(t, time) ** 2) / 2) }),
  };
}

// ---------- pendulum ----------

// The swing angle over time, integrated properly so large swings run slow as
// they really do. Returns samples every `dt` seconds for `seconds`.
export function swing(length: number, amplitudeDeg: number, g: number, seconds: number, dt = 1 / 240): Float64Array {
  const n = Math.ceil(seconds / dt) + 1;
  const out = new Float64Array(n);
  let th = (amplitudeDeg * Math.PI) / 180, w = 0;
  const acc = (t: number) => -(g / length) * Math.sin(t);
  for (let i = 0; i < n; i++) {
    out[i] = th;
    // velocity Verlet
    const a0 = acc(th);
    th += w * dt + 0.5 * a0 * dt * dt;
    w += 0.5 * (a0 + acc(th)) * dt;
  }
  return out;
}

// The period measured from the motion: time between successive returns to the start side.
export function measuredPeriod(samples: Float64Array, dt = 1 / 240): number | null {
  const crossings: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1] < 0 && samples[i] >= 0) crossings.push((i - 1 + -samples[i - 1] / (samples[i] - samples[i - 1])) * dt);
  }
  return crossings.length >= 2 ? (crossings.at(-1)! - crossings[0]) / (crossings.length - 1) : null;
}

// How long a run plays, in seconds.
export function runSeconds(spec: SimSpec): number {
  if (spec.kind === "projectile") {
    const g = gravity(spec);
    return Math.min(12, Math.max(...spec.launches.map((l) => flight(l.speed_ms, l.angle_deg, spec.height_m, g).time)));
  }
  const g = gravity(spec);
  const longest = Math.max(...spec.lengths_m);
  return Math.min(15, Math.max(6, 3 * 2 * Math.PI * Math.sqrt(longest / g)));
}

// What happened, in words: for the tutor after the student watches, and for the page.
export function simResult(spec: SimSpec): string {
  const g = gravity(spec);
  const f = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
  const given = (v: number) => String(+v.toFixed(2));
  if (spec.kind === "projectile") {
    return spec.launches
      .map((l, i) => {
        const r = flight(l.speed_ms, l.angle_deg, spec.height_m, g);
        return `${l.label ?? (spec.launches.length > 1 ? `launch ${i + 1}` : "the ball")} (${given(l.speed_ms)} m/s at ${given(l.angle_deg)}°) landed ${f(r.range)} m away after ${f(r.time)} s, peaking at ${f(r.peak)} m`;
      })
      .join("; ");
  }
  return spec.lengths_m
    .map((L) => {
      const p = measuredPeriod(swing(L, spec.amplitude_deg, g, 4 * 2 * Math.PI * Math.sqrt(L / g) + 1));
      return `the ${given(L)} m pendulum swung with a period of ${p ? f(p) : "?"} s`;
    })
    .join("; ");
}

export function describeSim(spec: SimSpec): string {
  if (spec.kind === "projectile")
    return `projectile simulation from ${spec.height_m} m: ${spec.launches.map((l) => `${l.speed_ms} m/s at ${l.angle_deg}°`).join(" vs ")}`;
  return `pendulum simulation: ${spec.lengths_m.map((l) => `${l} m`).join(" vs ")} at ${spec.amplitude_deg}°`;
}

// ---------- drawing ----------

const niceStep = (span: number) => {
  const raw = span / 5;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
};

const COLORS = ["#c2410c", "#2563eb"];
export const PLAY = { size: 40, pad: 10 };

// The play button's box, in page coordinates.
export function playButton(sim: PageSim) {
  return { x: sim.x + sim.w - PLAY.size - PLAY.pad, y: sim.y + PLAY.pad, w: PLAY.size, h: PLAY.size };
}

// Draws a simulation at `t` seconds into its run (null: not running).
export function drawSim(ctx: CanvasRenderingContext2D, sim: PageSim, t: number | null, font: string, z: number) {
  const { spec } = sim;
  const g = gravity(spec);
  const done = t == null ? sim.ran : t >= runSeconds(spec);
  const time = t == null ? (sim.ran ? runSeconds(spec) : 0) : Math.min(t, runSeconds(spec));
  ctx.save();
  ctx.lineCap = ctx.lineJoin = "round";
  ctx.fillStyle = "rgba(255, 255, 255, 0.9)"; // readable over a photo
  ctx.fillRect(sim.x, sim.y, sim.w, sim.h);
  ctx.strokeStyle = "rgba(194, 65, 12, 0.35)";
  ctx.lineWidth = 1.2 / z;
  ctx.setLineDash([6, 5]);
  ctx.strokeRect(sim.x, sim.y, sim.w, sim.h);
  ctx.setLineDash([]);
  const text = (s: string, x: number, y: number, size = 21, color = "#c2410c", align: CanvasTextAlign = "left") => {
    ctx.font = `${size}px ${font}`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.fillText(s, x, y);
  };

  // play / replay button
  const b = playButton(sim);
  ctx.strokeStyle = "#c2410c";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "#c2410c";
  ctx.beginPath();
  if (t != null && !done) {
    ctx.fillRect(b.x + b.w * 0.34, b.y + b.h * 0.3, b.w * 0.1, b.h * 0.4);
    ctx.fillRect(b.x + b.w * 0.56, b.y + b.h * 0.3, b.w * 0.1, b.h * 0.4);
  } else {
    ctx.moveTo(b.x + b.w * 0.4, b.y + b.h * 0.28);
    ctx.lineTo(b.x + b.w * 0.74, b.y + b.h * 0.5);
    ctx.lineTo(b.x + b.w * 0.4, b.y + b.h * 0.72);
    ctx.fill();
  }
  const playing = t != null && !done;
  if (!playing) text(sim.ran || done ? "again" : "predict, then play", b.x - 8, b.y + b.h / 2 + 6, 21, "#c2410c", "right");

  const left = sim.x + 40, right = sim.x + sim.w - 26, top = sim.y + 78, bottom = sim.y + sim.h - 46;
  if (spec.kind === "projectile") {
    const runs = spec.launches.map((l) => ({ l, f: flight(l.speed_ms, l.angle_deg, spec.height_m, g) }));
    const maxX = Math.max(...runs.map((r) => r.f.range), 1) * 1.1;
    const maxY = Math.max(...runs.map((r) => r.f.peak), spec.height_m, 1) * 1.15;
    const k = Math.min((right - left) / maxX, (bottom - top) / maxY);
    const X = (x: number) => left + x * k, Y = (y: number) => bottom - y * k;
    // ground with distance ticks, so the student can mark a guess
    ctx.strokeStyle = "#1f2a44";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(left - 10, bottom);
    ctx.lineTo(right, bottom);
    ctx.stroke();
    const step = niceStep(maxX);
    for (let d = 0; d <= maxX + 1e-9; d += step) {
      ctx.beginPath();
      ctx.moveTo(X(d), bottom);
      ctx.lineTo(X(d), bottom + 6);
      ctx.stroke();
      text(`${+d.toFixed(2)}`, X(d), bottom + 22, 19, "#6b7280", "center");
    }
    text("m", right, bottom + 22, 19, "#6b7280", "right");
    if (spec.height_m > 0) {
      ctx.fillStyle = "rgba(31, 42, 68, 0.12)";
      ctx.fillRect(left - 14, Y(spec.height_m), 14, bottom - Y(spec.height_m));
      text(`${spec.height_m} m`, left - 18, Y(spec.height_m / 2), 19, "#6b7280", "right");
    }
    runs.forEach(({ l, f }, i) => {
      const color = COLORS[i % 2];
      const a = (l.angle_deg * Math.PI) / 180;
      // launch arrow and its label
      const x0 = X(0), y0 = Y(spec.height_m), len = 46;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0 + len * Math.cos(a), y0 - len * Math.sin(a));
      ctx.stroke();
      text(`${l.label ? `${l.label}: ` : ""}${l.speed_ms} m/s, ${l.angle_deg}°`, sim.x + 14, sim.y + 30 + i * 26, 22, color);
      // the flight so far, as a dotted trail, and the ball
      const shown = Math.min(time, f.time);
      if (t != null || sim.ran) {
        ctx.fillStyle = color;
        for (let s = 0; s <= shown; s += 0.05) {
          const p = f.at(s);
          ctx.beginPath();
          ctx.arc(X(p.x), Y(p.y), 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
        const p = f.at(shown);
        ctx.beginPath();
        ctx.arc(X(p.x), Y(p.y), 6, 0, Math.PI * 2);
        ctx.fill();
        if (shown >= f.time) {
          ctx.beginPath();
          ctx.moveTo(X(f.range), bottom - 12);
          ctx.lineTo(X(f.range), bottom + 4);
          ctx.stroke();
          text(`${f.range.toFixed(1)} m`, X(f.range), bottom - 16 - i * 24, 21, color, "center");
        }
      } else {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x0, y0, 6, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    if (t != null || sim.ran) text(`t = ${time.toFixed(1)} s`, b.x + b.w, b.y + b.h + 24, 20, "#6b7280", "right");
  } else {
    const n = spec.lengths_m.length;
    const longest = Math.max(...spec.lengths_m);
    const k = (bottom - top + 16) / longest;
    text(`pulled back ${spec.amplitude_deg}°`, sim.x + 14, sim.y + 30, 22);
    spec.lengths_m.forEach((L, i) => {
      const color = COLORS[i % 2];
      const px = n === 1 ? (left + right) / 2 : left + ((right - left) * (i + 0.5)) / n, py = top - 8;
      const samples = t != null ? swing(L, spec.amplitude_deg, g, time + 0.05) : null;
      const th = samples ? samples[samples.length - 1] : (spec.amplitude_deg * Math.PI) / 180;
      const r = L * k;
      ctx.strokeStyle = "#1f2a44";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px - 24, py);
      ctx.lineTo(px + 24, py);
      ctx.stroke();
      // faint rest line
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = "rgba(31, 42, 68, 0.3)";
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px, py + r);
      ctx.stroke();
      ctx.setLineDash([]);
      const bx = px + r * Math.sin(th), by = py + r * Math.cos(th);
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(bx, by, 9, 0, Math.PI * 2);
      ctx.fill();
      text(`${L} m`, px + 8, py + Math.min(r, 60) / 2, 20, color);
      if (t != null && samples) {
        // count full swings so far
        let swings = 0;
        for (let j = 1; j < samples.length; j++) if (samples[j - 1] < 0 && samples[j] >= 0) swings++;
        text(`${swings} swing${swings === 1 ? "" : "s"}`, px, sim.y + sim.h - 12, 20, color, "center");
      } else if (sim.ran) {
        const p = measuredPeriod(swing(L, spec.amplitude_deg, g, 4 * 2 * Math.PI * Math.sqrt(L / g) + 1));
        text(`one swing: ${p ? p.toFixed(2) : "?"} s`, px, sim.y + sim.h - 12, 20, color, "center");
      }
    });
    if (t != null) text(`t = ${time.toFixed(1)} s`, b.x + b.w, b.y + b.h + 24, 20, "#6b7280", "right");
  }
  ctx.restore();
}
