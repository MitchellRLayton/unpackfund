#!/usr/bin/env python3
"""One-off extraction: Newsreader 800 → `web/public/intro/glyphs.json` (plus the numbers
the bake needs to hard-code).

**This is not a build step.** `node scripts/bake-intro.mjs` reads only the committed
`glyphs.json` and the numbers printed here, so the site builds on a bare Node install with
no python, no fonttools and no network font access. Run this again only when the font
file changes, and commit the result.

Font tooling is needed exactly once, in a workspace-local venv (nothing global):

    python3 -m venv .work/venv                      # or reuse an existing one
    .work/venv/bin/pip install fonttools brotli uharfbuzz
    .work/venv/bin/python scripts/sample-glyphs.py  # writes web/public/intro/glyphs.json

- `fonttools` + `brotli` decompress the WOFF2 and instantiate the variable axis.
- `uharfbuzz` is the *shaper*: it gives the kerned per-letter x offsets of "VTI" and
  "VOO" — the same positions a browser uses — so the dots land inside the letters as
  rendered, not inside an unkerned approximation. (The V/O pair kerns by −83 units; about
  two dot spacings, so it matters.)

What it emits, in the shape `web/components/intro/CONTRACT.md` §1 fixes:

    { unitsPerEm: number,
      letters: { V: Path[], T: Path[], I: Path[], O: Path[] } }
    Path = [x0, y0, x1, y1, …]      closed polygons, em units, y down

Coordinates are the glyph's own space divided by unitsPerEm, with y negated (font space is
y-up and the film is y-down). Curves are flattened to polylines by recursive subdivision
at a 0.4 font-unit tolerance — 0.0002 em, far below the 1/256 em raster the bake samples
on, so the stencil is the outline.

It also prints the constants block the bake hard-codes: the advances and the word layouts.
Those cannot live in `glyphs.json` (the contract fixes that file's shape) and cannot be
re-derived at build time without font tooling.
"""

from __future__ import annotations

import argparse
import io
import json
import sys

from fontTools.pens.basePen import BasePen, DecomposingPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
import uharfbuzz as hb

LETTERS = ("V", "T", "I", "O")
WORDS = ("VTI", "VOO")

#: Flatness tolerance for curve flattening, in font units (unitsPerEm is 2000).
TOLERANCE = 0.4
#: Recursion guard: a wrongly-specified curve must fail loudly, not hang.
MAX_DEPTH = 10


def _dist_point_line(p, a, b):
    """Distance from `p` to the segment `a`–`b`."""
    ax, ay = a
    bx, by = b
    px, py = p
    dx, dy = bx - ax, by - ay
    length = (dx * dx + dy * dy) ** 0.5
    if length == 0:
        return ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
    return abs(dx * (ay - py) - (ax - px) * dy) / length


class FlattenPen(BasePen, DecomposingPen):
    """Collects a glyph's contours as flat point lists."""

    def __init__(self, glyphSet, tolerance=TOLERANCE):
        BasePen.__init__(self, glyphSet)
        DecomposingPen.__init__(self, glyphSet)
        self.tolerance = tolerance
        self.contours: list[list[tuple[float, float]]] = []
        self._current: list[tuple[float, float]] | None = None

    # -- pen protocol ------------------------------------------------------

    def _moveTo(self, pt):
        self._finish()
        self._current = [pt]

    def _lineTo(self, pt):
        self._current.append(pt)

    def _qCurveToOne(self, p1, p2):
        self._flatten_quad(self._current[-1], p1, p2, 0)

    def _curveToOne(self, p1, p2, p3):
        self._flatten_cubic(self._current[-1], p1, p2, p3, 0)

    def _closePath(self):
        self._finish()

    def _endPath(self):
        self._finish()

    # -- flattening --------------------------------------------------------

    def _flatten_quad(self, p0, p1, p2, depth):
        if depth >= MAX_DEPTH or _dist_point_line(p1, p0, p2) <= self.tolerance:
            self._current.append(p2)
            return
        # de Casteljau at t = 0.5
        m01 = ((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2)
        m12 = ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2)
        mid = ((m01[0] + m12[0]) / 2, (m01[1] + m12[1]) / 2)
        self._flatten_quad(p0, m01, mid, depth + 1)
        self._flatten_quad(mid, m12, p2, depth + 1)

    def _flatten_cubic(self, p0, p1, p2, p3, depth):
        flat = max(_dist_point_line(p1, p0, p3), _dist_point_line(p2, p0, p3))
        if depth >= MAX_DEPTH or flat <= self.tolerance:
            self._current.append(p3)
            return
        m01 = ((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2)
        m12 = ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2)
        m23 = ((p2[0] + p3[0]) / 2, (p2[1] + p3[1]) / 2)
        a = ((m01[0] + m12[0]) / 2, (m01[1] + m12[1]) / 2)
        b = ((m12[0] + m23[0]) / 2, (m12[1] + m23[1]) / 2)
        mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        self._flatten_cubic(p0, m01, a, mid, depth + 1)
        self._flatten_cubic(mid, b, m23, p3, depth + 1)

    def _finish(self):
        if self._current is None:
            return
        points = self._current
        # Drop a closing point that repeats the first one: the polygon is closed anyway,
        # and a repeated vertex would make two identical segments.
        while len(points) > 1 and points[-1] == points[0]:
            points.pop()
        if len(points) >= 3:
            self.contours.append(points)
        self._current = None


def instance_bytes(font: TTFont) -> bytes:
    """The font as an uncompressed TTF, for the shaper (WOFF2 is not shaper input)."""
    font.flavor = None
    buffer = io.BytesIO()
    font.save(buffer)
    return buffer.getvalue()


def shape_words(font: TTFont, data: bytes, weight: float):
    """[(glyph name, x offset in font units, advance)] for each word, kerned."""
    face = hb.Face(data)
    shaper = hb.Font(face)
    shaper.set_variations({"wght": weight})
    order = font.getGlyphOrder()
    shaped = {}
    for word in WORDS:
        buffer = hb.Buffer()
        buffer.add_str(word)
        buffer.guess_segment_properties()
        hb.shape(shaper, buffer)
        x = 0
        placements = []
        for info, position in zip(buffer.glyph_infos, buffer.glyph_positions):
            placements.append((order[info.codepoint], x, position.x_advance))
            x += position.x_advance
        shaped[word] = (placements, x)
    return shaped


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--font", default="web/public/fonts/newsreader.woff2")
    parser.add_argument("--out", default="web/public/intro/glyphs.json")
    parser.add_argument("--weight", type=float, default=800.0)
    args = parser.parse_args(argv)

    font = TTFont(args.font)
    axes = {axis.axisTag: axis for axis in font["fvar"].axes}
    if "opsz" in axes:
        # The brief said "largest optical size". If a later Newsreader adds an `opsz`
        # axis, set it to the maximum rather than silently sampling the default.
        font = instantiateVariableFont(font, {"opsz": axes["opsz"].maxValue}, inplace=False)
    instance = instantiateVariableFont(font, {"wght": args.weight}, inplace=False)
    upem = instance["head"].unitsPerEm
    glyph_set = instance.getGlyphSet()

    letters = {}
    for name in LETTERS:
        pen = FlattenPen(glyph_set)
        glyph_set[name].draw(pen)
        if not pen.contours:
            raise SystemExit(f"sample-glyphs: {name} produced no contours")
        paths = []
        for contour in pen.contours:
            flat = []
            for x, y in contour:
                flat.append(round(x / upem, 5))
                flat.append(round(-y / upem, 5))  # font space is y-up, the film is y-down
            paths.append(flat)
        letters[name] = paths

    glyphs = {"unitsPerEm": upem, "letters": letters}

    with open(args.out, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(glyphs, separators=(",", ":")) + "\n")

    data = instance_bytes(instance)
    shaped = shape_words(instance, data, args.weight)
    hmtx = instance["hmtx"]
    hhea = instance["hhea"]

    print(f"upem        {upem}")
    print(f"weight      {args.weight}")
    print(f"ascender    {hhea.ascent} ({hhea.ascent / upem:.6f} em)")
    print(f"descender   {hhea.descent} ({hhea.descent / upem:.6f} em)")
    print("advances    " + " ".join(f"{name}={hmtx[name][0]}" for name in LETTERS))
    for word in WORDS:
        placements, total = shaped[word]
        layout = " ".join(f"{name}@{x}" for name, x, _ in placements)
        print(f"word {word}    {layout}  advance={total} ({total / upem:.6f} em)")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
