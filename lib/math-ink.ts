// Lays out math the way a person writes it on a board: fractions stacked
// over a bar, powers raised and smaller, roots with a long arm over what
// they are the root of, integrals and sums with their limits, brackets that
// grow to hold what is inside, matrices, vectors with arrows over them.
//
// The tutor writes math as a small, forgiving subset of LaTeX
// ("\frac{dy}{dx} = 3x^2", "\int_0^1 x^2\,dx", "\begin{pmatrix} 1 & 2 \\ 3 & 4 \end{pmatrix}").
// This file only decides where things go: a list of runs of text (written
// with the tutor's own hand) and pen paths (bars, roots, big brackets,
// arrows), in reading order, so the pen writes it in the order a person would.
// Nothing here touches the font or the canvas, so it can be tested alone.

export type MathItem =
  | { t: "text"; s: string; x: number; y: number; size: number }
  | { t: "path"; pts: [number, number][] };
// A laid-out piece: its width, how far it reaches above and below the
// baseline (both positive), and what to draw, relative to its left end on the baseline (y down).
export type MathBox = { w: number; asc: number; desc: number; items: MathItem[] };
// How the hand's letters measure: width, and reach above and below the baseline.
export type GlyphMetrics = (s: string, size: number) => { w: number; asc: number; desc: number };

// ---------- what counts as math ----------
// TeX commands, powers and subscripts, or $...$ around the math part.
export function isMath(text: string): boolean {
  return /\\[a-zA-Z]{2,}|\\[,;:! {}]|[\^]|_[^_]|\$/.test(text) && !/^https?:/.test(text);
}

// ---------- reading the source ----------
type Node =
  | { k: "sym"; s: string; cls: "ord" | "bin" | "rel" | "open" | "close" | "punct" | "op" }
  | { k: "text"; s: string }
  | { k: "row"; items: Node[] }
  | { k: "scripts"; base: Node; sup: Node | null; sub: Node | null }
  | { k: "frac"; num: Node; den: Node; bar: boolean }
  | { k: "sqrt"; body: Node; index: Node | null }
  | { k: "bigop"; s: string; limits: boolean }
  | { k: "fn"; s: string; limits: boolean }
  | { k: "delim"; l: string; r: string; body: Node }
  | { k: "matrix"; rows: Node[][]; l: string; r: string; align: "c" | "l" | "rl" }
  | { k: "accent"; acc: "vec" | "hat" | "bar" | "dot" | "ddot" | "tilde" | "under"; body: Node }
  | { k: "xarrow"; label: Node | null; dir: "right" | "left" | "both" | "eq" }
  | { k: "space"; em: number }
  | { k: "blank"; n: number };

const SYMBOLS: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", vartheta: "θ",
  iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", varpi: "π", rho: "ρ", varrho: "ρ", sigma: "σ",
  varsigma: "σ", tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  infty: "∞", partial: "∂", nabla: "∇", ell: "ℓ", hbar: "ℏ", aleph: "ℵ", emptyset: "∅", varnothing: "∅", angle: "∠",
  measuredangle: "∠", triangle: "△", perp: "⊥", parallel: "∥", degree: "°", prime: "′", therefore: "∴", because: "∵",
  ldots: "…", dots: "…", cdots: "⋯", vdots: "⋮", ddots: "⋱", forall: "∀", exists: "∃", neg: "¬", lnot: "¬", top: "⊤",
  bot: "⊥", dagger: "†", ddagger: "‡", checkmark: "✓", star: "*", ast: "*", circ: "∘", bullet: "•", deg: "°",
  "%": "%", "$": "$", "#": "#", "&": "&", "{": "{", "}": "}", "_": "_", backslash: "\\", lbrace: "{", rbrace: "}",
  langle: "⟨", rangle: "⟩", lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉", vert: "|", Vert: "‖", lvert: "|", rvert: "|",
  lVert: "‖", rVert: "‖",
};
const BINS: Record<string, string> = {
  pm: "±", mp: "∓", times: "×", div: "÷", cdot: "·", cup: "∪", cap: "∩", wedge: "∧", land: "∧", vee: "∨", lor: "∨",
  oplus: "⊕", otimes: "⊗", setminus: "∖", odot: "⊙",
};
const RELS: Record<string, string> = {
  le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", approx: "≈", equiv: "≡", sim: "∼", simeq: "≃", cong: "≅",
  propto: "∝", ll: "≪", gg: "≫", in: "∈", notin: "∉", ni: "∋", subset: "⊂", subseteq: "⊆", supset: "⊃", supseteq: "⊇",
  to: "→", rightarrow: "→", longrightarrow: "→", leftarrow: "←", gets: "←", longleftarrow: "←", Rightarrow: "⇒",
  implies: "⇒", Longrightarrow: "⇒", Leftarrow: "⇐", Leftrightarrow: "⇔", iff: "⇔", leftrightarrow: "↔",
  longleftrightarrow: "↔", mapsto: "↦", uparrow: "↑", downarrow: "↓", nearrow: "↗", searrow: "↘",
  rightleftharpoons: "⇌", leftrightharpoons: "⇌", rightleftarrows: "⇌", mid: "|", models: "⊨", vdash: "⊢", coloneqq: "≔",
};
const BIGOPS: Record<string, { s: string; limits: boolean }> = {
  int: { s: "∫", limits: false }, iint: { s: "∬", limits: false }, iiint: { s: "∭", limits: false }, oint: { s: "∮", limits: false },
  sum: { s: "∑", limits: true }, prod: { s: "∏", limits: true }, bigcup: { s: "∪", limits: true }, bigcap: { s: "∩", limits: true },
  coprod: { s: "∐", limits: true },
};
const FUNCS = new Set([
  "sin", "cos", "tan", "sec", "csc", "cot", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "ln", "log", "exp", "det",
  "gcd", "arg", "dim", "ker", "deg", "Pr", "lcm", "mod", "sgn", "Re", "Im", "tr", "rank", "span", "proj", "Var", "Cov", "E",
]);
const LIMIT_FUNCS = new Set(["lim", "limsup", "liminf", "max", "min", "sup", "inf", "argmax", "argmin"]);
const ACCENTS: Record<string, "vec" | "hat" | "bar" | "dot" | "ddot" | "tilde" | "under"> = {
  vec: "vec", overrightarrow: "vec", hat: "hat", widehat: "hat", bar: "bar", overline: "bar", dot: "dot", ddot: "ddot",
  tilde: "tilde", widetilde: "tilde", underline: "under",
};
const BLACKBOARD: Record<string, string> = { R: "ℝ", N: "ℕ", Z: "ℤ", Q: "ℚ", C: "ℂ", P: "ℙ" };
const SPACES: Record<string, number> = { ",": 0.17, ":": 0.22, ";": 0.28, " ": 0.3, quad: 1, qquad: 2, "!": -0.1, enspace: 0.5 };
const DELIMS: Record<string, string> = {
  "(": "(", ")": ")", "[": "[", "]": "]", "\\{": "{", "\\}": "}", "|": "|", "\\|": "‖", ".": "", "\\langle": "⟨",
  "\\rangle": "⟩", "\\lfloor": "⌊", "\\rfloor": "⌋", "\\lceil": "⌈", "\\rceil": "⌉", "\\vert": "|", "\\Vert": "‖",
  "\\lvert": "|", "\\rvert": "|", "<": "⟨", ">": "⟩", "\\lbrace": "{", "\\rbrace": "}",
};
const ENV_DELIMS: Record<string, [string, string]> = {
  matrix: ["", ""], pmatrix: ["(", ")"], bmatrix: ["[", "]"], Bmatrix: ["{", "}"], vmatrix: ["|", "|"], Vmatrix: ["‖", "‖"],
  smallmatrix: ["", ""], cases: ["{", ""], dcases: ["{", ""], rcases: ["", "}"], array: ["", ""], aligned: ["", ""],
  align: ["", ""], "align*": ["", ""], gathered: ["", ""], split: ["", ""], eqnarray: ["", ""],
};
const RELCHARS = "=<>≤≥≠≈≡∼≅∝≪≫∈∉∋⊂⊆⊃⊇→←⇒⇐⇔↔↦⇌:≔";
const BINCHARS = "+−-±∓×÷·∪∩∧∨⊕⊗∖*";

class Parser {
  i = 0;
  private src: string;
  constructor(src: string) {
    this.src = src;
  }

  parse(): Node {
    return this.row(() => false);
  }

  private peek(n = 0) {
    return this.src[this.i + n];
  }
  private eof() {
    return this.i >= this.src.length;
  }

  // A run of items until `stop` says so (or the end).
  private row(stop: () => boolean): Node {
    const items: Node[] = [];
    while (!this.eof() && !stop()) {
      const n = this.atom(items);
      if (n) items.push(this.scripts(n));
    }
    return { k: "row", items };
  }

  // ^ and _ after an atom.
  private scripts(base: Node): Node {
    let sup: Node | null = null, sub: Node | null = null;
    for (;;) {
      this.skipSpace();
      const c = this.peek();
      if (c === "^" && !sup) {
        this.i++;
        sup = this.arg();
      } else if (c === "_" && !sub && this.peek(1) !== "_") {
        this.i++;
        sub = this.arg();
      } else if (c === "'" ) {
        this.i++;
        const prime: Node = { k: "sym", s: "′", cls: "ord" };
        sup = sup ? { k: "row", items: [sup, prime] } : prime;
      } else break;
    }
    return sup || sub ? { k: "scripts", base, sup, sub } : base;
  }

  private skipSpace() {
    // spaces right before ^ or _ don't count
    let j = this.i;
    while (this.src[j] === " ") j++;
    if (this.src[j] === "^" || (this.src[j] === "_" && this.src[j + 1] !== "_")) this.i = j;
  }

  // One argument: a {group}, a command, or a single character.
  private arg(): Node {
    while (this.peek() === " ") this.i++;
    if (this.eof()) return { k: "row", items: [] };
    if (this.peek() === "{") return this.group();
    if (this.peek() === "\\") {
      const n = this.atom([]);
      return n ?? { k: "row", items: [] };
    }
    const ch = [...this.src.slice(this.i)][0];
    this.i += ch.length;
    return symOf(ch);
  }

  private group(): Node {
    this.i++; // {
    const body = this.row(() => this.peek() === "}");
    if (this.peek() === "}") this.i++;
    return body;
  }

  // The raw text of a {group}, for \text and \begin.
  private rawGroup(): string {
    while (this.peek() === " ") this.i++;
    if (this.peek() !== "{") return "";
    let depth = 0;
    const start = this.i + 1;
    for (; this.i < this.src.length; this.i++) {
      if (this.src[this.i] === "{") depth++;
      else if (this.src[this.i] === "}" && --depth === 0) break;
    }
    const s = this.src.slice(start, this.i);
    this.i++;
    return s;
  }

  private command(): string {
    this.i++; // backslash
    const m = /^[a-zA-Z]+\*?/.exec(this.src.slice(this.i));
    if (m) {
      this.i += m[0].length;
      return m[0];
    }
    const c = this.src[this.i] ?? "";
    this.i++;
    return c;
  }

  private delimiter(): string {
    while (this.peek() === " ") this.i++;
    if (this.peek() === "\\") {
      const save = this.i;
      const name = "\\" + this.command();
      if (name in DELIMS) return DELIMS[name];
      this.i = save + 1;
      return "";
    }
    const c = this.peek() ?? "";
    this.i++;
    return DELIMS[c] ?? c;
  }

  private atom(prev: Node[]): Node | null {
    const c = this.peek();
    if (c === " " || c === "\t" || c === "\n") {
      while (this.peek() === " " || this.peek() === "\t" || this.peek() === "\n") this.i++;
      return { k: "space", em: SPACES[" "] };
    }
    if (c === "{") return this.group();
    if (c === "}") {
      this.i++;
      return null;
    }
    if (c === "_" && this.peek(1) === "_") {
      let n = 0;
      while (this.peek() === "_") {
        this.i++;
        n++;
      }
      return { k: "blank", n };
    }
    if (c === "^" || c === "_") {
      // a script with nothing before it
      this.i++;
      const a = this.arg();
      return c === "^" ? { k: "scripts", base: { k: "row", items: [] }, sup: a, sub: null } : { k: "scripts", base: { k: "row", items: [] }, sup: null, sub: a };
    }
    if (c === "&") {
      this.i++;
      return { k: "space", em: 0.5 };
    }
    if (c === "\\") {
      if (this.peek(1) === "\\") {
        this.i += 2;
        return { k: "space", em: 1 };
      }
      return this.commandAtom(prev);
    }
    // a run of digits (with a decimal point) stays one piece
    const num = /^\d+(?:[.,]\d+)?/.exec(this.src.slice(this.i));
    if (num) {
      this.i += num[0].length;
      return { k: "sym", s: num[0], cls: "ord" };
    }
    const ch = [...this.src.slice(this.i)][0];
    this.i += ch.length;
    return symOf(ch);
  }

  private commandAtom(prev: Node[]): Node | null {
    const name = this.command();
    // a letter-named command eats one space after it, as in TeX
    if (/^[a-zA-Z]/.test(name) && this.peek() === " " && !FUNCS.has(name)) this.i++;
    if (name in SPACES) return { k: "space", em: SPACES[name] };
    if (name in SYMBOLS) return { k: "sym", s: SYMBOLS[name], cls: /[⟨⌊⌈]/.test(SYMBOLS[name]) ? "open" : /[⟩⌋⌉]/.test(SYMBOLS[name]) ? "close" : "ord" };
    if (name in BINS) return { k: "sym", s: BINS[name], cls: "bin" };
    if (name in RELS) return { k: "sym", s: RELS[name], cls: "rel" };
    if (name in BIGOPS) {
      const op = BIGOPS[name];
      let limits = op.limits;
      for (;;) {
        const rest = this.src.slice(this.i);
        if (rest.startsWith("\\limits")) {
          this.i += 7;
          limits = true;
        } else if (rest.startsWith("\\nolimits")) {
          this.i += 9;
          limits = false;
        } else break;
      }
      return { k: "bigop", s: op.s, limits };
    }
    if (FUNCS.has(name)) return { k: "fn", s: name, limits: false };
    if (LIMIT_FUNCS.has(name)) return { k: "fn", s: name === "argmax" ? "arg max" : name === "argmin" ? "arg min" : name, limits: true };
    if (name === "operatorname" || name === "operatorname*") return { k: "fn", s: this.rawGroup(), limits: name.endsWith("*") };
    if (name === "frac" || name === "dfrac" || name === "tfrac" || name === "cfrac") return { k: "frac", num: this.arg(), den: this.arg(), bar: true };
    if (name === "binom" || name === "dbinom" || name === "tbinom" || name === "choose") {
      if (name === "choose") return { k: "space", em: 0.3 };
      return { k: "delim", l: "(", r: ")", body: { k: "frac", num: this.arg(), den: this.arg(), bar: false } };
    }
    if (name === "sqrt") {
      let index: Node | null = null;
      while (this.peek() === " ") this.i++;
      if (this.peek() === "[") {
        this.i++;
        index = this.row(() => this.peek() === "]");
        this.i++;
      }
      return { k: "sqrt", body: this.arg(), index };
    }
    if (name in ACCENTS) return { k: "accent", acc: ACCENTS[name], body: this.arg() };
    if (name === "text" || name === "textrm" || name === "mbox" || name === "textit" || name === "textbf" || name === "mathrm" || name === "textnormal")
      return { k: "text", s: this.rawGroup() };
    if (name === "mathbf" || name === "boldsymbol" || name === "bm" || name === "mathit" || name === "mathsf" || name === "mathcal" || name === "mathscr" || name === "pmb")
      return this.arg();
    if (name === "mathbb") {
      const s = this.rawGroup().trim();
      return { k: "sym", s: [...s].map((ch) => BLACKBOARD[ch] ?? ch).join(""), cls: "ord" };
    }
    if (name === "ce") return new Parser(chemistry(this.rawGroup())).parse();
    if (name === "xrightarrow" || name === "xleftarrow" || name === "xleftrightarrow" || name === "xrightleftharpoons") {
      while (this.peek() === " ") this.i++;
      if (this.peek() === "[") {
        while (!this.eof() && this.peek() !== "]") this.i++;
        this.i++;
      }
      const label = this.arg();
      return { k: "xarrow", label, dir: name === "xrightarrow" ? "right" : name === "xleftarrow" ? "left" : name === "xleftrightarrow" ? "both" : "eq" };
    }
    if (name === "left") {
      const l = this.delimiter();
      const body = this.row(() => this.src.startsWith("\\right", this.i));
      let r = "";
      if (this.src.startsWith("\\right", this.i)) {
        this.i += 6;
        r = this.delimiter();
      }
      return { k: "delim", l, r, body };
    }
    if (name === "right") return null;
    if (/^(big|Big|bigg|Bigg)[lr]?$/.test(name)) {
      const d = this.delimiter();
      return { k: "sym", s: d, cls: name.endsWith("l") ? "open" : name.endsWith("r") ? "close" : "ord" };
    }
    if (name === "begin") return this.environment(this.rawGroup());
    if (name === "end") {
      this.rawGroup();
      return null;
    }
    if (name === "displaystyle" || name === "textstyle" || name === "limits" || name === "nolimits" || name === "noindent" || name === "label" || name === "tag" || name === "qed") {
      if (name === "label" || name === "tag") this.rawGroup();
      return { k: "row", items: [] };
    }
    if (name === "not") {
      const next = this.arg();
      if (next.k === "sym" && next.s === "=") return { k: "sym", s: "≠", cls: "rel" };
      if (next.k === "sym" && next.s === "∈") return { k: "sym", s: "∉", cls: "rel" };
      return next;
    }
    if (name === "pmod") return { k: "row", items: [{ k: "sym", s: "(", cls: "open" }, { k: "text", s: "mod " }, this.arg(), { k: "sym", s: ")", cls: "close" }] };
    if (name === "cancel" || name === "bcancel" || name === "xcancel" || name === "boxed" || name === "phantom" || name === "color") {
      if (name === "color") {
        this.rawGroup();
        return { k: "row", items: [] };
      }
      return this.arg();
    }
    if (name === "textcolor") {
      this.rawGroup();
      return this.arg();
    }
    // An unknown command: write its name rather than lose it.
    void prev;
    return /^[a-zA-Z]+$/.test(name) ? { k: "text", s: name } : { k: "sym", s: name, cls: "ord" };
  }

  private environment(env: string): Node {
    if (env === "array" || env === "tabular") this.rawGroup(); // column spec
    const end = `\\end{${env}}`;
    const rows: Node[][] = [[]];
    while (!this.eof() && !this.src.startsWith(end, this.i)) {
      const cell = this.row(() => this.peek() === "&" || this.src.startsWith("\\\\", this.i) || this.src.startsWith(end, this.i));
      rows.at(-1)!.push(cell);
      if (this.peek() === "&") this.i++;
      else if (this.src.startsWith("\\\\", this.i)) {
        this.i += 2;
        rows.push([]);
      }
    }
    if (this.src.startsWith(end, this.i)) this.i += end.length;
    const kept = rows.filter((r) => r.some((c) => !(c.k === "row" && c.items.every((x) => x.k === "space"))));
    const [l, r] = ENV_DELIMS[env] ?? ["", ""];
    const align = env.includes("cases") ? "l" : /align|split|eqnarray/.test(env) ? "rl" : "c";
    return { k: "matrix", rows: kept.length ? kept : [[{ k: "row", items: [] }]], l, r, align };
  }
}

function symOf(ch: string): Node {
  if (ch === "-") return { k: "sym", s: "−", cls: "bin" };
  if (ch === "*") return { k: "sym", s: "·", cls: "bin" };
  if (BINCHARS.includes(ch)) return { k: "sym", s: ch, cls: "bin" };
  if (RELCHARS.includes(ch)) return { k: "sym", s: ch, cls: "rel" };
  if ("([{".includes(ch)) return { k: "sym", s: ch, cls: "open" };
  if (")]}".includes(ch)) return { k: "sym", s: ch, cls: "close" };
  if (",;".includes(ch)) return { k: "sym", s: ch, cls: "punct" };
  return { k: "sym", s: ch, cls: "ord" };
}

// \ce{2H2 + O2 -> 2H2O}: numbers after letters go down, charges go up, arrows become arrows.
export function chemistry(src: string): string {
  return src
    .replace(/<=>|<->/g, " \\rightleftharpoons ")
    .replace(/->/g, " \\rightarrow ")
    .replace(/<-/g, " \\leftarrow ")
    .replace(/\^\{?([0-9]*[+-])\}?/g, "^{$1}")
    .replace(/([A-Za-z)\]])(\d+)/g, "$1_{$2}")
    .replace(/\s\+\s/g, " + ");
}

export function parseMath(src: string): Node {
  return new Parser(src).parse();
}

// ---------- laying it out ----------
const SCRIPT = 0.66;
const AXIS = 0.36; // where fraction bars and the middle of = sit, as a part of the letter size

function hbox(parts: { box: MathBox; dx: number; dy: number }[], w?: number): MathBox {
  const items: MathItem[] = [];
  let asc = 0, desc = 0, right = 0;
  for (const { box, dx, dy } of parts) {
    for (const it of box.items) items.push(shift(it, dx, dy));
    asc = Math.max(asc, box.asc - dy);
    desc = Math.max(desc, box.desc + dy);
    right = Math.max(right, dx + box.w);
  }
  return { w: w ?? right, asc, desc, items };
}

function shift(it: MathItem, dx: number, dy: number): MathItem {
  if (it.t === "text") return { ...it, x: it.x + dx, y: it.y + dy };
  return { t: "path", pts: it.pts.map(([x, y]) => [x + dx, y + dy] as [number, number]) };
}

const empty = (): MathBox => ({ w: 0, asc: 0, desc: 0, items: [] });
const text = (s: string, size: number, m: GlyphMetrics): MathBox => {
  const g = m(s, size);
  return { w: g.w, asc: g.asc, desc: g.desc, items: [{ t: "text", s, x: 0, y: 0, size }] };
};

function isEmpty(n: Node) {
  return n.k === "row" && n.items.length === 0;
}

function layout(n: Node, size: number, m: GlyphMetrics): MathBox {
  switch (n.k) {
    case "sym":
      return text(n.s, size, m);
    case "text":
      return text(n.s, size, m);
    case "space":
      return { w: n.em * size, asc: 0, desc: 0, items: [] };
    case "blank": {
      const w = Math.max(2, n.n) * size * 0.45;
      return { w: w + size * 0.2, asc: size * 0.2, desc: size * 0.1, items: [{ t: "path", pts: [[size * 0.1, size * 0.08], [w + size * 0.1, size * 0.08]] }] };
    }
    case "row":
      return row(n.items, size, m);
    case "fn":
      return text(n.s, size, m);
    case "bigop":
      return bigop(n.s, size, m);
    case "scripts":
      return scripts(n, size, m);
    case "frac":
      return frac(n, size, m);
    case "sqrt":
      return sqrt(n, size, m);
    case "delim":
      return delim(n.l, n.r, layout(n.body, size, m), size, m);
    case "matrix":
      return matrix(n, size, m);
    case "accent":
      return accent(n, size, m);
    case "xarrow":
      return xarrow(n, size, m);
  }
}

function bigop(s: string, size: number, m: GlyphMetrics): MathBox {
  const k = s === "∫" || s === "∬" || s === "∭" || s === "∮" ? 1.7 : 1.6;
  const big = text(s, size * k, m);
  // centre it on the axis
  const mid = (big.asc - big.desc) / 2;
  const dy = mid - size * AXIS;
  return hbox([{ box: big, dx: 0, dy }]);
}

// Spacing like a careful hand: a little air around = and +, none after a sign that starts a term.
function row(items: Node[], size: number, m: GlyphMetrics): MathBox {
  const parts: { box: MathBox; dx: number; dy: number }[] = [];
  let x = 0;
  let prevCls: string | null = null;
  let prevSpace = true;
  items.forEach((n, i) => {
    const cls = classOf(n);
    const explicitSpace = n.k === "space";
    let gap = 0;
    if (!explicitSpace && !prevSpace) {
      if (cls === "rel" || (prevCls === "rel" && cls !== "punct")) gap = size * 0.28;
      else if (cls === "bin" && prevCls && prevCls !== "open" && prevCls !== "bin" && prevCls !== "rel" && prevCls !== "punct") gap = size * 0.2;
      else if (prevCls === "bin" && isBinary(items, i - 1)) gap = size * 0.2;
      else if (prevCls === "punct") gap = size * 0.18;
      else if (prevCls === "fn" && cls !== "open") gap = size * 0.15;
      else if (prevCls === "bigop") gap = size * 0.16;
    }
    x += gap;
    const box = layout(n, size, m);
    parts.push({ box, dx: x, dy: 0 });
    x += box.w;
    prevCls = cls;
    prevSpace = explicitSpace;
  });
  return parts.length ? hbox(parts, x) : { ...empty(), asc: size * 0.7 };
}

function classOf(n: Node): string {
  if (n.k === "sym") return n.cls;
  if (n.k === "scripts") return classOf(n.base) === "bigop" ? "bigop" : classOf(n.base) === "fn" ? "fn" : "ord";
  if (n.k === "fn") return "fn";
  if (n.k === "bigop") return "bigop";
  if (n.k === "xarrow") return "rel";
  return "ord";
}

// A + or − is a binary sign when something stands before it that it joins to.
function isBinary(items: Node[], i: number) {
  for (let j = i - 1; j >= 0; j--) {
    if (items[j].k === "space") continue;
    const c = classOf(items[j]);
    return c !== "open" && c !== "bin" && c !== "rel" && c !== "punct";
  }
  return false;
}

function scripts(n: Extract<Node, { k: "scripts" }>, size: number, m: GlyphMetrics): MathBox {
  const ss = Math.max(11, size * SCRIPT);
  const base = layout(n.base, size, m);
  const sup = n.sup ? layout(n.sup, ss, m) : null;
  const sub = n.sub ? layout(n.sub, ss, m) : null;
  const op = n.base.k === "bigop" ? n.base : n.base.k === "fn" && n.base.limits ? n.base : null;
  const limits = op && (op.k === "bigop" ? op.limits : true);
  if (limits) {
    // limits go above and below, centred
    const w = Math.max(base.w, sup?.w ?? 0, sub?.w ?? 0);
    const parts = [{ box: base, dx: (w - base.w) / 2, dy: 0 }];
    if (sup) parts.push({ box: sup, dx: (w - sup.w) / 2, dy: -(base.asc + size * 0.12 + sup.desc) });
    if (sub) parts.push({ box: sub, dx: (w - sub.w) / 2, dy: base.desc + size * 0.12 + sub.asc });
    return hbox(parts, w);
  }
  const integral = n.base.k === "bigop";
  const tall = base.asc > size * 1.15;
  const parts = [{ box: base, dx: 0, dy: 0 }];
  let w = base.w;
  if (sup) {
    const dy = integral ? -(base.asc - sup.asc * 0.7) : tall ? -(base.asc - sup.asc * 0.55) : -size * 0.5;
    const dx = base.w + (integral ? size * 0.1 : size * 0.04);
    parts.push({ box: sup, dx, dy });
    w = Math.max(w, dx + sup.w);
  }
  if (sub) {
    const dy = integral ? base.desc + sub.asc * 0.25 : tall ? base.desc * 0.8 + sub.asc * 0.3 : size * 0.3;
    const dx = base.w + (integral ? -size * 0.2 : size * 0.02);
    parts.push({ box: sub, dx, dy: Math.max(dy, sup ? size * 0.36 : 0) });
    w = Math.max(w, dx + sub.w);
  }
  return hbox(parts, w + size * 0.06);
}

function frac(n: Extract<Node, { k: "frac" }>, size: number, m: GlyphMetrics): MathBox {
  const fs = Math.max(12, size * 0.86);
  const num = layout(n.num, fs, m);
  const den = layout(n.den, fs, m);
  const w = Math.max(num.w, den.w) + size * 0.3;
  const axis = size * AXIS;
  const gap = size * 0.2;
  const parts = [{ box: num, dx: (w - num.w) / 2, dy: -axis - gap - num.desc }];
  const bar: MathBox = n.bar ? { w, asc: axis, desc: 0, items: [{ t: "path", pts: [[size * 0.02, -axis], [w - size * 0.02, -axis]] }] } : empty();
  return hbox([...parts, { box: bar, dx: 0, dy: 0 }, { box: den, dx: (w - den.w) / 2, dy: -axis + gap + den.asc }], w);
}

function sqrt(n: Extract<Node, { k: "sqrt" }>, size: number, m: GlyphMetrics): MathBox {
  const body = layout(n.body, size, m);
  const top = -(Math.max(body.asc, size * 0.75) + size * 0.16);
  const bottom = Math.max(body.desc, size * 0.04) + size * 0.04;
  const H = bottom - top;
  const r = size * 0.42 + H * 0.12;
  const index = n.index ? layout(n.index, Math.max(10, size * 0.5), m) : null;
  const lead = index ? Math.max(0, index.w - r * 0.45) : 0;
  const end = lead + r + size * 0.12 + body.w + size * 0.12;
  const sign: [number, number][] = [
    [lead, top + H * 0.6],
    [lead + r * 0.18, top + H * 0.52],
    [lead + r * 0.5, bottom],
    [lead + r, top],
    [end, top],
  ];
  const parts: { box: MathBox; dx: number; dy: number }[] = [{ box: { w: end, asc: -top, desc: bottom, items: [{ t: "path", pts: sign }] }, dx: 0, dy: 0 }];
  if (index) parts.push({ box: index, dx: lead + r * 0.4 - index.w, dy: top + H * 0.45 });
  parts.push({ box: body, dx: lead + r + size * 0.12, dy: 0 });
  return hbox(parts, end + size * 0.05);
}

// A bracket tall enough for what it holds, drawn with the pen.
function delimPath(d: string, x: number, top: number, bottom: number, size: number, side: "l" | "r"): { w: number; paths: [number, number][][] } {
  const H = bottom - top;
  const w = Math.min(size * 0.5, size * 0.22 + H * 0.08);
  const mirror = (pts: [number, number][]) => pts.map(([px, py]) => [x + w - (px - x), py] as [number, number]);
  void side;
  const n = 14;
  if (d === "(" || d === ")") {
    const pts: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      pts.push([x + w * 0.85 - w * 0.7 * Math.sin(Math.PI * t), top + H * t]);
    }
    return { w, paths: [d === ")" ? mirror(pts) : pts] };
  }
  if (d === "[" || d === "]" || d === "⌊" || d === "⌋" || d === "⌈" || d === "⌉") {
    const left = d === "[" || d === "⌊" || d === "⌈";
    const a = left ? x + w * 0.85 : x + w * 0.15, b = left ? x + w * 0.25 : x + w * 0.75;
    const topArm = d !== "⌊" && d !== "⌋", botArm = d !== "⌈" && d !== "⌉";
    const pts: [number, number][] = [];
    if (topArm) pts.push([a, top]);
    pts.push([b, top], [b, bottom]);
    if (botArm) pts.push([a, bottom]);
    return { w, paths: [pts] };
  }
  if (d === "{" || d === "}") {
    const left = d === "{";
    const s = left ? 1 : -1;
    const ox = left ? x + w * 0.85 : x + w * 0.15;
    const mid = (top + bottom) / 2;
    const k = w * 0.45;
    const pts: [number, number][] = [];
    const seg = (y0: number, y1: number, x0: number, x1: number) => {
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        const e = t * t * (3 - 2 * t);
        pts.push([x0 + (x1 - x0) * e, y0 + (y1 - y0) * t]);
      }
    };
    seg(top, top + H * 0.08, ox, ox - s * k);
    seg(top + H * 0.08, mid - H * 0.06, ox - s * k, ox - s * k);
    seg(mid - H * 0.06, mid, ox - s * k, ox - s * w * 0.75);
    seg(mid, mid + H * 0.06, ox - s * w * 0.75, ox - s * k);
    seg(mid + H * 0.06, bottom - H * 0.08, ox - s * k, ox - s * k);
    seg(bottom - H * 0.08, bottom, ox - s * k, ox);
    return { w, paths: [pts] };
  }
  if (d === "|") return { w: size * 0.22, paths: [[[x + size * 0.11, top], [x + size * 0.11, bottom]]] };
  if (d === "‖") return { w: size * 0.36, paths: [[[x + size * 0.1, top], [x + size * 0.1, bottom]], [[x + size * 0.26, top], [x + size * 0.26, bottom]]] };
  if (d === "⟨" || d === "⟩") {
    const pts: [number, number][] = [[x + w * 0.8, top], [x + w * 0.2, (top + bottom) / 2], [x + w * 0.8, bottom]];
    return { w, paths: [d === "⟩" ? mirror(pts) : pts] };
  }
  return { w: 0, paths: [] };
}

function delim(l: string, r: string, body: MathBox, size: number, m: GlyphMetrics): MathBox {
  const axis = size * AXIS;
  const half = Math.max(body.asc - axis, body.desc + axis, size * 0.62) + size * 0.1;
  const top = -axis - half, bottom = -axis + half;
  // a bracket around one line of plain writing is just the hand's own bracket
  const small = bottom - top < size * 1.55;
  const parts: { box: MathBox; dx: number; dy: number }[] = [];
  let x = 0;
  const side = (d: string, s: "l" | "r") => {
    if (!d) return;
    if (small && "()[]{}|".includes(d)) {
      const t = text(d, size, m);
      parts.push({ box: t, dx: x, dy: 0 });
      x += t.w;
      return;
    }
    const p = delimPath(d, 0, top, bottom, size, s);
    parts.push({ box: { w: p.w, asc: -top, desc: bottom, items: p.paths.map((pts) => ({ t: "path" as const, pts })) }, dx: x, dy: 0 });
    x += p.w + size * 0.06;
  };
  side(l, "l");
  if (l) x += size * 0.04;
  parts.push({ box: body, dx: x, dy: 0 });
  x += body.w + (r ? size * 0.04 : 0);
  side(r, "r");
  return hbox(parts, x);
}

function matrix(n: Extract<Node, { k: "matrix" }>, size: number, m: GlyphMetrics): MathBox {
  const cs = n.align === "c" && n.l ? size * 0.92 : size;
  const cells = n.rows.map((r) => r.map((c) => layout(c, cs, m)));
  const cols = Math.max(...cells.map((r) => r.length));
  const colW = Array.from({ length: cols }, (_, c) => Math.max(0, ...cells.map((r) => r[c]?.w ?? 0)));
  const rowA = cells.map((r) => Math.max(size * 0.7, ...r.map((c) => c.asc)));
  const rowD = cells.map((r) => Math.max(size * 0.2, ...r.map((c) => c.desc)));
  const gapY = size * 0.45;
  const gapX = n.align === "rl" ? 0 : n.align === "l" ? size * 1.2 : size * 0.9;
  const totalH = rowA.reduce((a, b) => a + b, 0) + rowD.reduce((a, b) => a + b, 0) + gapY * (cells.length - 1);
  // the middle of the block sits on the axis
  let y = -size * AXIS - totalH / 2;
  const parts: { box: MathBox; dx: number; dy: number }[] = [];
  cells.forEach((r, ri) => {
    const base = y + rowA[ri];
    let x = 0;
    for (let c = 0; c < cols; c++) {
      const cell = r[c];
      if (cell) {
        const align = n.align === "c" ? "c" : n.align === "l" ? "l" : c % 2 === 0 ? "r" : "l";
        const dx = align === "c" ? (colW[c] - cell.w) / 2 : align === "r" ? colW[c] - cell.w : 0;
        parts.push({ box: cell, dx: x + dx, dy: base });
      }
      x += colW[c] + gapX;
    }
    y = base + rowD[ri] + gapY;
  });
  const w = colW.reduce((a, b) => a + b, 0) + gapX * (cols - 1);
  const body = hbox(parts, w);
  body.asc = Math.max(body.asc, size * AXIS + totalH / 2);
  body.desc = Math.max(body.desc, totalH / 2 - size * AXIS);
  if (!n.l && !n.r) return body;
  return delim(n.l, n.r, { ...body, items: body.items }, size, m);
}

function accent(n: Extract<Node, { k: "accent" }>, size: number, m: GlyphMetrics): MathBox {
  const body = layout(n.body, size, m);
  const top = -(Math.max(body.asc, size * 0.7) + size * 0.14);
  const x0 = size * 0.05, x1 = Math.max(body.w - size * 0.05, size * 0.4);
  const mid = (x0 + x1) / 2;
  const paths: [number, number][][] = [];
  if (n.acc === "vec") {
    const y = top - size * 0.06;
    paths.push([[x0, y], [x1, y]], [[x1 - size * 0.16, y - size * 0.11], [x1, y], [x1 - size * 0.16, y + size * 0.11]]);
  } else if (n.acc === "bar") paths.push([[x0, top], [x1, top]]);
  else if (n.acc === "hat") paths.push([[mid - size * 0.2, top + size * 0.02], [mid, top - size * 0.16], [mid + size * 0.2, top + size * 0.02]]);
  else if (n.acc === "tilde") {
    const pts: [number, number][] = [];
    for (let i = 0; i <= 10; i++) pts.push([mid - size * 0.22 + (size * 0.44 * i) / 10, top - size * 0.05 - Math.sin((i / 10) * Math.PI * 2) * size * 0.06]);
    paths.push(pts);
  } else if (n.acc === "dot" || n.acc === "ddot") {
    const dots = n.acc === "dot" ? [mid] : [mid - size * 0.12, mid + size * 0.12];
    for (const d of dots) paths.push([[d, top - size * 0.02], [d + size * 0.02, top - size * 0.04]]);
  } else if (n.acc === "under") {
    const y = Math.max(body.desc, size * 0.08) + size * 0.1;
    return hbox([{ box: body, dx: 0, dy: 0 }, { box: { w: body.w, asc: 0, desc: y, items: [{ t: "path", pts: [[x0, y], [x1, y]] }] }, dx: 0, dy: 0 }], body.w);
  }
  const mark: MathBox = { w: body.w, asc: -top + size * 0.2, desc: 0, items: paths.map((pts) => ({ t: "path" as const, pts })) };
  return hbox([{ box: body, dx: 0, dy: 0 }, { box: mark, dx: 0, dy: 0 }], body.w);
}

function xarrow(n: Extract<Node, { k: "xarrow" }>, size: number, m: GlyphMetrics): MathBox {
  const label = n.label && !isEmpty(n.label) ? layout(n.label, Math.max(11, size * 0.62), m) : null;
  const len = Math.max(size * 1.6, (label?.w ?? 0) + size * 0.6);
  const y = -size * AXIS;
  const h = size * 0.14;
  const paths: [number, number][][] = [];
  if (n.dir === "eq") {
    paths.push([[0, y - h * 0.8], [len, y - h * 0.8], [len - size * 0.22, y - h * 0.8 - size * 0.16]]);
    paths.push([[len, y + h * 0.8], [0, y + h * 0.8], [size * 0.22, y + h * 0.8 + size * 0.16]]);
  } else {
    paths.push([[0, y], [len, y]]);
    if (n.dir !== "left") paths.push([[len - size * 0.2, y - size * 0.14], [len, y], [len - size * 0.2, y + size * 0.14]]);
    if (n.dir !== "right") paths.push([[size * 0.2, y - size * 0.14], [0, y], [size * 0.2, y + size * 0.14]]);
  }
  const arrowBox: MathBox = { w: len, asc: -y + size * 0.2, desc: 0, items: paths.map((pts) => ({ t: "path" as const, pts })) };
  const parts = [{ box: arrowBox, dx: 0, dy: 0 }];
  if (label) parts.push({ box: label, dx: (len - label.w) / 2, dy: y - size * 0.2 - label.desc });
  return hbox(parts, len);
}

// ---------- the whole line ----------
// Math, or prose with $...$ math in it, laid out on one baseline.
export function layoutMath(src: string, size: number, m: GlyphMetrics): MathBox {
  const s = src.replace(/\\\[|\\\]|\\\(|\\\)/g, "$");
  if (s.includes("$")) {
    const bits = s.split("$");
    const parts: { box: MathBox; dx: number; dy: number }[] = [];
    let x = 0;
    bits.forEach((b, i) => {
      if (!b) return;
      const box = i % 2 ? layout(parseMath(b.trim()), size, m) : text(b, size, m);
      parts.push({ box, dx: x, dy: 0 });
      x += box.w;
    });
    return parts.length ? hbox(parts, x) : empty();
  }
  return layout(parseMath(s.trim()), size, m);
}

// Where a line of math splits on its equals sign, for lining lines up on it:
// the first = (or ≈, ≤, ...) that isn't inside braces, brackets or an environment.
export function equalsAt(src: string): number {
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === "=" || c === "≈" || c === "≤" || c === "≥" || c === "<" || c === ">") && src[i - 1] !== "\\") return i;
    else if (depth === 0 && c === "\\") {
      const m = /^\\(begin|left|approx|le|leq|ge|geq)\b/.exec(src.slice(i));
      if (m?.[1] === "begin" || m?.[1] === "left") {
        const close = m[1] === "begin" ? "\\end" : "\\right";
        const j = src.indexOf(close, i + 2);
        if (j < 0) return -1;
        i = j + close.length;
      } else if (m) return i;
    }
  }
  return -1;
}
