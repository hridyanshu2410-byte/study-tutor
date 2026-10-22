// Research-study settings and helpers that don't depend on Supabase, so they
// can be tested directly.

export const CONSENT_VERSION = "2026-10-22";

// Placeholder wording for a minimal-risk usability study. Replace it with the
// text your ethics board (IRB) approves before recruiting, and bump the version
// so everyone sees the new text.
export const CONSENT_SECTIONS: { heading: string; body: string }[] = [
  {
    heading: "What this is",
    body: "You're invited to try an AI tutor that watches you work problems by hand and helps you without handing over answers. We're studying whether it helps people learn and how they use it.",
  },
  {
    heading: "What you'll do",
    body: "Use the tutor for your own studying for as long as you like. We may invite you to a short survey or interview; those are optional.",
  },
  {
    heading: "What we collect",
    body: "Your email (to sign you in), your answers to a few questions about your studies, your handwriting on the page, the tutor's replies, your review cards and how you grade them, and any feedback you send. Your handwriting is sent to Anthropic's Claude to produce the tutor's replies.",
  },
  {
    heading: "How it's used",
    body: "Study data is analysed under a participant code, never your email. Results may be published only in a form that can't identify you.",
  },
  {
    heading: "Your choices",
    body: "Taking part is voluntary. You can stop at any time, and you can delete your account and all your data from the account menu.",
  },
];

export const INTAKE_LEVELS = ["High school", "Undergraduate", "Graduate", "Not a student", "Other"] as const;
export const INTAKE_AI_USE = ["Never", "A few times a month", "Weekly", "Most days"] as const;

export type Intake = {
  level: (typeof INTAKE_LEVELS)[number];
  course: string;
  aiUse: (typeof INTAKE_AI_USE)[number];
};

export function parseIntake(form: { get(name: string): unknown }): Intake | null {
  const level = String(form.get("level") ?? "");
  const aiUse = String(form.get("aiUse") ?? "");
  const course = String(form.get("course") ?? "").trim().slice(0, 120);
  if (!(INTAKE_LEVELS as readonly string[]).includes(level) || !(INTAKE_AI_USE as readonly string[]).includes(aiUse)) return null;
  return { level: level as Intake["level"], aiUse: aiUse as Intake["aiUse"], course };
}

// How many tutor turns one tester may use per UTC day. Most turns are cheap
// "wait" moves, but every one sends two page images to the model.
export function dailyTutorLimit(): number {
  const n = Number(process.env.DAILY_TUTOR_LIMIT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 300;
}

export function startOfUtcDay(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

export function inviteOk(code: string | null | undefined): boolean {
  const expected = process.env.STUDY_INVITE_CODE?.trim();
  return !expected || (code ?? "").trim().toLowerCase() === expected.toLowerCase();
}

// RFC 4180 CSV: quote every field that needs it; objects become JSON.
export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const cell = (v: unknown) => {
    const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}
