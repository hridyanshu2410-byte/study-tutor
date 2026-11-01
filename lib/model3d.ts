// Real 3D models the tutor can put on the page when a topic needs one: the
// layers of the Earth, an atom, DNA, a cell, the solar system, an engine, a
// molecule, a solid of revolution, a surface z = f(x, y), a geometric solid,
// vectors in space, or an assembly of parts. The model names what it wants
// and the app builds it from code; no code from the model runs.
//
// Ideas from the teardown skill (github.com/elvarofficial/teardown, MIT):
// real dimensions from one source, one input driving every moving part, the
// part being talked about opening up (isolate, cutaway, x-ray, exploded
// view), labels with leaders, a light studio with one accent colour, and a
// slow turn when left alone that hands control over at the first touch.

import { z } from "zod";
import { compile } from "./expr.ts";

const label = z.string().nullable();
const vec = z.array(z.number()).describe("[x, y, z]");

export const PRESETS = ["earth_layers", "atom", "dna", "animal_cell", "plant_cell", "solar_system", "piston_engine"] as const;
export const MOLECULES = [
  "water",
  "carbon_dioxide",
  "methane",
  "ammonia",
  "ethene",
  "ethanol",
  "benzene",
  "oxygen",
  "nitrogen",
  "hydrogen_chloride",
  "sodium_chloride_lattice",
] as const;
export const SOLIDS = ["cube", "cuboid", "cylinder", "cone", "sphere", "hemisphere", "square_pyramid", "triangular_prism", "tetrahedron", "frustum"] as const;
export const SHAPES = ["sphere", "box", "cylinder", "cone", "torus", "capsule", "ellipsoid"] as const;
export const MATERIALS = ["metal", "plastic", "glass", "organic", "rock", "water", "wood", "glow"] as const;

// Part names of the built-in models, so the tutor can point at one.
export const PRESET_PARTS: Record<(typeof PRESETS)[number], string[]> = {
  earth_layers: ["crust", "mantle", "outer_core", "inner_core"],
  atom: ["nucleus", "protons", "neutrons", "shell_1", "shell_2", "shell_3", "shell_4", "electrons"],
  dna: ["backbone", "base_pairs", "adenine", "thymine", "guanine", "cytosine"],
  animal_cell: ["cell_membrane", "nucleus", "nucleolus", "mitochondria", "rough_er", "golgi", "lysosomes", "ribosomes"],
  plant_cell: ["cell_wall", "cell_membrane", "vacuole", "chloroplasts", "nucleus", "mitochondria"],
  solar_system: ["sun", "mercury", "venus", "earth", "mars", "jupiter", "saturn", "uranus", "neptune"],
  piston_engine: ["cylinder", "piston", "connecting_rod", "crankshaft", "spark_plug", "intake_valve", "exhaust_valve"],
};

const Preset = z.object({
  kind: z.literal("preset"),
  title: label,
  preset: z
    .enum(PRESETS)
    .describe(
      `A built, labelled model: ${Object.entries(PRESET_PARTS)
        .map(([k, v]) => `${k} (parts: ${v.join(", ")})`)
        .join("; ")}.`,
    ),
  element: label.describe("atom only: the element's symbol, such as \"C\" or \"Na\" (up to krypton). Null otherwise."),
});

const Molecule = z.object({
  kind: z.literal("molecule"),
  title: label,
  molecule: z.enum(MOLECULES).nullable().describe("A known molecule or crystal, built with real bond lengths and angles. Null to build one from center, ligands and lone_pairs."),
  center: label.describe("For a molecule not in the list: the central atom's symbol, such as \"S\" in SF6. Its shape follows VSEPR."),
  ligands: z.array(z.string()).describe("Atoms bonded to the centre, such as [\"F\",\"F\",\"F\",\"F\",\"F\",\"F\"]. Empty for a known molecule."),
  lone_pairs: z.number().int().describe("Lone pairs on the centre, from 0 to 3."),
});

const Revolution = z.object({
  kind: z.literal("revolution"),
  title: label,
  formula: z.string().describe("The curve y = f(x) that is turned, in x, such as \"sqrt(x)\" or \"x^2\"."),
  inner: label.describe("For a washer: the inner curve in x, such as \"x^2\" inside \"x\". Null for a solid with no hole."),
  from: z.number(),
  to: z.number(),
  axis: z.enum(["x", "y"]).describe("The axis it turns about."),
});

const Surface = z.object({
  kind: z.literal("surface"),
  title: label,
  formula: z.string().describe("z in terms of x and y, such as \"x^2 - y^2\" or \"sin(x)cos(y)\"."),
  x_min: z.number(),
  x_max: z.number(),
  y_min: z.number(),
  y_max: z.number(),
  point: z.array(z.number()).nullable().describe("[x, y] of a point to mark on the surface, such as a saddle point, with its tangent plane. Null for none."),
});

const Solid = z.object({
  kind: z.literal("solid"),
  title: label,
  solid: z.enum(SOLIDS),
  dims: z
    .array(z.number())
    .describe("Sizes in order: cube [side]; cuboid [length, width, height]; cylinder, cone and hemisphere [radius, height] (hemisphere [radius]); sphere [radius]; square_pyramid [base side, height]; triangular_prism [triangle side, length]; tetrahedron [edge]; frustum [bottom radius, top radius, height]."),
  show_dims: z.boolean().describe("Label the sizes (r = 3, h = 5). False when the student is to find them."),
});

const Vectors = z.object({
  kind: z.literal("vectors"),
  title: label,
  vectors: z.array(z.object({ to: vec, from: vec.nullable().describe("Start point; null for the origin."), label })).describe("Up to six arrows in 3D, such as a, b and a × b."),
  plane: z.boolean().describe("Shade the parallelogram spanned by the first two vectors."),
});

const Assembly = z.object({
  kind: z.literal("assembly"),
  title: label,
  parts: z
    .array(
      z.object({
        id: z.string(),
        label: label,
        shape: z.enum(SHAPES),
        position: vec.describe("Centre, in the model's own units (y is up)."),
        size: vec.describe("sphere [r]; box [w, h, d]; cylinder and cone [r, h]; torus [ring r, tube r]; capsule [r, length]; ellipsoid [rx, ry, rz]."),
        rotation_deg: vec,
        color: z.string().describe("A colour name or hex, such as \"steelblue\" or \"#c2410c\"."),
        material: z.enum(MATERIALS),
      }),
    )
    .describe("Anything else, built from simple solids with real proportions: a heart's chambers, a lever, a lens and a screen, a generator. Up to 24 parts."),
});

export const Model3DSchema = z.union([Preset, Molecule, Revolution, Surface, Solid, Vectors, Assembly]);
export type Model3D = z.infer<typeof Model3DSchema>;

// What the student sees of a model, and how they have turned it.
// `view` is a mode the model offers (whole, exploded, cutaway, xray, disks...).
export type ModelState = { yaw: number; pitch: number; zoom: number; view: string; focus: string | null; playing: boolean; touched: number };
export type PageModel = { id: string; spec: Model3D; x: number; y: number; w: number; h: number; state: ModelState; shownAt?: number };
export const MODEL_W = 620;
export const MODEL_H = 470;

// A model as the tutor asked for it, with sizes made safe to build.
export function sanitizeModel(m: Model3D): Model3D {
  const n = (v: number, lo: number, hi: number, d: number) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
  const v3 = (a: number[] | null | undefined, d = 0): [number, number, number] => [n(a?.[0] ?? d, -1e4, 1e4, d), n(a?.[1] ?? d, -1e4, 1e4, d), n(a?.[2] ?? d, -1e4, 1e4, d)];
  if (m.kind === "revolution") {
    const from = n(m.from, -100, 100, 0), to = n(m.to, -100, 100, 1);
    return { ...m, from: Math.min(from, to), to: Math.max(from, to) === Math.min(from, to) ? Math.min(from, to) + 1 : Math.max(from, to) };
  }
  if (m.kind === "surface") {
    const [x0, x1] = [n(m.x_min, -100, 100, -2), n(m.x_max, -100, 100, 2)];
    const [y0, y1] = [n(m.y_min, -100, 100, -2), n(m.y_max, -100, 100, 2)];
    return { ...m, x_min: Math.min(x0, x1), x_max: x1 > x0 ? x1 : x0 + 4, y_min: Math.min(y0, y1), y_max: y1 > y0 ? y1 : y0 + 4 };
  }
  if (m.kind === "solid") return { ...m, dims: m.dims.slice(0, 3).map((d) => n(Math.abs(d), 0.01, 1e4, 1)) };
  if (m.kind === "vectors") return { ...m, vectors: m.vectors.slice(0, 6).map((v) => ({ ...v, to: v3(v.to), from: v.from ? v3(v.from) : null })) };
  if (m.kind === "assembly")
    return { ...m, parts: m.parts.slice(0, 24).map((p) => ({ ...p, position: v3(p.position), size: v3(p.size, 1).map((s) => Math.max(0.01, Math.abs(s))), rotation_deg: v3(p.rotation_deg) })) };
  if (m.kind === "molecule") return { ...m, ligands: m.ligands.slice(0, 6), lone_pairs: n(m.lone_pairs, 0, 3, 0) };
  return m;
}

// The names of a model's parts, for the tutor to point at.
export function modelParts(m: Model3D): string[] {
  if (m.kind === "preset") return PRESET_PARTS[m.preset] ?? [];
  if (m.kind === "assembly") return m.parts.map((p) => p.id);
  if (m.kind === "vectors") return m.vectors.map((v, i) => v.label ?? `v${i + 1}`);
  if (m.kind === "revolution") return ["curve", "solid", "axis"];
  if (m.kind === "surface") return ["surface", "point"];
  if (m.kind === "solid") return ["solid"];
  return ["molecule"];
}

export function describeModel(m: Model3D): string {
  const what =
    m.kind === "preset"
      ? `${m.preset.replace(/_/g, " ")}${m.element ? ` (${m.element})` : ""}`
      : m.kind === "molecule"
        ? m.molecule?.replace(/_/g, " ") ?? `${m.center}${m.ligands.join("")}`
        : m.kind === "revolution"
          ? `solid of revolution of y = ${m.formula}${m.inner ? ` minus y = ${m.inner}` : ""} on [${m.from}, ${m.to}] about the ${m.axis}-axis`
          : m.kind === "surface"
            ? `surface z = ${m.formula}`
            : m.kind === "solid"
              ? `${m.solid.replace(/_/g, " ")} ${m.dims.join(" × ")}`
              : m.kind === "vectors"
                ? `vectors ${m.vectors.map((v) => `${v.label ?? ""}(${v.to.join(", ")})`).join(", ")}`
                : `assembly of ${m.parts.map((p) => p.label ?? p.id).join(", ")}`;
  return `${m.title ? `"${m.title}": ` : ""}3D model of ${what}`;
}

// z = f(x, y), for surfaces: the y is fixed per row, so the one-variable
// reader does the work. Null when the formula can't be read.
export function compileXY(src: string): ((x: number, y: number) => number) | null {
  const body = src.replace(/^\s*[a-z]\s*(\([^)]*\))?\s*=/i, "");
  try {
    compile(body.replace(/y/gi, "(0.5)"));
  } catch {
    return null;
  }
  const rows = new Map<number, (x: number) => number>();
  return (x, y) => {
    let f = rows.get(y);
    if (!f) {
      try {
        f = compile(body.replace(/y/gi, `(${y})`));
      } catch {
        f = () => NaN;
      }
      if (rows.size > 400) rows.clear();
      rows.set(y, f);
    }
    return f(x);
  };
}

// ---------- chemistry data ----------
export const ELEMENTS = [
  "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne", "Na", "Mg", "Al", "Si", "P", "S", "Cl", "Ar",
  "K", "Ca", "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn", "Ga", "Ge", "As", "Se", "Br", "Kr",
];
// Electrons per shell in the Bohr picture taught in school.
export function shellsOf(symbol: string): number[] {
  const z0 = ELEMENTS.findIndex((e) => e.toLowerCase() === symbol.trim().toLowerCase()) + 1 || 6;
  if (z0 <= 2) return [z0];
  if (z0 <= 10) return [2, z0 - 2];
  if (z0 <= 18) return [2, 8, z0 - 10];
  if (z0 <= 20) return [2, 8, 8, z0 - 18];
  if (z0 <= 30) return [2, 8, z0 - 20 + 8, 2];
  return [2, 8, 18, z0 - 28];
}
export const atomicNumber = (symbol: string) => ELEMENTS.findIndex((e) => e.toLowerCase() === symbol.trim().toLowerCase()) + 1 || 6;

// CPK colours and drawn radii (Å, for ball-and-stick).
export const ATOM_STYLE: Record<string, { color: string; r: number }> = {
  H: { color: "#f4f4f5", r: 0.28 }, C: { color: "#3f3f46", r: 0.42 }, N: { color: "#2563eb", r: 0.4 }, O: { color: "#dc2626", r: 0.4 },
  F: { color: "#84cc16", r: 0.38 }, Cl: { color: "#16a34a", r: 0.5 }, Br: { color: "#9a3412", r: 0.55 }, I: { color: "#6b21a8", r: 0.6 },
  S: { color: "#eab308", r: 0.5 }, P: { color: "#f97316", r: 0.48 }, Na: { color: "#7c3aed", r: 0.42 }, B: { color: "#fda4af", r: 0.4 },
  Xe: { color: "#06b6d4", r: 0.6 }, Si: { color: "#d6b48a", r: 0.5 },
};

type Atom = { el: string; p: [number, number, number] };
type Bond = { a: number; b: number; order: number };
// Real geometry, in ångströms.
export function moleculeData(name: (typeof MOLECULES)[number]): { atoms: Atom[]; bonds: Bond[]; lone?: [number, number, number][] } {
  const t = 0.629;
  switch (name) {
    case "water":
      return { atoms: [{ el: "O", p: [0, 0, 0] }, { el: "H", p: [0.757, -0.586, 0] }, { el: "H", p: [-0.757, -0.586, 0] }], bonds: [{ a: 0, b: 1, order: 1 }, { a: 0, b: 2, order: 1 }], lone: [[0.45, 0.45, 0.55], [-0.45, 0.45, -0.55]] };
    case "carbon_dioxide":
      return { atoms: [{ el: "C", p: [0, 0, 0] }, { el: "O", p: [1.16, 0, 0] }, { el: "O", p: [-1.16, 0, 0] }], bonds: [{ a: 0, b: 1, order: 2 }, { a: 0, b: 2, order: 2 }] };
    case "methane":
      return {
        atoms: [{ el: "C", p: [0, 0, 0] }, { el: "H", p: [t, t, t] }, { el: "H", p: [-t, -t, t] }, { el: "H", p: [-t, t, -t] }, { el: "H", p: [t, -t, -t] }],
        bonds: [1, 2, 3, 4].map((b) => ({ a: 0, b, order: 1 })),
      };
    case "ammonia":
      return {
        atoms: [{ el: "N", p: [0, 0.12, 0] }, { el: "H", p: [0.94, -0.26, 0] }, { el: "H", p: [-0.47, -0.26, 0.814] }, { el: "H", p: [-0.47, -0.26, -0.814] }],
        bonds: [1, 2, 3].map((b) => ({ a: 0, b, order: 1 })),
        lone: [[0, 0.75, 0]],
      };
    case "ethene":
      return {
        atoms: [{ el: "C", p: [0.667, 0, 0] }, { el: "C", p: [-0.667, 0, 0] }, { el: "H", p: [1.23, 0.92, 0] }, { el: "H", p: [1.23, -0.92, 0] }, { el: "H", p: [-1.23, 0.92, 0] }, { el: "H", p: [-1.23, -0.92, 0] }],
        bonds: [{ a: 0, b: 1, order: 2 }, { a: 0, b: 2, order: 1 }, { a: 0, b: 3, order: 1 }, { a: 1, b: 4, order: 1 }, { a: 1, b: 5, order: 1 }],
      };
    case "ethanol":
      return {
        atoms: [
          { el: "C", p: [-0.76, -0.4, 0] }, { el: "C", p: [0.76, -0.4, 0] }, { el: "O", p: [1.24, 0.93, 0] }, { el: "H", p: [2.2, 0.9, 0] },
          { el: "H", p: [-1.12, 0.63, 0] }, { el: "H", p: [-1.12, -0.91, 0.89] }, { el: "H", p: [-1.12, -0.91, -0.89] },
          { el: "H", p: [1.12, -0.91, 0.89] }, { el: "H", p: [1.12, -0.91, -0.89] },
        ],
        bonds: [[0, 1], [1, 2], [2, 3], [0, 4], [0, 5], [0, 6], [1, 7], [1, 8]].map(([a, b]) => ({ a, b, order: 1 })),
      };
    case "benzene": {
      const atoms: Atom[] = [];
      const bonds: Bond[] = [];
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        atoms.push({ el: "C", p: [Math.cos(a) * 1.39, Math.sin(a) * 1.39, 0] });
      }
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        atoms.push({ el: "H", p: [Math.cos(a) * 2.48, Math.sin(a) * 2.48, 0] });
        bonds.push({ a: i, b: (i + 1) % 6, order: i % 2 ? 1 : 2 }, { a: i, b: i + 6, order: 1 });
      }
      return { atoms, bonds };
    }
    case "oxygen":
      return { atoms: [{ el: "O", p: [0.6, 0, 0] }, { el: "O", p: [-0.6, 0, 0] }], bonds: [{ a: 0, b: 1, order: 2 }] };
    case "nitrogen":
      return { atoms: [{ el: "N", p: [0.55, 0, 0] }, { el: "N", p: [-0.55, 0, 0] }], bonds: [{ a: 0, b: 1, order: 3 }] };
    case "hydrogen_chloride":
      return { atoms: [{ el: "Cl", p: [-0.3, 0, 0] }, { el: "H", p: [0.97, 0, 0] }], bonds: [{ a: 0, b: 1, order: 1 }] };
    case "sodium_chloride_lattice": {
      const atoms: Atom[] = [];
      const bonds: Bond[] = [];
      const idx = new Map<string, number>();
      for (let i = -1; i <= 1; i++)
        for (let j = -1; j <= 1; j++)
          for (let k = -1; k <= 1; k++) {
            idx.set(`${i},${j},${k}`, atoms.length);
            atoms.push({ el: (i + j + k) % 2 === 0 ? "Na" : "Cl", p: [i * 2.82, j * 2.82, k * 2.82] });
          }
      for (const [key, a] of idx) {
        const [i, j, k] = key.split(",").map(Number);
        for (const [di, dj, dk] of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
          const b = idx.get(`${i + di},${j + dj},${k + dk}`);
          if (b != null) bonds.push({ a, b, order: 0 });
        }
      }
      return { atoms, bonds };
    }
  }
}

// A molecule from its centre, what is bonded to it and its lone pairs (VSEPR).
export function vsepr(center: string, ligands: string[], lonePairs: number): { atoms: Atom[]; bonds: Bond[]; lone: [number, number, number][] } {
  const steric = Math.max(1, Math.min(6, ligands.length + lonePairs));
  const s3 = Math.sqrt(3) / 2;
  const dirs: Record<number, [number, number, number][]> = {
    1: [[1, 0, 0]],
    2: [[1, 0, 0], [-1, 0, 0]],
    3: [[1, 0, 0], [-0.5, s3, 0], [-0.5, -s3, 0]],
    4: [[0.577, 0.577, 0.577], [-0.577, -0.577, 0.577], [-0.577, 0.577, -0.577], [0.577, -0.577, -0.577]],
    // equatorial first: lone pairs take those
    5: [[1, 0, 0], [-0.5, 0, s3], [-0.5, 0, -s3], [0, 1, 0], [0, -1, 0]],
    6: [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]],
  };
  const d = dirs[steric];
  // lone pairs: the first slots in a trigonal bipyramid, opposite slots in an octahedron
  // lone pairs take the equatorial slots of a trigonal bipyramid, and opposite slots of an octahedron
  const loneSlots = steric === 6 ? [0, 1, 2].slice(0, lonePairs) : d.map((_, i) => i).slice(0, lonePairs);
  const atoms: Atom[] = [{ el: center || "C", p: [0, 0, 0] }];
  const bonds: Bond[] = [];
  const lone: [number, number, number][] = [];
  let li = 0;
  d.forEach((v, i) => {
    if (loneSlots.includes(i)) {
      lone.push([v[0] * 0.75, v[1] * 0.75, v[2] * 0.75]);
      return;
    }
    const el = ligands[li++];
    if (!el) return;
    const len = el === "H" ? 1.05 : 1.55;
    bonds.push({ a: 0, b: atoms.length, order: 1 });
    atoms.push({ el, p: [v[0] * len, v[1] * len, v[2] * len] });
  });
  return { atoms, bonds, lone };
}
