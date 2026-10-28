# Builds the tutor's handwriting, lib/tutor-hand/kalam.json, from two
# handwriting fonts (both SIL Open Font License): Kalam Light for letters,
# digits and most symbols, Mynerve for the Greek letters and arrows Kalam lacks.
#
# A font draws letters as filled outlines; a pen draws them as lines. So each
# glyph is rendered large, thinned to its centre line, traced into pen strokes,
# and put in the order and direction a hand would write it.
#
#   pip install pillow scikit-image fonttools numpy
#   python3 scripts/build-tutor-hand.py Kalam-Light.ttf Mynerve-Regular.ttf lib/tutor-hand/kalam.json
#
# Output: glyph advance widths and strokes as flat [x0, y0, x1, y1, ...]
# polylines in render pixels (EM 320), y up from the baseline.
import json
import math
import sys

import numpy as np
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont
from skimage.measure import label as cc_label, regionprops
from skimage.morphology import skeletonize

EM = 320  # render size in px
PAD = 60
NB = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
CHARS = (
    ''.join(chr(c) for c in range(32, 127))
    + "²³¹√π→←↑↓≠±×÷≤≥∞∫Σ∑θαβγδΔλμσφωε·°≈∂∏½¼¾–—“”‘’€£¥ΩΦΨηρτχψζκνξ¬−•…⁰⁴⁵⁶⁷⁸⁹ⁿ₀₁₂₃₄₅₆₇₈₉"
)


def render(font, ch):
    l, t, r, b = font.getbbox(ch, anchor='ls')
    w = max(1, r - l) + 2 * PAD
    h = max(1, b - t) + 2 * PAD
    img = Image.new('L', (w, h), 0)
    ox, oy = PAD - l, PAD - t  # where the pen origin (left, baseline) lands
    ImageDraw.Draw(img).text((ox, oy), ch, fill=255, font=font, anchor='ls')
    return np.array(img) > 128, ox, oy


def trace(sk):
    """Skeleton pixels -> paths (lists of (y, x)) between ends and junctions."""
    pts = set(zip(*np.nonzero(sk)))

    def nbrs(p):
        y, x = p
        return [(y + dy, x + dx) for dy, dx in NB if (y + dy, x + dx) in pts]

    nodes = {p for p in pts if len(nbrs(p)) != 2}
    used = set()
    paths = []

    def walk(a, b):
        path = [a, b]
        used.add(frozenset((a, b)))
        prev, cur = a, b
        while cur not in nodes:
            nxt = [q for q in nbrs(cur) if q != prev and frozenset((cur, q)) not in used]
            if not nxt:
                break
            # prefer a 4-connected step, so the path doesn't cut corners
            nxt.sort(key=lambda q: abs(q[0] - cur[0]) + abs(q[1] - cur[1]))
            q = nxt[0]
            used.add(frozenset((cur, q)))
            prev, cur = cur, q
            path.append(cur)
        return path

    for n in nodes:
        for q in nbrs(n):
            if frozenset((n, q)) not in used:
                paths.append(walk(n, q))
    # closed loops with no ends or junctions, like o
    rest = [p for p in pts if p not in nodes and all(frozenset((p, q)) not in used for q in nbrs(p))]
    seen = set()
    for p in rest:
        if p in seen:
            continue
        loop = [p]
        seen.add(p)
        prev, cur = None, p
        while True:
            nxt = [q for q in nbrs(cur) if q != prev and q not in seen]
            if not nxt:
                break
            prev, cur = cur, nxt[0]
            seen.add(cur)
            loop.append(cur)
        if len(loop) > 8:
            loop.append(loop[0])
            paths.append(loop)
    junctions = {n for n in nodes if len(nbrs(n)) >= 3}
    return paths, junctions


def plen(p):
    return sum(math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]) for i in range(1, len(p)))


def cluster(points, r):
    """Points within r of each other (transitively) share a cluster id."""
    points = list(points)
    cid = {}
    k = 0
    for n in points:
        if n in cid:
            continue
        stack = [n]
        cid[n] = k
        while stack:
            a = stack.pop()
            for b in points:
                if b not in cid and abs(a[0] - b[0]) <= r and abs(a[1] - b[1]) <= r:
                    cid[b] = k
                    stack.append(b)
        k += 1
    return cid


def simplify(p, eps):
    """Ramer-Douglas-Peucker."""
    if len(p) < 3:
        return p
    a, b = np.array(p[0], float), np.array(p[-1], float)
    ab = b - a
    L = np.hypot(*ab)
    best, bi = -1, 0
    for i in range(1, len(p) - 1):
        q = np.array(p[i], float)
        d = abs(ab[0] * (a[1] - q[1]) - ab[1] * (a[0] - q[0])) / L if L > 0 else np.hypot(*(q - a))
        if d > best:
            best, bi = d, i
    if best > eps:
        return simplify(p[: bi + 1], eps)[:-1] + simplify(p[bi:], eps)
    return [p[0], p[-1]]


def smooth(p, n=2):
    """Chaikin corner cutting."""
    closed = p[0] == p[-1] and len(p) > 3
    for _ in range(n):
        if len(p) < 3:
            break
        q = [] if closed else [p[0]]
        for i in range(len(p) - 1):
            a, b = p[i], p[i + 1]
            q.append((0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]))
            q.append((0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]))
        q.append(q[0] if closed else p[-1])
        p = q
    return p


def join(p, pe, q, qe):
    """p and q joined where p's end pe meets q's end qe."""
    if not pe:
        p = p[::-1]
    if qe:
        q = q[::-1]
    return p + q[1:]


def strokes_for(font, ch, stroke_px):
    mask, ox, oy = render(font, ch)
    if not mask.any():
        return [], [], ox, oy
    sk = skeletonize(mask)
    paths, junctions = trace(sk)
    # dots (the i's tittle, a full stop) can thin to a pixel or two with no path
    lab = cc_label(mask)
    traced = {int(lab[int(y), int(x)]) for p in paths for (y, x) in p}
    for reg in regionprops(lab):
        if reg.label in traced:
            continue
        cy, cx = reg.centroid
        r = max(2.0, min(reg.bbox[2] - reg.bbox[0], reg.bbox[3] - reg.bbox[1]) * 0.18)
        paths.append([(cy - r * 0.4, cx - r * 0.5), (cy + r * 0.4, cx + r * 0.5)])
    # prune spurs: branches about a stroke-width long that end in nothing
    for _ in range(4):
        ends = {}
        for p in paths:
            for e in (p[0], p[-1]):
                ends[e] = ends.get(e, 0) + 1
        keep = [p for p in paths if not ((ends[p[0]] == 1) != (ends[p[-1]] == 1) and plen(p) < stroke_px * 1.6 and len(paths) > 1)]
        if len(keep) == len(paths):
            break
        paths = keep
    # Junction pixels close together are one junction. The bits of skeleton
    # inside a junction are not strokes; dropping them lets the arms meet.
    cid = cluster({e for p in paths for e in (p[0], p[-1])}, int(stroke_px))
    jc = {cid[e] for e in cid if e in junctions}
    inner = [p for p in paths if cid.get(p[0]) in jc and cid.get(p[0]) == cid.get(p[-1]) and plen(p) < stroke_px * 1.5]
    if len(inner) < len(paths):
        paths = [p for p in paths if not any(p is q for q in inner)]

    def leaving(p, at_start):
        # skip the first few pixels, which bend toward the junction's centre
        s = p if at_start else p[::-1]
        k = min(len(s) - 1, 4) if len(s) > 10 else 0
        seg = s[k: min(len(s), k + 14)]
        v = np.array(seg[-1], float) - np.array(seg[0], float)
        n = np.hypot(*v)
        return v / n if n else v

    # join arms that carry straight on through a junction (the bar of t, x)
    while True:
        best = None
        for i, p in enumerate(paths):
            for j in range(i + 1, len(paths)):
                q = paths[j]
                for pe in (0, 1):
                    for qe in (0, 1):
                        a = p[-1] if pe else p[0]
                        b = q[-1] if qe else q[0]
                        if cid.get(a) is None or cid.get(a) != cid.get(b):
                            continue
                        cos = -float(np.dot(leaving(p, not pe), leaving(q, not qe)))
                        if cos > 0.55 and (best is None or cos > best[0]):
                            best = (cos, i, j, pe, qe)
        if not best:
            break
        _, i, j, pe, qe = best
        paths = [x for k, x in enumerate(paths) if k not in (i, j)] + [join(paths[i], pe, paths[j], qe)]
    # a junction left with just two arms is a corner, as at the point of v,
    # V, W, M or <: the pen goes round it without lifting
    bent = [False] * len(paths)
    merged = True
    while merged:
        merged = False
        at = {}
        for i, p in enumerate(paths):
            for pe in (0, 1):
                e = p[-1] if pe else p[0]
                if cid.get(e) in jc:
                    at.setdefault(cid[e], []).append((i, pe))
        for ends in at.values():
            if len(ends) == 2 and ends[0][0] != ends[1][0]:
                (i, pe), (j, qe) = ends
                keep = [k for k in range(len(paths)) if k not in (i, j)]
                paths, bent = [paths[k] for k in keep] + [join(paths[i], pe, paths[j], qe)], [bent[k] for k in keep] + [True]
                merged = True
                break
    out = []
    for p in paths:
        q = simplify([(float(x), float(y)) for (y, x) in p], 0.8)
        out.append(simplify(smooth(q, 2), 0.45))
    return out, bent, ox, oy


def order(strokes, em, bent):
    """Pen order and direction: each stroke starts at its upper (or left) end;
    strokes left to right, then crossbars, then dots."""
    res = []
    for si, s in enumerate(strokes):
        closed = math.hypot(s[0][0] - s[-1][0], s[0][1] - s[-1][1]) < 2
        a, b = s[0], s[-1]
        if closed:
            # start a loop near its top right and go anticlockwise on screen
            i = min(range(len(s)), key=lambda k: s[k][1] - 0.3 * s[k][0])
            s = s[i:-1] + s[:i + 1]
            area = sum(s[k][0] * s[k + 1][1] - s[k + 1][0] * s[k][1] for k in range(len(s) - 1))
            if area > 0:
                s = s[::-1]
        elif bent[si]:
            # round a corner from the left end (M, N, V, W), or from the top
            # when both ends sit one above the other (<, >, Σ)
            if abs(b[0] - a[0]) > em * 0.2:
                if b[0] < a[0]:
                    s = s[::-1]
            elif b[1] < a[1]:
                s = s[::-1]
        else:
            dx, dy = b[0] - a[0], b[1] - a[1]
            # mostly vertical: write downward; otherwise left to right
            if abs(dy) > abs(dx) * 0.6:
                if dy < 0:
                    s = s[::-1]
            elif dx < 0:
                s = s[::-1]
        res.append(s)

    def span(s):
        xs = [p[0] for p in s]
        ys = [p[1] for p in s]
        return min(xs), max(xs), min(ys), max(ys)

    def crossbar(i):
        # a level stroke with a taller stroke running through it, like the bar
        # of t, f, A, H or +: a hand writes it after the strokes it crosses
        x0, x1, y0, y1 = span(res[i])
        if (y1 - y0) > (x1 - x0) * 0.5:
            return False
        mid = (y0 + y1) / 2
        for j, o in enumerate(res):
            if j == i:
                continue
            a0, a1, b0, b1 = span(o)
            if b0 < mid - em * 0.06 and b1 > mid + em * 0.06 and a1 > x0 and a0 < x1 and (b1 - b0) > (a1 - a0) * 0.8:
                return True
        return False

    bars = [crossbar(i) for i in range(len(res))]

    def key(i):
        s = res[i]
        small = plen(s) < em * 0.22 and not bars[i]
        return (2 if small else 1 if bars[i] else 0, round(min(p[0] for p in s) / (em * 0.12)), min(p[1] for p in s))

    return [res[i] for i in sorted(range(len(res)), key=key)]


def build(path, chars):
    font = ImageFont.truetype(path, EM)
    cmap = TTFont(path).getBestCmap()
    # stroke width in px, from the vertical stem of l
    m, _, _ = render(font, 'l')
    rows = m.sum(axis=1)
    stroke_px = max(3, int(np.median(rows[rows > 0])))
    glyphs = {}
    for ch in chars:
        if ord(ch) not in cmap:
            continue
        if ch == ' ':
            glyphs[ch] = {'w': round(font.getlength(' ')), 's': []}
            continue
        strokes, bent, ox, oy = strokes_for(font, ch, stroke_px)
        flat = []
        for s in order(strokes, EM, bent):
            arr = []
            for (x, y) in s:
                arr += [round(x - ox), round(oy - y)]
            flat.append(arr)
        glyphs[ch] = {'w': round(font.getlength(ch), 1), 's': flat}
    return {
        'xHeight': -font.getbbox('x', anchor='ls')[1],
        'capHeight': -font.getbbox('H', anchor='ls')[1],
        'stroke': stroke_px,
        'glyphs': glyphs,
    }


def g(w, *strokes):
    return {'w': w, 's': [[float(v) for v in s] for s in strokes]}


# Symbols neither font has, drawn by hand in the same units (y up from the baseline).
EXTRA = {
    '∈': g(150, [130, 150, 70, 150, 40, 120, 30, 75, 40, 30, 70, 0, 130, 0], [35, 75, 120, 75]),
    '⊂': g(150, [130, 150, 70, 150, 40, 120, 30, 75, 40, 30, 70, 0, 130, 0]),
    '∪': g(160, [30, 150, 30, 50, 50, 10, 80, 0, 110, 10, 130, 50, 130, 150]),
    '∩': g(160, [30, 0, 30, 100, 50, 140, 80, 150, 110, 140, 130, 100, 130, 0]),
    '⇒': g(200, [20, 95, 160, 95], [20, 55, 160, 55], [130, 125, 180, 75, 130, 25]),
    '⇔': g(230, [40, 95, 190, 95], [40, 55, 190, 55], [70, 125, 20, 75, 70, 25], [160, 125, 210, 75, 160, 25]),
    '∇': g(190, [20, 227, 170, 227, 95, 0, 20, 227]),
    '∝': g(190, [170, 120, 140, 130, 100, 110, 70, 60, 40, 40, 20, 70, 40, 100, 70, 90, 100, 40, 140, 20, 170, 30]),
    '∀': g(190, [20, 227, 95, 0, 170, 227], [50, 120, 140, 120]),
    '∃': g(170, [20, 227, 140, 227, 140, 0, 20, 0], [40, 115, 140, 115]),
    '∧': g(170, [25, 0, 85, 150, 145, 0]),
    '∨': g(170, [25, 150, 85, 0, 145, 150]),
    '′': g(60, [40, 227, 25, 160]),
    '″': g(100, [40, 227, 25, 160], [80, 227, 65, 160]),
}
SUP = {'⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', 'ⁿ': 'n'}
SUB = {'₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9'}


def scaled(g, k, dy):
    return {'w': round(g['w'] * k + 8, 1), 's': [[round(v * k + (dy if i % 2 else 0)) for i, v in enumerate(st)] for st in g['s']]}


if __name__ == '__main__':
    kalam_path, mynerve_path, out = sys.argv[1:4]
    kalam = build(kalam_path, CHARS)
    mynerve = build(mynerve_path, CHARS)
    glyphs = dict(kalam['glyphs'])
    # Mynerve's glyphs, scaled to Kalam's cap height, for what Kalam lacks
    k = kalam['capHeight'] / mynerve['capHeight']
    for ch, gl in mynerve['glyphs'].items():
        if ch not in glyphs:
            glyphs[ch] = {'w': round(gl['w'] * k, 1), 's': [[round(v * k) for v in st] for st in gl['s']]}
    for ch, gl in EXTRA.items():
        glyphs.setdefault(ch, gl)
    # superscripts and subscripts from the plain digits when the font has none
    cap = kalam['capHeight']
    for table, dy in ((SUP, cap * 0.5), (SUB, -cap * 0.18)):
        for ch, base in table.items():
            if ch not in kalam['glyphs'] and base in glyphs:
                glyphs[ch] = scaled(glyphs[base], 0.6, dy)
    data = {
        'name': 'Kalam Light single-line (with Mynerve for Greek and arrows)',
        'unitsPerEm': EM,
        'xHeight': kalam['xHeight'],
        'capHeight': cap,
        'stroke': kalam['stroke'],
        'glyphs': glyphs,
    }
    with open(out, 'w') as f:
        json.dump(data, f, separators=(',', ':'))
    missing = ''.join(c for c in CHARS if c not in glyphs)
    print(f"{len(glyphs)} glyphs -> {out}" + (f"; missing {missing}" if missing else ''))
