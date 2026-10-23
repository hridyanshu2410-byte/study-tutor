// The pre and post quizzes: two parallel forms of the same skills, so a
// gain isn't just remembering the questions. Replace these with your own
// validated items before a real study. Answer keys stay on the server.

import type { TestPhase } from "./study.ts";

export type TestItem = { id: string; skill: string; prompt: string; choices: string[]; answer: number };

const PRE: TestItem[] = [
  { id: "a1", skill: "power rule", prompt: "d/dx of x⁴ − 3x² is", choices: ["4x³ − 6x", "4x³ − 3x", "x³ − 6x", "4x⁴ − 6x²"], answer: 0 },
  { id: "a2", skill: "chain rule", prompt: "d/dx of sin(3x) is", choices: ["cos(3x)", "3cos(3x)", "−3cos(3x)", "3sin(3x)"], answer: 1 },
  { id: "a3", skill: "product rule", prompt: "d/dx of x·eˣ is", choices: ["eˣ", "x·eˣ", "eˣ + x·eˣ", "2x·eˣ"], answer: 2 },
  { id: "a4", skill: "quotient rule", prompt: "d/dx of 1/x² is", choices: ["−2/x³", "2/x³", "−1/x", "1/(2x)"], answer: 0 },
  { id: "a5", skill: "slope at a point", prompt: "The slope of y = x² + 1 at x = 2 is", choices: ["2", "4", "5", "3"], answer: 1 },
  { id: "a6", skill: "increasing intervals", prompt: "f(x) = x² − 4x is increasing when", choices: ["x < 2", "x > 2", "x > 4", "x < 0"], answer: 1 },
  { id: "a7", skill: "limits", prompt: "The limit as x → 3 of (x² − 9)/(x − 3) is", choices: ["0", "3", "6", "it doesn't exist"], answer: 2 },
  { id: "a8", skill: "basic integrals", prompt: "∫ 2x dx is", choices: ["2", "x² + C", "2x² + C", "x + C"], answer: 1 },
];

const POST: TestItem[] = [
  { id: "b1", skill: "power rule", prompt: "d/dx of x⁵ + 2x³ is", choices: ["5x⁴ + 6x²", "5x⁴ + 2x²", "x⁴ + 6x²", "5x⁵ + 6x³"], answer: 0 },
  { id: "b2", skill: "chain rule", prompt: "d/dx of cos(2x) is", choices: ["−sin(2x)", "2sin(2x)", "−2sin(2x)", "sin(2x)"], answer: 2 },
  { id: "b3", skill: "product rule", prompt: "d/dx of x·sin(x) is", choices: ["cos(x)", "sin(x) + x·cos(x)", "x·cos(x)", "sin(x) − x·cos(x)"], answer: 1 },
  { id: "b4", skill: "quotient rule", prompt: "d/dx of 1/x³ is", choices: ["3/x⁴", "−1/x²", "−3/x⁴", "1/(3x²)"], answer: 2 },
  { id: "b5", skill: "slope at a point", prompt: "The slope of y = x³ at x = 1 is", choices: ["1", "3", "0", "6"], answer: 1 },
  { id: "b6", skill: "increasing intervals", prompt: "f(x) = x² − 6x is decreasing when", choices: ["x < 3", "x > 3", "x < 6", "x > 0"], answer: 0 },
  { id: "b7", skill: "limits", prompt: "The limit as x → 2 of (x² − 4)/(x − 2) is", choices: ["0", "2", "it doesn't exist", "4"], answer: 3 },
  { id: "b8", skill: "basic integrals", prompt: "∫ 3x² dx is", choices: ["x³ + C", "6x + C", "3x³ + C", "x² + C"], answer: 0 },
];

export const TESTS: Record<TestPhase, TestItem[]> = { pre: PRE, post: POST };

// What the browser sees: no answer keys.
export const publicItems = (phase: TestPhase) => TESTS[phase].map(({ id, prompt, choices }) => ({ id, prompt, choices }));

export function scoreTest(phase: TestPhase, answers: Record<string, number | null>) {
  const items = TESTS[phase];
  const per = items.map((it) => ({ id: it.id, skill: it.skill, chose: answers[it.id] ?? null, correct: answers[it.id] === it.answer }));
  return { score: per.filter((p) => p.correct).length, of: items.length, items: per };
}
