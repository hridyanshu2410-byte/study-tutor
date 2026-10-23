// A small, safe reader for the formulas the tutor asks to plot ("x^2 - 2",
// "2sin(x)", "e^(-x/2)"). It never calls eval: the text is parsed into a tree
// of known operations, so a formula can only ever compute a number.

type Node = (x: number) => number;

const FUNCS: Record<string, (v: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  sqrt: Math.sqrt,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
};
const CONSTS: Record<string, number> = { pi: Math.PI, π: Math.PI, e: Math.E };

type Tok = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

function tokenize(src: string, variable: string): Tok[] {
  const s = src
    .replace(/[−–]/g, "-")
    .replace(/[×·]/g, "*")
    .replace(/÷/g, "/")
    .replace(/²/g, "^2")
    .replace(/³/g, "^3")
    .replace(/√/g, "sqrt")
    .replace(/\*\*/g, "^")
    .replace(variable === "x" ? /^\s*[a-wyz]\s*(\(\s*x\s*\))?\s*=/i : /^(?!)/, ""); // "y =" or "f(x) =" when plotting
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) i++;
    else if (/[0-9.]/.test(c)) {
      const m = /^[0-9]*\.?[0-9]+(e[+-]?[0-9]+)?|^[0-9]+\.?/.exec(s.slice(i))!;
      out.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
    } else if (/[a-zπ]/i.test(c)) {
      const m = /^[a-zπ]+/i.exec(s.slice(i))!;
      out.push(...splitName(m[0].toLowerCase(), variable));
      i += m[0].length;
    } else if ("+-*/^(),".includes(c)) {
      out.push({ t: "op", v: c });
      i++;
    } else throw new Error(`Unexpected "${c}"`);
  }
  return out;
}

// "xsin" or "2pix" style runs of letters: split into known names and the variable.
function splitName(name: string, variable: string): Tok[] {
  const out: Tok[] = [];
  const known = [...Object.keys(FUNCS), ...Object.keys(CONSTS), variable].sort((a, b) => b.length - a.length);
  let rest = name;
  while (rest) {
    const k = known.find((n) => rest.startsWith(n));
    if (!k) throw new Error(`Unknown name "${rest}"`);
    out.push({ t: "id", v: k });
    rest = rest.slice(k.length);
  }
  return out;
}

export function compile(src: string, variable = "x"): Node {
  const toks = tokenize(src, variable.toLowerCase());
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => toks[p]?.t === "op" && toks[p].v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new Error(`Expected "${v}"`);
    p++;
  };

  // sum := term (("+" | "-") term)*
  const sum = (): Node => {
    let left = term();
    while (isOp("+") || isOp("-")) {
      const op = toks[p++].v;
      const a = left, b = term();
      left = op === "+" ? (x) => a(x) + b(x) : (x) => a(x) - b(x);
    }
    return left;
  };
  // term := unary (("*" | "/" | implicit) unary)*
  const term = (): Node => {
    let left = unary();
    for (;;) {
      if (isOp("*") || isOp("/")) {
        const op = toks[p++].v;
        const a = left, b = unary();
        left = op === "*" ? (x) => a(x) * b(x) : (x) => a(x) / b(x);
      } else if (peek() && (peek().t !== "op" || isOp("("))) {
        const a = left, b = power(); // 2x, 3sin(x), (x+1)(x-1)
        left = (x) => a(x) * b(x);
      } else return left;
    }
  };
  const unary = (): Node => {
    if (isOp("-")) {
      p++;
      const a = unary();
      return (x) => -a(x);
    }
    if (isOp("+")) {
      p++;
      return unary();
    }
    return power();
  };
  // power := atom ("^" unary)?   (right-associative, so 2^-x and e^x^2 read naturally)
  const power = (): Node => {
    const base = atom();
    if (isOp("^")) {
      p++;
      const ex = unary();
      return (x) => Math.pow(base(x), ex(x));
    }
    return base;
  };
  const atom = (): Node => {
    const tok = toks[p++];
    if (!tok) throw new Error("Formula ends early");
    if (tok.t === "num") return () => tok.v;
    if (tok.t === "op" && tok.v === "(") {
      const inner = sum();
      expect(")");
      return inner;
    }
    if (tok.t === "id") {
      if (tok.v === variable.toLowerCase()) return (x) => x;
      if (tok.v in CONSTS) return () => CONSTS[tok.v];
      const f = FUNCS[tok.v];
      // sin x, sin(x), sin^2(x) are all common ways to write it
      if (isOp("^")) {
        p++;
        const ex = atom();
        const arg = power();
        return (x) => Math.pow(f(arg(x)), ex(x));
      }
      const arg = power();
      return (x) => f(arg(x));
    }
    throw new Error(`Unexpected "${tok.v}"`);
  };

  const fn = sum();
  if (p < toks.length) throw new Error(`Unexpected "${toks[p].v}"`);
  return fn;
}

// The one letter a formula is written in, such as "t" in "4.9t^2", or null
// for plain arithmetic. Throws when there are several (x and y), since a
// single-variable check can't judge those.
export function variableOf(src: string): string | null {
  const names = new Set<string>();
  const known = [...Object.keys(FUNCS), ...Object.keys(CONSTS)].sort((a, b) => b.length - a.length);
  for (const run of src.toLowerCase().match(/[a-zπ]+/g) ?? []) {
    let rest = run;
    while (rest) {
      const k = known.find((n) => rest.startsWith(n));
      if (k) rest = rest.slice(k.length);
      else {
        names.add(rest[0]);
        rest = rest.slice(1);
      }
    }
  }
  if (names.size > 1) throw new Error(`Several variables: ${[...names].join(", ")}`);
  return [...names][0] ?? null;
}
