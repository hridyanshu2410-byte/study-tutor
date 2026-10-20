# Tutor hand

`ems-felix.json` is the tutor's handwriting: single-stroke glyphs the tutor draws pen-stroke by pen-stroke.

- Font: EMS Felix, created by Sheldon B. Michaels, a derivative of Felipa by Fontstage.
- SVG conversion by Windell H. Oskay, distributed in the [`hersheytext`](https://github.com/techninja/hersheytextjs) package.
- License: [SIL Open Font License 1.1](https://openfontlicense.org).

Regenerate with `node scripts/build-tutor-hand.mjs EMSFelix.svg lib/tutor-hand/ems-felix.json`. Coordinates are font units with y pointing up; each stroke is a flat `[x0, y0, x1, y1, ...]` polyline.
