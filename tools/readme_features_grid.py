"""Feature grid for the README: 3x3 bordered cards, icon + label, text drawn
as paths (Noto Sans) so it renders the same everywhere. Needs fontTools.

Same grid as the Android README, with the last card swapped for the web app.

Usage, from the repo root:
    python tools/readme_features_grid.py docs/readme src/assets/fonts/noto_sans_regular.ttf <ic_itd.png>
<ic_itd.png> is the 3D audio icon of the Android app (res/drawable/ic_itd.png).
Writes features-dark.svg and features-light.svg.
"""
import os
import re
import sys

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

OUT, FONT = sys.argv[1], sys.argv[2]

ACCENT = "#27B397"
# label colour, card border (the page background shows through)
THEMES = {
    "dark":  ("#E6EDF3", "#3D444D"),
    "light": ("#1F2328", "#D1D9E0"),
}

COLS, ROWS = 3, 3
TILE_W, TILE_H = 280, 160
GAP = 12                      # space between cards
RADIUS = 12
ICON = 56                     # rendered icon size (px)
ICON_TOP = 30                 # icon top inside the card
LABEL_BASE = 128              # label baseline inside the card
LABEL_SIZE = 19
STROKE = 1.2                  # line weight in the 24-unit icon box


def p(d, sw=STROKE):
    return (f'<path d="{d}" fill="none" stroke="{{c}}" stroke-width="{sw}" '
            f'stroke-linecap="round" stroke-linejoin="round"/>')


def dot(x, y, r):
    return f'<circle cx="{x}" cy="{y}" r="{r}" fill="{{c}}"/>'


ICONS = {}

# Self-hosted: two server units with status lights.
ICONS["server"] = (
    p("M4.5,3h15a1.5,1.5 0 0 1 1.5,1.5v4.5a1.5,1.5 0 0 1 -1.5,1.5h-15a1.5,1.5 0 0 1 -1.5,-1.5v-4.5a1.5,1.5 0 0 1 1.5,-1.5z"
      "M4.5,13.5h15a1.5,1.5 0 0 1 1.5,1.5v4.5a1.5,1.5 0 0 1 -1.5,1.5h-15a1.5,1.5 0 0 1 -1.5,-1.5v-4.5a1.5,1.5 0 0 1 1.5,-1.5z"
      "M13,6.75h5M13,17.25h5")
    + dot(6.75, 6.75, 1.1) + dot(6.75, 17.25, 1.1))


# Stem separation: the beamed note of the logo nucleus, three straight lines,
# three single eighth notes.
def logo_note(x, y, k):
    """Logo nucleus note (FisionRenderer, 512 space) placed at x,y scaled k."""
    d = ("M207.5,287.5L207.5,227.4Q207.5,215.4 219.29,213.17L260.21,205.43"
         "Q272,203.2 272,215.2L272,275.8M207.5,242.8L272,231.5")
    body = p(d, sw=STROKE / k)
    # Heads nudged under the stems: tangent stems leave a notch when filled.
    sw = STROKE / k
    heads = (f'<circle cx="{207.5 - 18 + sw / 2}" cy="287.5" r="18" fill="{{c}}"/>'
             f'<circle cx="{272 - 18 + sw / 2}" cy="275.8" r="18" fill="{{c}}"/>')
    return f'<g transform="translate({x} {y}) scale({k}) translate(-171.5 -203.2)">{body}{heads}</g>'


def eighth(x, y):
    """Single eighth note: head centre at x,y, stem up, one flag."""
    return (f'<ellipse cx="{x}" cy="{y}" rx="1.75" ry="1.35" transform="rotate(-20 {x} {y})" fill="{{c}}"/>'
            # stem starts inside the head so the join has no notch
            + p(f"M{x + 1.15},{y - 0.1}V{y - 5.6}c0.35,1.6 2.6,2 2.4,4.2"))


def arrow_head(x, y):
    """Filled arrow head with its tip at x,y, pointing right."""
    return f'<path d="M{x - 2.3},{y - 1.45}L{x},{y}L{x - 2.3},{y + 1.45}Z" fill="{{c}}" stroke="{{c}}" stroke-width="0.4" stroke-linejoin="round"/>'


ICONS["split"] = (
    logo_note(0.3, 7.9, 0.08)
    # trunk splitting into three arrows (curved up, straight, curved down)
    + p("M10.8,12H13.5"
        "M13.5,12C16.6,12 16.6,4 19.8,4H21.5"
        "M13.5,12H21.5"
        "M13.5,12C16.6,12 16.6,20 19.8,20H21.5")
    + arrow_head(23.6, 4) + arrow_head(23.6, 12) + arrow_head(23.6, 20)
    # one simple eighth note past each tip, in a column, clear of the arrows
    + eighth(26.8, 4.9) + eighth(26.8, 12.9) + eighth(26.8, 20.9))

ICON_W = {"split": 32}


# Stem mixer: horizontal sliders as in the app (thicker active track).
def slider(y, x):
    return p(f"M3,{y}H{x}", sw=1.9) + p(f"M{x},{y}H21") + dot(x, y, 1.9)


ICONS["mixer"] = slider(6, 15) + slider(12, 8) + slider(18, 12.5)

# 3D audio: the app's own icon (ic_itd.png, white on transparent) used as a
# mask over the accent, so it is the exact artwork in the grid colour.
import base64
ITD_PNG = sys.argv[3]
with open(ITD_PNG, "rb") as f:
    ITD_URI = "data:image/png;base64," + base64.b64encode(f.read()).decode()
ICONS["3d"] = ('<mask id="itd" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">'
               f'<image href="{ITD_URI}" x="0" y="0" width="24" height="24"/></mask>'
               '<rect x="0" y="0" width="24" height="24" fill="{c}" mask="url(#itd)"/>')

# Synced lyrics: the app's lyrics icon.
ICONS["lyrics"] = p(
    "M2.5,4.5H21.5M2.5,8.5H17M2.5,12.5H11"
    "M11.9,19.6a1.7,1.7 0,1 0,3.4 0a1.7,1.7 0,1 0,-3.4 0Z"
    "M17.9,18.2a1.7,1.7 0,1 0,3.4 0a1.7,1.7 0,1 0,-3.4 0Z"
    "M15.3,19.6V11.6L21.3,10.2V18.2")

# Chord diagrams: the app's chord grid icon.
ICONS["chords"] = (
    '<g transform="translate(12 12) scale(0.866) translate(-12 -12)">'
    + p("M3.05,0.45H20.95A1.75,1.75 0,0 1,22.7 2.2V21.8A1.75,1.75 0,0 1,20.95 23.55H3.05A1.75,1.75 0,0 1,1.3 21.8V2.2A1.75,1.75 0,0 1,3.05 0.45Z"
        "M1.3,8.15H22.7M1.3,15.85H22.7"
        "M5.58,0.45V17.6M5.58,21.8V23.55"
        "M9.86,0.45V9.9M9.86,14.1V23.55"
        "M14.14,0.45V23.55"
        "M18.42,0.45V2.2M18.42,6.4V23.55"
        "M16.32,4.3a2.1,2.1 0,1 0,4.2 0a2.1,2.1 0,1 0,-4.2 0Z"
        "M7.76,12a2.1,2.1 0,1 0,4.2 0a2.1,2.1 0,1 0,-4.2 0Z"
        "M3.48,19.7a2.1,2.1 0,1 0,4.2 0a2.1,2.1 0,1 0,-4.2 0Z", sw=STROKE / 0.866 * 0.85)
    + "</g>")

# Pitch & tempo: the app's pitch icon.
ICONS["pitch"] = p(
    "M5.7,11.5V3.2M3.2,5.8L5.7,3L8.2,5.8"
    "M19.5,12.5V20.8M17,18.2L19.5,21L22,18.2"
    "M7.9,18a2.4,2.4 0,1 0,4.8 0a2.4,2.4 0,1 0,-4.8 0Z"
    "M12.7,18V3.4C13.6,5.4 16.2,6.6 16.6,9.3C16.8,10.8 16,12 15,12.4")

# Dynamic metronome: the app's metronome icon (viewport 500, scale 0.9).
ICONS["metronome"] = (
    '<g transform="scale(0.048) translate(250 250) scale(0.9) translate(-250 -250)">'
    + p("M178.75,19H305.25L420.6,480.5H63.4Z M446,37L243.5,403M418,138.1L377,163L375.9,115",
        sw=STROKE / 0.048 / 0.9)
    + "</g>")

# Installable app: a screen with a download arrow into it.
ICONS["install"] = p(
    "M4.5,4h15a1.5,1.5 0 0 1 1.5,1.5v9a1.5,1.5 0 0 1 -1.5,1.5h-15a1.5,1.5 0 0 1 -1.5,-1.5v-9a1.5,1.5 0 0 1 1.5,-1.5z"
    "M8.5,20h7M12,16v4"
    "M12,6.8v5.6M9.6,10.2L12,12.6L14.4,10.2")

TILES = [
    ("server", "Self-hosted"), ("split", "Stem separation"), ("mixer", "Stem mixer"),
    ("3d", "3D audio"), ("lyrics", "Synced Lyrics"), ("chords", "Chord diagrams"),
    ("pitch", "Pitch & tempo"), ("metronome", "Dynamic metronome"), ("install", "Installable app"),
]

# --- text as paths ---------------------------------------------------------
font = TTFont(FONT)
glyphs = font.getGlyphSet()
cmap = font.getBestCmap()
upm = font["head"].unitsPerEm
hmtx = font["hmtx"]


def text_width(s, size):
    return sum(hmtx[cmap[ord(ch)]][0] for ch in s) * size / upm


def text_path(s, size, x, y):
    scale = size / upm
    pen = SVGPathPen(glyphs)
    cursor = 0
    for ch in s:
        g = cmap[ord(ch)]
        glyphs[g].draw(TransformPen(pen, (scale, 0, 0, -scale, x + cursor * scale, y)))
        cursor += hmtx[g][0]
    return re.sub(r"-?\d+\.\d+", lambda m: f"{float(m.group()):.2f}".rstrip("0").rstrip("."),
                  pen.getCommands())


REG_SIZE = 0.55            # registered sign: fraction of the label size
REG_RISE = 0.42            # and its baseline rise, in label sizes


def label_paths(label, cx, base):
    """Label centred on cx; a "®" is drawn small and raised."""
    parts = label.split("®")
    widths = [text_width(t, LABEL_SIZE) for t in parts]
    reg_w = text_width("®", LABEL_SIZE * REG_SIZE)
    x = cx - (sum(widths) + reg_w * (len(parts) - 1)) / 2
    out = []
    for i, t in enumerate(parts):
        if t:
            out.append(text_path(t, LABEL_SIZE, x, base))
        x += widths[i]
        if i < len(parts) - 1:
            out.append(text_path("®", LABEL_SIZE * REG_SIZE, x, base - LABEL_SIZE * REG_RISE))
            x += reg_w
    return out


def build(theme):
    text, stroke = THEMES[theme]
    w = COLS * TILE_W + (COLS - 1) * GAP
    h = ROWS * TILE_H + (ROWS - 1) * GAP
    names = [lbl for k, lbl in TILES]
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" '
           f'role="img" aria-label="Fision features: {", ".join(names).replace("&", "&amp;")}">']
    for i, (key, label) in enumerate(TILES):
        x0 = (i % COLS) * (TILE_W + GAP)
        y0 = (i // COLS) * (TILE_H + GAP)
        cx = x0 + TILE_W / 2
        out.append(f'<rect x="{x0 + 0.5}" y="{y0 + 0.5}" width="{TILE_W - 1}" height="{TILE_H - 1}" '
                   f'rx="{RADIUS}" fill="none" stroke="{stroke}"/>')
        k = ICON / 24
        ix, iy = cx - ICON_W.get(key, 24) * k / 2, y0 + ICON_TOP
        out.append(f'<g transform="translate({ix} {iy}) scale({k})">{ICONS[key].replace("{c}", ACCENT)}</g>')
        for d in label_paths(label, cx, y0 + LABEL_BASE):
            out.append(f'<path d="{d}" fill="{text}"/>')
    out.append("</svg>")
    return "\n".join(out)


for theme in THEMES:
    with open(os.path.join(OUT, f"features-{theme}.svg"), "w", encoding="utf-8") as f:
        f.write(build(theme))
print("ok")
