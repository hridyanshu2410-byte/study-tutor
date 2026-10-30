# Tutor hand

`kalam.json` is the tutor's handwriting: each glyph as the pen strokes a person makes to write it, in writing order, so the tutor's pen moves the way a hand does.

- Letters, digits and most symbols: [Kalam](https://github.com/itfoundry/kalam) Light, by the Indian Type Foundry. License: [OFL-Kalam.txt](OFL-Kalam.txt).
- Greek letters and arrows: [Mynerve](https://github.com/carolinashort/MyNerve), by Carolina Short. License: [OFL-Mynerve.txt](OFL-Mynerve.txt).
- A few math symbols neither font has (∈, ∪, ⇒, ∇, ∀ and similar) are drawn by hand in `scripts/build-tutor-hand.py`.

Both fonts are under the SIL Open Font License 1.1. The strokes are traced from the fonts' outlines (rendered, thinned to their centre lines, traced, then ordered the way a hand writes: top to bottom, left to right, crossbars and dots last).

Regenerate with `python3 scripts/build-tutor-hand.py Kalam-Light.ttf Mynerve-Regular.ttf lib/tutor-hand/kalam.json` (needs pillow, scikit-image, fonttools and numpy). Coordinates are render pixels at 320 px per em with y pointing up from the baseline; each stroke is a flat `[x0, y0, x1, y1, ...]` polyline.
