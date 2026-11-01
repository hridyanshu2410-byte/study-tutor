"use client";

// Builds and draws the tutor's 3D models with three.js. One WebGL renderer
// draws every model on the page in turn; each model keeps its last frame on
// its own small canvas, which the page draws like a photo. So a model only
// costs GPU time while it moves.
//
// Taken as ideas from the teardown skill (MIT): a pale studio with soft
// shadows and one accent colour for the part being talked about; the part
// doing the work opens up (isolate, cutaway, x-ray, exploded view); one input
// drives every moving part (the engine's crank angle, the planets' time, the
// sweep of a solid of revolution); labels sit off the model with leaders.

import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import {
  ATOM_STYLE,
  atomicNumber,
  compileXY,
  moleculeData,
  shellsOf,
  vsepr,
  type Model3D,
  type ModelState,
} from "./model3d";
import { compile } from "./expr";
import { seeded } from "./handwriting";

const ACCENT = new THREE.Color("#f97316");
const BG = "#f7f5f0";

type Part = { id: string; label: string | null; group: THREE.Object3D; home: THREE.Vector3; out: THREE.Vector3; anchor: THREE.Vector3 };
// A model ready to draw: its scene, parts, the views it offers, and how its
// moving parts follow time.
export type Built = {
  scene: THREE.Scene;
  root: THREE.Group;
  radius: number;
  parts: Part[];
  views: { id: string; label: string }[];
  animated: boolean;
  // a line of live readout under the title (the engine's stroke, the sweep angle)
  readout: string | null;
  update: (t: number, state: ModelState, explode: number) => void;
  apply: (view: string, focus: string | null) => void;
  dispose: () => void;
};
export type ModelLabel = { id: string; text: string; x: number; y: number; focused: boolean };

// ---------- materials ----------
function material(kind: string, color: string | THREE.Color): THREE.MeshPhysicalMaterial {
  const c = new THREE.Color();
  try {
    c.set(color as THREE.ColorRepresentation);
  } catch {
    c.set("#94a3b8");
  }
  const m = new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.5, metalness: 0, envMapIntensity: 0.6, side: THREE.DoubleSide });
  if (kind === "metal") Object.assign(m, { metalness: 0.85, roughness: 0.38, envMapIntensity: 0.9 });
  else if (kind === "plastic") Object.assign(m, { roughness: 0.42, clearcoat: 0.3 });
  else if (kind === "glass") Object.assign(m, { roughness: 0.06, transparent: true, opacity: 0.22, depthWrite: false, clearcoat: 1 });
  else if (kind === "organic") Object.assign(m, { roughness: 0.55, clearcoat: 0.35, clearcoatRoughness: 0.4, sheen: 0.6, sheenColor: c.clone().offsetHSL(0, 0, 0.2) });
  else if (kind === "rock") Object.assign(m, { roughness: 0.92 });
  else if (kind === "water") Object.assign(m, { roughness: 0.1, transparent: true, opacity: 0.5, depthWrite: false, clearcoat: 1 });
  else if (kind === "wood") Object.assign(m, { roughness: 0.75 });
  else if (kind === "glow") Object.assign(m, { emissive: c, emissiveIntensity: 0.9, roughness: 0.6 });
  m.userData.base = { opacity: m.opacity, transparent: m.transparent, depthWrite: m.depthWrite, emissive: m.emissive.clone(), emissiveIntensity: m.emissiveIntensity };
  return m;
}

const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
};

// A cylinder from a to b.
function rod(a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material, sides = 14) {
  const d = b.clone().sub(a);
  const m = mesh(new THREE.CylinderGeometry(r, r, d.length(), sides), mat);
  m.position.copy(a).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  return m;
}

function arrowMesh(from: THREE.Vector3, to: THREE.Vector3, r: number, mat: THREE.Material) {
  const g = new THREE.Group();
  const d = to.clone().sub(from);
  const len = d.length();
  if (len < 1e-6) return g;
  const headL = Math.min(len * 0.3, r * 7);
  const shaftEnd = from.clone().addScaledVector(d.clone().normalize(), len - headL);
  g.add(rod(from, shaftEnd, r, mat));
  const cone = mesh(new THREE.ConeGeometry(r * 2.6, headL, 18), mat);
  cone.position.copy(shaftEnd).addScaledVector(d.clone().normalize(), headL / 2);
  cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  g.add(cone);
  return g;
}

function lineLoop(points: THREE.Vector3[], color: string, opacity = 1) {
  const geo = new THREE.BufferGeometry().setFromPoints(points);
  return new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
}

// ---------- building ----------
class Builder {
  root = new THREE.Group();
  parts: Part[] = [];
  views = [
    { id: "whole", label: "Whole" },
    { id: "exploded", label: "Explode" },
    { id: "xray", label: "X-ray" },
  ];
  cut: THREE.Plane[] | null = null;
  cutIntersect = false;
  animated = false;
  readout: string | null = null;
  movers: ((t: number, explode: number, view: string) => void)[] = [];

  part(id: string, label: string | null, obj: THREE.Object3D, out?: THREE.Vector3, at?: THREE.Vector3) {
    const g = obj instanceof THREE.Group ? obj : new THREE.Group().add(obj);
    g.name = id;
    this.root.add(g);
    const box = new THREE.Box3().setFromObject(g);
    const anchor = at ?? (box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3()));
    this.parts.push({ id, label, group: g, home: g.position.clone(), out: out ?? anchor.clone(), anchor });
    return g;
  }

  finish(): { radius: number } {
    const box = new THREE.Box3().setFromObject(this.root);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    // centre the model on the origin
    this.root.position.sub(sphere.center);
    for (const p of this.parts) {
      if (p.out.lengthSq() < 1e-9) p.out.set(0, 1, 0);
      p.out.sub(sphere.center).normalize();
    }
    return { radius: Math.max(sphere.radius, 1e-3) };
  }
}

export function buildModel(spec: Model3D): Built {
  const b = new Builder();
  if (spec.kind === "preset") buildPreset(b, spec);
  else if (spec.kind === "molecule") buildMolecule(b, spec);
  else if (spec.kind === "revolution") buildRevolution(b, spec);
  else if (spec.kind === "surface") buildSurface(b, spec);
  else if (spec.kind === "solid") buildSolid(b, spec);
  else if (spec.kind === "vectors") buildVectors(b, spec);
  else buildAssembly(b, spec);
  const { radius } = b.finish();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  scene.add(new THREE.HemisphereLight("#ffffff", "#d6d3cc", 0.9));
  const key = new THREE.DirectionalLight("#ffffff", 1.6);
  key.position.set(radius * 1.6, radius * 2.6, radius * 2.0);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  const sc = key.shadow.camera;
  sc.left = sc.bottom = -radius * 1.8;
  sc.right = sc.top = radius * 1.8;
  sc.near = radius * 0.1;
  sc.far = radius * 8;
  key.shadow.bias = -0.0005;
  scene.add(key);
  const rim = new THREE.DirectionalLight("#fff3e0", 0.5);
  rim.position.set(-radius * 2, radius, -radius * 2);
  scene.add(rim);
  // a soft shadow on the floor, under the model
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(radius * 8, radius * 8), new THREE.ShadowMaterial({ opacity: 0.12, polygonOffset: true, polygonOffsetFactor: -1 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -radius * 1.05;
  floor.receiveShadow = true;
  scene.add(floor);
  scene.add(b.root);

  const allMats = new Set<THREE.MeshPhysicalMaterial>();
  b.root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshPhysicalMaterial | undefined;
    if (m && "userData" in m && m.userData.base) allMats.add(m);
  });
  const partOf = new Map<THREE.Material, string>();
  for (const p of b.parts)
    p.group.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) partOf.set(m, p.id);
    });

  const apply = (view: string, focus: string | null) => {
    const cutting = view === "cutaway" && b.cut;
    for (const m of allMats) {
      const base = m.userData.base;
      const mine = focus != null && partOf.get(m) === focus;
      m.clippingPlanes = cutting && !mine ? b.cut : null;
      m.clipIntersection = b.cutIntersect;
      const faded = view === "xray" ? !mine : focus != null && !mine;
      m.transparent = base.transparent || faded;
      m.opacity = faded ? Math.min(base.opacity, view === "xray" ? 0.16 : 0.3) : base.opacity;
      m.depthWrite = faded ? false : base.depthWrite;
      m.emissive.copy(mine ? ACCENT : base.emissive);
      m.emissiveIntensity = mine ? 0.45 : base.emissiveIntensity;
      m.needsUpdate = true;
    }
  };

  return {
    scene,
    root: b.root,
    radius,
    parts: b.parts,
    views: b.views,
    animated: b.animated,
    get readout() {
      return b.readout;
    },
    update: (t, state, explode) => {
      for (const p of b.parts) p.group.position.copy(p.home).addScaledVector(p.out, explode * radius * 0.55);
      for (const mv of b.movers) mv(t, explode, state.view);
    },
    apply,
    dispose: () => {
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => x.dispose());
      });
    },
  } as Built;
}

// ---------- presets ----------
function buildPreset(b: Builder, spec: Extract<Model3D, { kind: "preset" }>) {
  const rng = seeded(7);
  if (spec.preset === "earth_layers") {
    // real radii in km, the crust drawn a little thick so it shows
    const R = 6371;
    const layers: [string, string, number, string, string][] = [
      ["inner_core", "Inner core · solid iron, 0–1,220 km", 1220, "#fde68a", "metal"],
      ["outer_core", "Outer core · liquid iron, to 3,480 km", 3480, "#f59e0b", "organic"],
      ["mantle", "Mantle · hot rock, to 6,336 km", 6300, "#dc6b2f", "rock"],
      ["crust", "Crust · 5–70 km", R, "#7c8b6f", "rock"],
    ];
    let inner = 0;
    layers.forEach(([id, text, r, color, kind], i) => {
      const g = mesh(new THREE.SphereGeometry(r / 1000, 72, 48), material(kind, color));
      // point at the middle of the layer's band on the cut face, fanned so the leaders don't stack
      const mid = (inner + r) / 2000;
      const a = 0.2 + i * 0.32;
      b.part(id, text, g, new THREE.Vector3(0.4, 0.6, 0.7), new THREE.Vector3(mid * Math.cos(a), mid * Math.sin(a), 0.01));
      inner = r;
    });
    // cut a wedge out so every layer shows
    b.cut = [new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0), new THREE.Plane(new THREE.Vector3(0, 0, -1), 0)];
    b.cutIntersect = true;
    b.views = [{ id: "cutaway", label: "Cut open" }, { id: "whole", label: "Whole" }, { id: "xray", label: "X-ray" }];
    return;
  }
  if (spec.preset === "atom") {
    const sym = spec.element?.trim() || "C";
    const Z = atomicNumber(sym);
    const shells = shellsOf(sym);
    const N = Math.round(Z <= 20 ? Z + (Z > 1 ? 0 : 0) : Z * 1.2);
    const nucleus = new THREE.Group();
    const protonMat = material("plastic", "#ef4444"), neutronMat = material("plastic", "#9ca3af");
    const total = Math.min(60, Z + N);
    const rN = 0.22 * Math.cbrt(total) + 0.12;
    const protons = new THREE.Group(), neutrons = new THREE.Group();
    for (let i = 0; i < total; i++) {
      // Fibonacci shells: packed, not random-looking
      const k = (i + 0.5) / total, phi = Math.acos(1 - 2 * k), th = Math.PI * (1 + Math.sqrt(5)) * i;
      const rr = rN * Math.cbrt(k) * 1.1;
      const s = mesh(new THREE.SphereGeometry(0.16, 20, 14), i % 2 === 0 && protons.children.length < Z ? protonMat : neutrons.children.length < N ? neutronMat : protonMat);
      s.position.set(rr * Math.sin(phi) * Math.cos(th), rr * Math.cos(phi), rr * Math.sin(phi) * Math.sin(th));
      (s.material === protonMat ? protons : neutrons).add(s);
    }
    nucleus.add(protons, neutrons);
    b.part("nucleus", `Nucleus · ${Z} protons, ${N} neutrons`, nucleus, new THREE.Vector3(0, 0, 0));
    const ringMat = material("glass", "#64748b");
    ringMat.opacity = 0.35;
    const eMat = material("glow", "#2563eb");
    const electrons: { m: THREE.Mesh; r: number; a0: number; tilt: number; speed: number }[] = [];
    const eGroup = new THREE.Group();
    shells.forEach((count, si) => {
      const r = 1.1 + si * 0.85;
      const tilt = si * 0.5;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.012, 8, 120), ringMat);
      ring.rotation.x = Math.PI / 2 + tilt * 0.25;
      b.part(`shell_${si + 1}`, `Shell ${si + 1} · ${count} electron${count === 1 ? "" : "s"}`, ring, new THREE.Vector3(0, 0, 0));
      for (let k = 0; k < count; k++) {
        const m = mesh(new THREE.SphereGeometry(0.09, 16, 12), eMat);
        electrons.push({ m, r, a0: (k / count) * Math.PI * 2, tilt: tilt * 0.25, speed: 0.9 / (si + 1) });
        eGroup.add(m);
      }
    });
    b.part("electrons", `${Z} electrons`, eGroup, new THREE.Vector3(0, 0, 0));
    b.animated = true;
    b.views = [{ id: "whole", label: "Whole" }, { id: "xray", label: "X-ray" }];
    b.movers.push((t) => {
      for (const e of electrons) {
        const a = e.a0 + t * e.speed;
        e.m.position.set(Math.cos(a) * e.r, Math.sin(a) * e.r * Math.sin(e.tilt), Math.sin(a) * e.r * Math.cos(e.tilt));
      }
    });
    b.readout = `${sym} · ${shells.join(", ")}`;
    return;
  }
  if (spec.preset === "dna") {
    const seq = "ATGCGTACGTTAGCCATGCA";
    const pairs: Record<string, string> = { A: "T", T: "A", G: "C", C: "G" };
    const colors: Record<string, string> = { A: "#ef4444", T: "#eab308", G: "#22c55e", C: "#3b82f6" };
    const R = 1.0, rise = 0.34, twist = (36 * Math.PI) / 180, minor = (140 * Math.PI) / 180;
    const strand = (off: number) => {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= seq.length * 4; i++) {
        const k = i / 4;
        pts.push(new THREE.Vector3(Math.cos(k * twist + off) * R, k * rise, Math.sin(k * twist + off) * R));
      }
      return new THREE.CatmullRomCurve3(pts);
    };
    const backMat = material("plastic", "#64748b");
    const back = new THREE.Group();
    back.add(mesh(new THREE.TubeGeometry(strand(0), 240, 0.11, 10), backMat), mesh(new THREE.TubeGeometry(strand(minor), 240, 0.11, 10), backMat));
    b.part("backbone", "Sugar-phosphate backbone", back, new THREE.Vector3(1, 0, 0));
    const groups: Record<string, THREE.Group> = { A: new THREE.Group(), T: new THREE.Group(), G: new THREE.Group(), C: new THREE.Group() };
    [...seq].forEach((base, i) => {
      const a = new THREE.Vector3(Math.cos(i * twist) * R, i * rise, Math.sin(i * twist) * R);
      const c = new THREE.Vector3(Math.cos(i * twist + minor) * R, i * rise, Math.sin(i * twist + minor) * R);
      const mid = a.clone().lerp(c, 0.5);
      groups[base].add(rod(a, mid, 0.07, material("plastic", colors[base])));
      groups[pairs[base]].add(rod(mid, c, 0.07, material("plastic", colors[pairs[base]])));
    });
    const bp = new THREE.Group();
    const names: Record<string, string> = { A: "adenine", T: "thymine", G: "guanine", C: "cytosine" };
    for (const k of ["A", "T", "G", "C"]) bp.add(groups[k]);
    b.part("base_pairs", "Base pairs · A–T, G–C", bp, new THREE.Vector3(-1, 0, 0));
    // the four bases can be pointed at one by one, inside base_pairs
    for (const k of ["A", "T", "G", "C"]) {
      const box = new THREE.Box3().setFromObject(groups[k]);
      b.parts.push({ id: names[k], label: null, group: groups[k], home: groups[k].position.clone(), out: new THREE.Vector3(), anchor: box.getCenter(new THREE.Vector3()) });
    }
    b.root.rotation.z = 0.25;
    b.views = [{ id: "whole", label: "Whole" }, { id: "exploded", label: "Unzip" }, { id: "xray", label: "X-ray" }];
    return;
  }
  if (spec.preset === "animal_cell" || spec.preset === "plant_cell") {
    const plant = spec.preset === "plant_cell";
    const place = (r0: number, r1: number) => {
      const u = rng() * 2 - 1, th = rng() * Math.PI * 2, r = r0 + (r1 - r0) * Math.cbrt(rng());
      const s = Math.sqrt(1 - u * u);
      return new THREE.Vector3(s * Math.cos(th) * r, u * r * (plant ? 0.7 : 0.8), s * Math.sin(th) * r);
    };
    if (plant) {
      const wall = mesh(new THREE.BoxGeometry(17, 11, 11, 1, 1, 1), material("glass", "#4d7c0f"));
      (wall.material as THREE.MeshPhysicalMaterial).opacity = 0.28;
      (wall.material as THREE.MeshPhysicalMaterial).userData.base.opacity = 0.28;
      b.part("cell_wall", "Cell wall · cellulose", wall, new THREE.Vector3(0, 1, 1));
      const mem = mesh(new THREE.BoxGeometry(16.2, 10.2, 10.2), material("glass", "#86efac"));
      b.part("cell_membrane", "Cell membrane", mem, new THREE.Vector3(0, 1, 0.5));
      const vac = mesh(new THREE.SphereGeometry(1, 48, 32), material("water", "#7dd3fc"));
      vac.scale.set(5.2, 3.8, 3.8);
      vac.position.set(1.2, 0, 0);
      b.part("vacuole", "Central vacuole · water store", vac, new THREE.Vector3(1, 0, 0));
      const nuc = mesh(new THREE.SphereGeometry(1.7, 40, 28), material("organic", "#7c3aed"));
      nuc.position.set(-5.4, 1.4, 1.5);
      b.part("nucleus", "Nucleus · DNA", nuc, new THREE.Vector3(-1, 0.5, 0.5));
      const chl = new THREE.Group();
      for (let i = 0; i < 12; i++) {
        const c = mesh(new THREE.SphereGeometry(1, 24, 16), material("organic", "#16a34a"));
        c.scale.set(1.0, 0.45, 0.6);
        const a = (i / 12) * Math.PI * 2;
        c.position.set(Math.cos(a) * 6.8, Math.sin(a * 2) * 2.5, Math.sin(a) * 4.2);
        c.rotation.set(rng() * 3, rng() * 3, rng() * 3);
        chl.add(c);
      }
      b.part("chloroplasts", "Chloroplasts · photosynthesis", chl, new THREE.Vector3(0, 0, 1));
      const mito = new THREE.Group();
      for (let i = 0; i < 4; i++) {
        const m = mesh(new THREE.CapsuleGeometry(0.4, 1.1, 8, 16), material("organic", "#f97316"));
        m.position.set(-3 + i * 1.5, -3.2, (i % 2 ? 1 : -1) * 3.4);
        m.rotation.set(rng() * 3, rng() * 3, rng() * 3);
        mito.add(m);
      }
      b.part("mitochondria", "Mitochondria · respiration", mito, new THREE.Vector3(0, -1, 0));
    } else {
      const mem = mesh(new THREE.SphereGeometry(10, 72, 48), material("organic", "#fbcfe8"));
      mem.scale.set(1, 0.78, 0.92);
      (mem.material as THREE.MeshPhysicalMaterial).transparent = true;
      (mem.material as THREE.MeshPhysicalMaterial).opacity = 0.42;
      (mem.material as THREE.MeshPhysicalMaterial).depthWrite = false;
      Object.assign((mem.material as THREE.MeshPhysicalMaterial).userData.base, { transparent: true, opacity: 0.42, depthWrite: false });
      b.part("cell_membrane", "Cell membrane", mem, new THREE.Vector3(0, 1, 1));
      const nuc = mesh(new THREE.SphereGeometry(3.1, 48, 32), material("organic", "#7c3aed"));
      b.part("nucleus", "Nucleus · DNA", nuc, new THREE.Vector3(0, 0.3, 1));
      const nucleolus = mesh(new THREE.SphereGeometry(1.05, 28, 20), material("organic", "#3b0764"));
      nucleolus.position.set(0.9, 0.6, 1.2);
      b.part("nucleolus", "Nucleolus · makes ribosomes", nucleolus, new THREE.Vector3(0.6, 0.6, 1));
      const er = new THREE.Group();
      for (let i = 0; i < 5; i++) {
        const t = mesh(new THREE.TorusGeometry(3.9 + i * 0.55, 0.16, 10, 60, Math.PI * (0.7 + rng() * 0.5)), material("organic", "#60a5fa"));
        t.rotation.set(Math.PI / 2 + (rng() - 0.5) * 0.5, rng() * 6, rng() * 0.5);
        er.add(t);
      }
      b.part("rough_er", "Rough ER · makes proteins", er, new THREE.Vector3(-1, 0.2, 0));
      const golgi = new THREE.Group();
      for (let i = 0; i < 5; i++) {
        const t = mesh(new THREE.TorusGeometry(1.8 - i * 0.12, 0.17, 10, 40, Math.PI * 0.8), material("organic", "#facc15"));
        t.position.set(5.8, -1 + i * 0.42, 1.5);
        t.rotation.set(Math.PI / 2, 0, 0.3);
        golgi.add(t);
      }
      b.part("golgi", "Golgi apparatus · packages proteins", golgi, new THREE.Vector3(1, 0, 0.3));
      const mito = new THREE.Group();
      for (let i = 0; i < 7; i++) {
        const m = mesh(new THREE.CapsuleGeometry(0.5, 1.5, 8, 16), material("organic", "#f97316"));
        m.position.copy(place(4.8, 7.6));
        m.rotation.set(rng() * 3, rng() * 3, rng() * 3);
        mito.add(m);
      }
      b.part("mitochondria", "Mitochondria · release energy", mito, new THREE.Vector3(0, -1, 0.2));
      const lyso = new THREE.Group();
      for (let i = 0; i < 5; i++) {
        const m = mesh(new THREE.SphereGeometry(0.45, 18, 12), material("organic", "#22c55e"));
        m.position.copy(place(5, 7.8));
        lyso.add(m);
      }
      b.part("lysosomes", "Lysosomes · break down waste", lyso, new THREE.Vector3(0, 1, -0.5));
      const ribo = new THREE.InstancedMesh(new THREE.SphereGeometry(0.11, 8, 6), material("plastic", "#1e293b"), 220);
      const mat4 = new THREE.Matrix4();
      for (let i = 0; i < 220; i++) ribo.setMatrixAt(i, mat4.makeTranslation(place(3.6, 8.6)));
      b.part("ribosomes", "Ribosomes · build proteins", ribo, new THREE.Vector3(-1, -1, 0));
    }
    b.cut = [new THREE.Plane(new THREE.Vector3(0, 0, -1), 0)];
    b.views = [{ id: "cutaway", label: "Cut open" }, { id: "whole", label: "Whole" }, { id: "exploded", label: "Explode" }, { id: "xray", label: "X-ray" }];
    return;
  }
  if (spec.preset === "solar_system") {
    const planets: [string, string, number, number, number, string][] = [
      // id, label, radius (drawn), orbit (drawn), period in years, colour
      ["mercury", "Mercury · 88 days", 0.18, 2.2, 0.241, "#a8a29e"],
      ["venus", "Venus · 225 days", 0.3, 3.0, 0.615, "#fbbf24"],
      ["earth", "Earth · 1 year", 0.32, 3.9, 1, "#3b82f6"],
      ["mars", "Mars · 1.9 years", 0.24, 4.8, 1.881, "#dc2626"],
      ["jupiter", "Jupiter · 12 years", 0.8, 6.6, 11.86, "#d6a26d"],
      ["saturn", "Saturn · 29 years", 0.68, 8.4, 29.46, "#e8d18f"],
      ["uranus", "Uranus · 84 years", 0.48, 10.0, 84.0, "#67e8f9"],
      ["neptune", "Neptune · 165 years", 0.46, 11.4, 164.8, "#3b5bdb"],
    ];
    const sun = mesh(new THREE.SphereGeometry(1.2, 48, 32), material("glow", "#fbbf24"));
    b.part("sun", "Sun", sun, new THREE.Vector3(0, 1, 0));
    const movers: { g: THREE.Object3D; r: number; period: number; a0: number }[] = [];
    for (const [id, text, r, orbit, period, color] of planets) {
      const g = new THREE.Group();
      g.add(mesh(new THREE.SphereGeometry(r, 32, 22), material("rock", color)));
      if (id === "saturn") {
        const ring = mesh(new THREE.RingGeometry(r * 1.3, r * 2.1, 64), material("plastic", "#d6c28f"));
        ring.rotation.x = Math.PI / 2.4;
        g.add(ring);
      }
      const a0 = rng() * Math.PI * 2;
      g.position.set(Math.cos(a0) * orbit, 0, Math.sin(a0) * orbit);
      b.part(id, text, g, new THREE.Vector3(0, 1, 0));
      movers.push({ g, r: orbit, period, a0 });
      const pts = Array.from({ length: 129 }, (_, i) => new THREE.Vector3(Math.cos((i / 128) * Math.PI * 2) * orbit, 0, Math.sin((i / 128) * Math.PI * 2) * orbit));
      b.root.add(lineLoop(pts, "#94a3b8", 0.6));
    }
    b.animated = true;
    b.views = [{ id: "whole", label: "Whole" }, { id: "xray", label: "Focus" }];
    // one year of Earth's orbit every 6 seconds
    b.movers.push((t) => {
      for (const m of movers) {
        const a = m.a0 - (t / 6) * ((Math.PI * 2) / m.period);
        m.g.position.set(Math.cos(a) * m.r, 0, Math.sin(a) * m.r);
      }
      b.readout = `${(t / 6).toFixed(1)} Earth years`;
    });
    return;
  }
  // piston_engine: a single cylinder, four strokes, posed from the crank angle alone
  const bore = 0.86, rCrank = 0.43, rodL = 1.43;
  const steel = material("metal", "#9ca3af"), dark = material("metal", "#52525b"), alloy = material("metal", "#d4d4d8");
  const glass = material("glass", "#93c5fd");
  const cyl = mesh(new THREE.CylinderGeometry(bore / 2 + 0.06, bore / 2 + 0.06, 1.6, 48, 1, true), glass);
  cyl.position.y = rodL + 0.5;
  const head = mesh(new THREE.CylinderGeometry(bore / 2 + 0.12, bore / 2 + 0.12, 0.18, 48), dark);
  head.position.y = rodL + 1.38;
  const cylG = new THREE.Group().add(cyl, head);
  b.part("cylinder", "Cylinder · bore 86 mm", cylG, new THREE.Vector3(0, 1, 0));
  const piston = new THREE.Group();
  piston.add(mesh(new THREE.CylinderGeometry(bore / 2, bore / 2, 0.42, 40), alloy));
  for (const y of [0.12, 0.05]) {
    const ring = mesh(new THREE.TorusGeometry(bore / 2, 0.012, 8, 48), dark);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = y;
    piston.add(ring);
  }
  const pistonG = b.part("piston", "Piston", piston, new THREE.Vector3(0, 1, 0));
  const rodG = new THREE.Group();
  const rodMesh = mesh(new THREE.BoxGeometry(0.12, rodL, 0.08), steel);
  rodG.add(rodMesh);
  const conRod = b.part("connecting_rod", "Connecting rod · 143 mm", rodG, new THREE.Vector3(1, 0, 0));
  const crank = new THREE.Group();
  const web = mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.12, 40), dark);
  web.rotation.x = Math.PI / 2;
  const shaft = mesh(new THREE.CylinderGeometry(0.1, 0.1, 1.0, 20), steel);
  shaft.rotation.x = Math.PI / 2;
  const pin = mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.3, 16), steel);
  pin.rotation.x = Math.PI / 2;
  crank.add(web, shaft, pin);
  const crankG = b.part("crankshaft", "Crankshaft · stroke 86 mm", crank, new THREE.Vector3(0, -1, 0));
  const plug = mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.4, 12), material("plastic", "#f5f5f4"));
  plug.position.y = rodL + 1.6;
  b.part("spark_plug", "Spark plug", plug, new THREE.Vector3(0, 1, 0));
  const valve = (x: number, id: string, text: string, color: string) => {
    const v = new THREE.Group();
    v.add(mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.55, 10), steel));
    const disc = mesh(new THREE.CylinderGeometry(0.13, 0.1, 0.04, 24), material("metal", color));
    disc.position.y = -0.27;
    v.add(disc);
    v.position.set(x, rodL + 1.5, 0);
    return b.part(id, text, v, new THREE.Vector3(Math.sign(x), 1, 0));
  };
  const inV = valve(-0.2, "intake_valve", "Intake valve", "#60a5fa");
  const exV = valve(0.2, "exhaust_valve", "Exhaust valve", "#f87171");
  const flash = mesh(new THREE.SphereGeometry(0.3, 20, 14), material("glow", "#fb923c"));
  flash.position.y = rodL + 1.15;
  b.root.add(flash);
  const homes = new Map(b.parts.map((p) => [p.id, p.home.clone()]));
  b.animated = true;
  b.views = [{ id: "whole", label: "Whole" }, { id: "exploded", label: "Explode" }, { id: "xray", label: "X-ray" }];
  const strokes = ["Intake", "Compression", "Power", "Exhaust"];
  b.movers.push((t, explode) => {
    const theta = t * 2.2; // crank angle, radians
    const cyc = ((theta % (Math.PI * 4)) + Math.PI * 4) % (Math.PI * 4); // 720° cycle
    const pinX = rCrank * Math.sin(theta), pinY = rCrank * Math.cos(theta);
    const pistonY = pinY + Math.sqrt(rodL * rodL - pinX * pinX);
    const off = (id: string) => homes.get(id)!.clone().addScaledVector(b.parts.find((p) => p.id === id)!.out, explode * 1.6);
    crankG.position.copy(off("crankshaft"));
    crankG.rotation.z = -theta;
    pin.position.set(0, rCrank, 0.12);
    pistonG.position.copy(off("piston")).add(new THREE.Vector3(0, pistonY, 0));
    conRod.position.copy(off("connecting_rod")).add(new THREE.Vector3(pinX / 2, (pinY + pistonY) / 2, 0.06));
    conRod.rotation.z = Math.atan2(pinX, pistonY - pinY);
    const stroke = Math.floor(cyc / Math.PI);
    const within = (cyc % Math.PI) / Math.PI;
    const lift = (s: number) => (stroke === s ? Math.sin(within * Math.PI) * 0.12 : 0);
    inV.position.copy(off("intake_valve")).add(new THREE.Vector3(0, -lift(0), 0));
    exV.position.copy(off("exhaust_valve")).add(new THREE.Vector3(0, -lift(3), 0));
    flash.visible = stroke === 2 && within < 0.25 && explode < 0.05;
    flash.scale.setScalar(1 + within * 2);
    b.readout = `${strokes[stroke]} stroke · crank ${Math.round(((theta * 180) / Math.PI) % 360)}°`;
  });
}

// ---------- molecules ----------
function buildMolecule(b: Builder, spec: Extract<Model3D, { kind: "molecule" }>) {
  const data = spec.molecule ? moleculeData(spec.molecule) : vsepr(spec.center ?? "C", spec.ligands, spec.lone_pairs);
  const g = new THREE.Group();
  const v = (p: [number, number, number]) => new THREE.Vector3(...p);
  data.atoms.forEach((a) => {
    const st = ATOM_STYLE[a.el] ?? { color: "#a1a1aa", r: 0.45 };
    const m = mesh(new THREE.SphereGeometry(st.r, 40, 28), material("plastic", st.color));
    m.position.copy(v(a.p));
    g.add(m);
  });
  const bondMat = material("plastic", "#d4d4d8");
  for (const bd of data.bonds) {
    const A = v(data.atoms[bd.a].p), B = v(data.atoms[bd.b].p);
    if (bd.order === 0) {
      g.add(rod(A, B, 0.04, material("plastic", "#cbd5e1")));
      continue;
    }
    const side = B.clone().sub(A).cross(new THREE.Vector3(0, 0, 1));
    if (side.lengthSq() < 1e-6) side.set(0, 1, 0);
    side.normalize().multiplyScalar(0.13);
    const offs = bd.order === 1 ? [0] : bd.order === 2 ? [-0.5, 0.5] : [-1, 0, 1];
    for (const o of offs) g.add(rod(A.clone().addScaledVector(side, o), B.clone().addScaledVector(side, o), bd.order === 1 ? 0.09 : 0.06, bondMat));
  }
  for (const l of data.lone ?? []) {
    const lobe = mesh(new THREE.SphereGeometry(0.32, 24, 16), material("glass", "#a78bfa"));
    (lobe.material as THREE.MeshPhysicalMaterial).opacity = 0.35;
    (lobe.material as THREE.MeshPhysicalMaterial).userData.base.opacity = 0.35;
    lobe.scale.set(0.7, 1.3, 0.7);
    lobe.position.copy(v(l));
    lobe.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v(l).normalize());
    g.add(lobe);
  }
  const name = spec.molecule?.replace(/_/g, " ") ?? `${spec.center}${spec.ligands.length > 1 ? `${spec.ligands[0]}${spec.ligands.length}` : spec.ligands[0] ?? ""}`;
  b.part("molecule", spec.title ?? name, g, new THREE.Vector3(0, 1, 0));
  b.views = [{ id: "whole", label: "Ball and stick" }, { id: "xray", label: "X-ray" }];
}

// ---------- calculus ----------
function buildRevolution(b: Builder, spec: Extract<Model3D, { kind: "revolution" }>) {
  let f: (x: number) => number, g: ((x: number) => number) | null = null;
  try {
    f = compile(spec.formula.replace(/^\s*y\s*=/i, ""));
    if (spec.inner) g = compile(spec.inner.replace(/^\s*y\s*=/i, ""));
  } catch {
    f = (x) => Math.sqrt(Math.max(0, x));
  }
  const { from: a, to: c } = spec;
  const n = 80;
  const xs = Array.from({ length: n + 1 }, (_, i) => a + ((c - a) * i) / n);
  const safe = (h: (x: number) => number, x: number) => {
    const v = h(x);
    return Number.isFinite(v) ? Math.abs(v) : 0;
  };
  const scale = 4 / Math.max(c - a, ...xs.map((x) => safe(f, x)), 1e-3);
  const solidMat = material("glass", "#60a5fa");
  solidMat.opacity = 0.55;
  solidMat.userData.base.opacity = 0.55;
  const sweep = { angle: Math.PI * 2 };
  const solid = new THREE.Group();
  const rebuild = (angle: number) => {
    solid.clear();
    const lathe = (h: (x: number) => number) => {
      // LatheGeometry turns (r, y) about the y-axis
      const pts = spec.axis === "x" ? xs.map((x) => new THREE.Vector2(safe(h, x) * scale, (x - a) * scale)) : xs.map((x) => new THREE.Vector2(Math.abs(x) * scale, safe(h, x) * scale));
      return mesh(new THREE.LatheGeometry(pts, 96, 0, Math.max(0.01, angle)), solidMat);
    };
    const outer = lathe(f);
    solid.add(outer);
    if (g) solid.add(lathe(g));
    if (spec.axis === "x") solid.rotation.z = -Math.PI / 2;
  };
  rebuild(sweep.angle);
  b.part("solid", `Solid · about the ${spec.axis}-axis`, solid, new THREE.Vector3(0, 1, 0));
  // the region being turned, drawn flat, and the axis
  const curve = new THREE.Group();
  const toWorld = (x: number, y: number) => (spec.axis === "x" ? new THREE.Vector3((x - a) * scale, y * scale, 0) : new THREE.Vector3(x * scale, y * scale, 0));
  curve.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(xs.map((x) => toWorld(x, safe(f, x)))), new THREE.LineBasicMaterial({ color: "#c2410c" })));
  if (g) curve.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(xs.map((x) => toWorld(x, safe(g!, x)))), new THREE.LineBasicMaterial({ color: "#c2410c" })));
  b.part("curve", `y = ${spec.formula}${spec.inner ? `, y = ${spec.inner}` : ""}`, curve, new THREE.Vector3(0, 0, 1));
  const axisLen = 6;
  const axis = spec.axis === "x" ? arrowMesh(new THREE.Vector3(-0.8, 0, 0), new THREE.Vector3(axisLen, 0, 0), 0.025, material("plastic", "#334155")) : arrowMesh(new THREE.Vector3(0, -0.8, 0), new THREE.Vector3(0, axisLen, 0), 0.025, material("plastic", "#334155"));
  b.part("axis", `${spec.axis}-axis`, axis, new THREE.Vector3(0, 0, 0));
  // slices: disks (or washers) across the axis, or shells round it
  const slices = new THREE.Group();
  const sliceMat = material("plastic", "#f97316");
  const k = 8;
  for (let i = 0; i < k; i++) {
    const x = a + ((c - a) * (i + 0.5)) / k;
    const dx = ((c - a) / k) * scale * 0.7;
    if (spec.axis === "x") {
      const R = safe(f, x) * scale, r = g ? safe(g, x) * scale : 0;
      const ring = mesh(r > 0 ? new THREE.CylinderGeometry(R, R, dx, 48, 1, true) : new THREE.CylinderGeometry(R, R, dx, 48), sliceMat);
      ring.rotation.z = Math.PI / 2;
      ring.position.set((x - a) * scale, 0, 0);
      slices.add(ring);
      if (r > 0) {
        const hole = mesh(new THREE.RingGeometry(r, R, 48), sliceMat);
        hole.rotation.y = Math.PI / 2;
        hole.position.set((x - a) * scale - dx / 2, 0, 0);
        slices.add(hole);
      }
    } else {
      const h = safe(f, x) * scale;
      const shell = mesh(new THREE.CylinderGeometry(Math.abs(x) * scale, Math.abs(x) * scale, h, 64, 1, true), sliceMat);
      shell.position.y = h / 2;
      slices.add(shell);
    }
  }
  slices.visible = false;
  b.root.add(slices);
  b.views = [
    { id: "whole", label: "Solid" },
    { id: "sweep", label: "Sweep" },
    { id: "slices", label: spec.axis === "x" ? (g ? "Washers" : "Disks") : "Shells" },
    { id: "xray", label: "Region" },
  ];
  b.animated = true;
  let last = -1;
  b.movers.push((t, _e, view) => {
    slices.visible = view === "slices";
    solid.visible = view !== "slices";
    const angle = view === "sweep" ? Math.min(Math.PI * 2, ((t % 6) / 4.5) * Math.PI * 2) : Math.PI * 2;
    if (Math.abs(angle - last) > 0.02) {
      rebuild(angle);
      last = angle;
    }
    b.readout = view === "sweep" ? `turned ${Math.round((angle * 180) / Math.PI)}°` : null;
  });
}

function buildSurface(b: Builder, spec: Extract<Model3D, { kind: "surface" }>) {
  const f = compileXY(spec.formula) ?? ((x: number, y: number) => x * x - y * y);
  const n = 64;
  const { x_min: x0, x_max: x1, y_min: y0, y_max: y1 } = spec;
  const vals: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) vals.push(f(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * j) / n));
  const finite = vals.filter(Number.isFinite).sort((p, q) => p - q);
  const lo = finite[Math.floor(finite.length * 0.02)] ?? -1, hi = finite[Math.floor(finite.length * 0.98)] ?? 1;
  const span = Math.max(x1 - x0, y1 - y0);
  const sxy = 6 / span, sz = 3.5 / Math.max(hi - lo, 1e-6);
  const geo = new THREE.PlaneGeometry(1, 1, n, n);
  const pos = geo.attributes.position;
  const colors: number[] = [];
  const low = new THREE.Color("#2563eb"), high = new THREE.Color("#f97316");
  for (let k = 0; k < pos.count; k++) {
    const i = k % (n + 1), j = Math.floor(k / (n + 1));
    const x = x0 + ((x1 - x0) * i) / n, y = y0 + ((y1 - y0) * j) / n;
    const z = Math.max(lo, Math.min(hi, Number.isFinite(vals[k]) ? vals[k] : 0));
    // math's (x, y, z) to three's (x, z up, -y)
    pos.setXYZ(k, (x - (x0 + x1) / 2) * sxy, (z - (lo + hi) / 2) * sz, -(y - (y0 + y1) / 2) * sxy);
    const c = low.clone().lerp(high, (z - lo) / Math.max(hi - lo, 1e-6));
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mat = material("plastic", "#ffffff");
  mat.vertexColors = true;
  const surf = mesh(geo, mat);
  const wire = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.PlaneGeometry(1, 1, 16, 16)), new THREE.LineBasicMaterial({ color: "#1f2937", transparent: true, opacity: 0.12 }));
  // a coarse grid that follows the surface
  const wpos = wire.geometry.attributes.position;
  for (let k = 0; k < wpos.count; k++) {
    const u = wpos.getX(k) + 0.5, v = wpos.getY(k) + 0.5;
    const x = x0 + (x1 - x0) * u, y = y0 + (y1 - y0) * v;
    const zr = f(x, y);
    const z = Math.max(lo, Math.min(hi, Number.isFinite(zr) ? zr : 0));
    wpos.setXYZ(k, (x - (x0 + x1) / 2) * sxy, (z - (lo + hi) / 2) * sz + 0.01, -(y - (y0 + y1) / 2) * sxy);
  }
  const sg = new THREE.Group().add(surf, wire);
  b.part("surface", `z = ${spec.formula}`, sg, new THREE.Vector3(0, 1, 0));
  if (spec.point && spec.point.length >= 2) {
    const [px, py] = spec.point;
    const pz = f(px, py);
    if (Number.isFinite(pz)) {
      const P = new THREE.Vector3((px - (x0 + x1) / 2) * sxy, (Math.max(lo, Math.min(hi, pz)) - (lo + hi) / 2) * sz, -(py - (y0 + y1) / 2) * sxy);
      const h = 1e-3 * span;
      const fx = (f(px + h, py) - f(px - h, py)) / (2 * h), fy = (f(px, py + h) - f(px, py - h)) / (2 * h);
      const pg = new THREE.Group();
      const dot = mesh(new THREE.SphereGeometry(0.12, 20, 14), material("plastic", "#111827"));
      dot.position.copy(P);
      pg.add(dot);
      // tangent plane through it
      const plane = new THREE.PlaneGeometry(2.4, 2.4, 1, 1);
      const pp = plane.attributes.position;
      for (let k = 0; k < pp.count; k++) {
        const u = pp.getX(k) / sxy, v = pp.getY(k) / sxy;
        pp.setXYZ(k, P.x + u * sxy, P.y + (fx * u + fy * v) * sz, P.z - v * sxy);
      }
      plane.computeVertexNormals();
      pg.add(mesh(plane, material("glass", "#a855f7")));
      b.part("point", `(${px}, ${py}, ${Math.round(pz * 100) / 100})`, pg, new THREE.Vector3(0, 1, 0));
    }
  }
  axes(b, 3.6, ["x", "z", "y"]);
  b.views = [{ id: "whole", label: "Surface" }, { id: "xray", label: "See through" }];
}

function axes(b: Builder, len: number, names: [string, string, string] | string[]) {
  const mat = material("plastic", "#475569");
  const g = new THREE.Group();
  g.add(arrowMesh(new THREE.Vector3(-len, 0, 0), new THREE.Vector3(len, 0, 0), 0.02, mat));
  g.add(arrowMesh(new THREE.Vector3(0, -len * 0.6, 0), new THREE.Vector3(0, len, 0), 0.02, mat));
  g.add(arrowMesh(new THREE.Vector3(0, 0, len), new THREE.Vector3(0, 0, -len), 0.02, mat));
  b.root.add(g);
  b.parts.push({ id: `axis_${names[0]}`, label: names[0], group: new THREE.Group(), home: new THREE.Vector3(), out: new THREE.Vector3(), anchor: new THREE.Vector3(len * 1.05, 0, 0) });
  b.parts.push({ id: `axis_${names[1]}`, label: names[1], group: new THREE.Group(), home: new THREE.Vector3(), out: new THREE.Vector3(), anchor: new THREE.Vector3(0, len * 1.05, 0) });
  b.parts.push({ id: `axis_${names[2]}`, label: names[2], group: new THREE.Group(), home: new THREE.Vector3(), out: new THREE.Vector3(), anchor: new THREE.Vector3(0, 0, -len * 1.05) });
}

// ---------- geometry ----------
function buildSolid(b: Builder, spec: Extract<Model3D, { kind: "solid" }>) {
  const [p = 1, q = p, r = p] = spec.dims;
  let geo: THREE.BufferGeometry;
  const dims: string[] = [];
  switch (spec.solid) {
    case "cube":
      geo = new THREE.BoxGeometry(p, p, p);
      dims.push(`side ${p}`);
      break;
    case "cuboid":
      geo = new THREE.BoxGeometry(p, r, q);
      dims.push(`${p} × ${q} × ${r}`);
      break;
    case "cylinder":
      geo = new THREE.CylinderGeometry(p, p, q, 64);
      dims.push(`r = ${p}`, `h = ${q}`);
      break;
    case "cone":
      geo = new THREE.ConeGeometry(p, q, 64);
      dims.push(`r = ${p}`, `h = ${q}`);
      break;
    case "sphere":
      geo = new THREE.SphereGeometry(p, 64, 40);
      dims.push(`r = ${p}`);
      break;
    case "hemisphere":
      geo = new THREE.SphereGeometry(p, 64, 32, 0, Math.PI * 2, 0, Math.PI / 2);
      dims.push(`r = ${p}`);
      break;
    case "square_pyramid":
      geo = new THREE.ConeGeometry(p / Math.SQRT2, q, 4, 1);
      geo.rotateY(Math.PI / 4);
      dims.push(`base ${p}`, `h = ${q}`);
      break;
    case "triangular_prism":
      geo = new THREE.CylinderGeometry(p / Math.sqrt(3), p / Math.sqrt(3), q, 3, 1);
      geo.rotateZ(Math.PI / 2);
      dims.push(`side ${p}`, `length ${q}`);
      break;
    case "tetrahedron":
      geo = new THREE.TetrahedronGeometry((p * Math.sqrt(6)) / 4);
      dims.push(`edge ${p}`);
      break;
    case "frustum":
      geo = new THREE.CylinderGeometry(q, p, r, 64);
      dims.push(`R = ${p}`, `r = ${q}`, `h = ${r}`);
      break;
  }
  const g = new THREE.Group();
  g.add(mesh(geo, material("plastic", "#93c5fd")));
  g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), new THREE.LineBasicMaterial({ color: "#1e3a8a" })));
  b.part("solid", spec.show_dims ? dims.join(", ") : spec.title ?? spec.solid.replace(/_/g, " "), g, new THREE.Vector3(0, 1, 0));
  // a horizontal cut through the middle shows the cross-section
  b.cut = [new THREE.Plane(new THREE.Vector3(0, -1, 0), 0)];
  b.views = [{ id: "whole", label: "Whole" }, { id: "cutaway", label: "Cross-section" }, { id: "xray", label: "X-ray" }];
}

function buildVectors(b: Builder, spec: Extract<Model3D, { kind: "vectors" }>) {
  const palette = ["#dc2626", "#2563eb", "#16a34a", "#9333ea", "#ea580c", "#0891b2"];
  const all = spec.vectors.flatMap((v) => [...v.to, ...(v.from ?? [])].map(Math.abs));
  const s = 3.2 / Math.max(1, ...all);
  // math's (x, y, z) shown with z up
  const w = (p: number[]) => new THREE.Vector3(p[0] * s, p[2] * s, -p[1] * s);
  spec.vectors.forEach((v, i) => {
    const from = w(v.from ?? [0, 0, 0]), to = w(v.to);
    const g = arrowMesh(from, to, 0.04, material("plastic", palette[i % palette.length]));
    b.part(v.label ?? `v${i + 1}`, `${v.label ?? `v${i + 1}`} = (${v.to.join(", ")})`, g, to.clone().sub(from));
    b.parts.at(-1)!.anchor = to.clone();
  });
  if (spec.plane && spec.vectors.length >= 2) {
    const A = w(spec.vectors[0].to), B = w(spec.vectors[1].to);
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), A, A.clone().add(B), new THREE.Vector3(), A.clone().add(B), B]);
    geo.computeVertexNormals();
    const m = material("glass", "#facc15");
    m.opacity = 0.35;
    m.userData.base.opacity = 0.35;
    b.root.add(mesh(geo, m));
  }
  axes(b, 3.6, ["x", "z", "y"]);
  b.views = [{ id: "whole", label: "Whole" }, { id: "xray", label: "Isolate" }];
}

function buildAssembly(b: Builder, spec: Extract<Model3D, { kind: "assembly" }>) {
  for (const p of spec.parts) {
    const [s0, s1, s2] = p.size;
    let geo: THREE.BufferGeometry;
    if (p.shape === "sphere") geo = new THREE.SphereGeometry(s0, 48, 32);
    else if (p.shape === "box") geo = new THREE.BoxGeometry(s0, s1, s2);
    else if (p.shape === "cylinder") geo = new THREE.CylinderGeometry(s0, s0, s1, 48);
    else if (p.shape === "cone") geo = new THREE.ConeGeometry(s0, s1, 48);
    else if (p.shape === "torus") geo = new THREE.TorusGeometry(s0, s1, 20, 72);
    else if (p.shape === "capsule") geo = new THREE.CapsuleGeometry(s0, s1, 10, 24);
    else geo = new THREE.SphereGeometry(1, 48, 32).scale(s0, s1, s2);
    const m = mesh(geo, material(p.material, p.color));
    m.rotation.set(...(p.rotation_deg.map((d) => (d * Math.PI) / 180) as [number, number, number]));
    const g = new THREE.Group().add(m);
    g.position.set(...(p.position as [number, number, number]));
    b.part(p.id, p.label, g);
  }
  b.cut = [new THREE.Plane(new THREE.Vector3(0, 0, -1), 0)];
  b.views = [{ id: "whole", label: "Whole" }, { id: "exploded", label: "Explode" }, { id: "cutaway", label: "Cut open" }, { id: "xray", label: "X-ray" }];
}

// ---------- drawing ----------
// One WebGL context for the whole page. Each call draws one model at the
// given size and copies the frame to that model's own canvas.
export class ModelStage {
  private renderer: THREE.WebGLRenderer;
  private camera = new THREE.PerspectiveCamera(32, 1, 0.01, 1000);
  private env: THREE.Texture;

  constructor() {
    const canvas = document.createElement("canvas");
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: false, powerPreference: "high-performance" });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.localClippingEnabled = true;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
  }

  // Draws `built` into `out` (a canvas w × h CSS pixels at `dpr`), and returns
  // where its labels go, in CSS pixels from the canvas's top left.
  draw(built: Built, state: ModelState, t: number, explode: number, out: HTMLCanvasElement, w: number, h: number, dpr: number): ModelLabel[] {
    const pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(pw, ph, false);
    built.scene.environment = this.env;
    built.update(t, state, explode);
    const cam = this.camera;
    cam.aspect = w / h;
    const dist = (built.radius / Math.sin((cam.fov * Math.PI) / 360)) * 1.08 / Math.max(0.3, state.zoom);
    cam.position.set(Math.sin(state.yaw) * Math.cos(state.pitch) * dist, Math.sin(state.pitch) * dist, Math.cos(state.yaw) * Math.cos(state.pitch) * dist);
    cam.near = dist / 100;
    cam.far = dist * 10;
    cam.lookAt(0, 0, 0);
    cam.updateProjectionMatrix();
    this.renderer.render(built.scene, cam);
    if (out.width !== pw || out.height !== ph) {
      out.width = pw;
      out.height = ph;
    }
    out.getContext("2d")!.drawImage(this.renderer.domElement, 0, 0);
    const labels: ModelLabel[] = [];
    built.root.updateMatrixWorld(true);
    for (const p of built.parts) {
      if (!p.label) continue;
      const world = built.root.localToWorld(p.anchor.clone().add(p.group.position).sub(p.home));
      const v = world.project(cam);
      if (v.z > 1) continue;
      labels.push({ id: p.id, text: p.label, x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h, focused: state.focus === p.id });
    }
    return labels;
  }

  dispose() {
    this.env.dispose();
    this.renderer.dispose();
  }
}
