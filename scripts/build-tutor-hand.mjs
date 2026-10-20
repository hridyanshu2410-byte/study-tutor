// Converts a single-stroke SVG font (Hershey / EMS fonts from the `hersheytext`
// package) into the compact JSON the tutor writes with.
// Usage: node scripts/build-tutor-hand.mjs path/to/EMSFelix.svg lib/tutor-hand/ems-felix.json
import fs from "node:fs";

const [input, output] = process.argv.slice(2);
const src = fs.readFileSync(input, "utf8");
const num = (name) => Number(new RegExp(`${name}="([\\d.-]+)"`).exec(src)[1]);
const defaultAdvance = Number(/<font[^>]*horiz-adv-x="([\d.]+)"/.exec(src)[1]);
const entities = { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'" };

const glyphs = {};
for (const m of src.matchAll(/<glyph\s+([^>]*?)\/>/g)) {
  const attrs = Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
  if (attrs.unicode === undefined) continue;
  const ch = attrs.unicode
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&(\w+);/g, (_, e) => entities[e] ?? "");
  if ([...ch].length !== 1) continue;
  const strokes = (attrs.d ?? "")
    .split("M")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => part.replace(/L/g, " ").trim().split(/\s+/).map((n) => Math.round(Number(n))));
  glyphs[ch] = { w: Math.round(Number(attrs["horiz-adv-x"] ?? defaultAdvance)), s: strokes };
}

// Math symbols the font lacks, drawn in the same hand (font units, y up).
const extras = {
  "→": { w: 620, s: [[80, 220, 300, 224, 520, 218], [430, 300, 525, 218, 425, 140]] },
  "≠": { w: 715, s: [...(glyphs["="]?.s ?? []), [440, 470, 250, -30]] },
  "√": { w: 640, s: [[40, 260, 90, 290, 170, 0, 260, 560, 300, 700, 620, 700]] },
  "π": { w: 540, s: [[60, 400, 140, 440, 500, 445], [200, 440, 180, 200, 140, 0], [380, 440, 380, 150, 420, 10, 470, 30]] },
  "θ": { w: 450, s: [[260, 700, 150, 640, 90, 450, 110, 180, 190, 20, 280, 0, 360, 120, 380, 400, 340, 640, 260, 700], [100, 360, 370, 370]] },
  "∫": { w: 450, s: [[420, 780, 360, 800, 310, 760, 280, 600, 220, 0, 180, -160, 120, -190, 70, -150]] },
};
for (const [ch, g] of Object.entries(extras)) glyphs[ch] ??= g;

const font = { name: /font-family="([^"]+)"/.exec(src)[1], unitsPerEm: num("units-per-em"), xHeight: num("x-height"), capHeight: num("cap-height"), glyphs };
fs.writeFileSync(output, JSON.stringify(font));
console.log(`${Object.keys(glyphs).length} glyphs -> ${output}`);
