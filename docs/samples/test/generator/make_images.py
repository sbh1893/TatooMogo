"""Draws the pictures used in the test question paper (all original, no third-party images).

Diagrams are written as SVG and rasterised with Chromium so they become real PNG images in the PDF
(pdf.js only reports raster images as images; vector drawings would not test the image-crop path).
The "photo" is generated with PIL to look like a close-up skin photograph.
"""
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter
from playwright.sync_api import sync_playwright

OUT = Path(__file__).parent / "img"
OUT.mkdir(exist_ok=True)
FONT = "'Noto Sans CJK KR', sans-serif"

# --- 1. skin cross-section with A~E labels (answer: C = dermis) -------------------------------
SKIN = f"""
<svg xmlns='http://www.w3.org/2000/svg' width='520' height='300' viewBox='0 0 520 300' font-family="{FONT}">
  <rect width='520' height='300' fill='#fff'/>
  <path d='M20 40 Q80 30 140 42 T260 40 T380 44 T500 38 L500 196 L20 196 Z' fill='#f1a9a0'/>
  <path d='M20 40 Q80 30 140 42 T260 40 T380 44 T500 38 L500 92 Q440 100 380 92 T260 96 T140 90 T20 94 Z' fill='#e7b48f'/>
  <path d='M20 40 Q80 30 140 42 T260 40 T380 44 T500 38 L500 52 Q440 58 380 54 T260 52 T140 54 T20 52 Z' fill='#e9cfae'/>
  <path d='M20 196 L500 196 L500 256 L20 256 Z' fill='#fbe7a1'/>
  <g fill='#f7d97a' stroke='#e2bf55'>
    <circle cx='70' cy='224' r='18'/><circle cx='112' cy='230' r='20'/><circle cx='160' cy='222' r='17'/>
    <circle cx='210' cy='230' r='19'/><circle cx='258' cy='224' r='18'/><circle cx='305' cy='231' r='20'/>
    <circle cx='352' cy='222' r='17'/><circle cx='398' cy='229' r='19'/><circle cx='446' cy='224' r='18'/>
  </g>
  <rect x='20' y='256' width='480' height='30' fill='#c9645c'/>
  <g stroke='#b05050' stroke-width='3' fill='none'>
    <path d='M120 196 Q125 160 118 120'/><path d='M330 196 Q336 150 340 110'/>
  </g>
  <path d='M240 40 L246 34 L252 40 L250 160 Q246 176 242 160 Z' fill='#7a5a3a'/>
  <g font-size='15' font-weight='700' fill='#111'>
    <text x='4' y='51'>A</text><text x='4' y='79'>B</text><text x='4' y='151'>C</text>
    <text x='4' y='233'>D</text><text x='4' y='276'>E</text>
  </g>
</svg>"""

# --- 2. needle groupings seen from the tip (answer: magnum = two staggered rows) ---------------
def needles(points, r=10):
    dots = "".join(
        f"<circle cx='{x}' cy='{y}' r='{r}' fill='#9aa3ad' stroke='#4b5563' stroke-width='1.5'/>"
        f"<circle cx='{x - 2}' cy='{y - 2}' r='2' fill='#eef2f6'/>"
        for x, y in points
    )
    return (
        f"<svg xmlns='http://www.w3.org/2000/svg' width='170' height='110' viewBox='0 0 170 110'>"
        f"<rect width='170' height='110' rx='8' fill='#fff' stroke='#d1d5db'/>{dots}</svg>"
    )

NEEDLES = {
    "needle_1_rl3": needles([(75, 46), (95, 46), (85, 63)]),
    "needle_2_rl7": needles([(85, 55), (105, 55), (65, 55), (75, 38), (95, 38), (75, 72), (95, 72)]),
    "needle_3_flat5": needles([(45 + 20 * i, 55) for i in range(5)]),
    "needle_4_mag9": needles([(45 + 20 * i, 45) for i in range(5)] + [(55 + 20 * i, 65) for i in range(4)]),
    "needle_5_single": needles([(85, 55)], r=11),
}

# --- 3. autoclave control panel (group question 24~25) ---------------------------------------
AUTOCLAVE = f"""
<svg xmlns='http://www.w3.org/2000/svg' width='460' height='230' viewBox='0 0 460 230' font-family="{FONT}">
  <rect width='460' height='230' rx='14' fill='#d6dbe0' stroke='#8a939c' stroke-width='2'/>
  <rect x='20' y='18' width='420' height='150' rx='8' fill='#203a2a' stroke='#0f1f15' stroke-width='3'/>
  <g fill='#8ff0a4' font-family='monospace' font-size='22'>
    <text x='40' y='56'>STERILIZING</text>
    <text x='40' y='92'>TEMP   121.0 °C</text>
    <text x='40' y='124'>PRESS  1.1 kgf/cm²</text>
    <text x='40' y='154'>TIME   15:00</text>
  </g>
  <g font-size='14' fill='#222'>
    <circle cx='60' cy='198' r='14' fill='#e44'/><text x='80' y='203'>STOP</text>
    <circle cx='170' cy='198' r='14' fill='#3a3'/><text x='190' y='203'>START</text>
    <rect x='290' y='186' width='140' height='24' rx='4' fill='#f5f5f5' stroke='#888'/>
    <text x='300' y='203'>DOOR LOCKED</text>
  </g>
</svg>"""


def render_svgs():
    items = {"skin_layers": SKIN, "autoclave_panel": AUTOCLAVE, **NEEDLES}
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(device_scale_factor=2)
        for name, svg in items.items():
            page.set_content(f"<html><body style='margin:0;background:#fff'>{svg}</body></html>")
            page.locator("svg").screenshot(path=str(OUT / f"{name}.png"))
        browser.close()


def blowout_photo():
    """Close-up 'photo' of a tattoo line that has blown out (ink spread under the skin)."""
    random.seed(7)
    w, h = 640, 400
    base = Image.new("RGB", (w, h), (226, 182, 150))
    noise = Image.effect_noise((w, h), 28).convert("L")
    tint = Image.merge("RGB", [noise.point(lambda v: 200 + v // 6), noise.point(lambda v: 160 + v // 6), noise.point(lambda v: 130 + v // 6)])
    skin = Image.blend(base, tint, 0.45).filter(ImageFilter.GaussianBlur(1.2))

    d = ImageDraw.Draw(skin)
    for _ in range(260):  # pores and fine creases
        x, y = random.randrange(w), random.randrange(h)
        d.ellipse((x, y, x + 2, y + 2), fill=(190, 140, 115))
    for _ in range(18):
        x, y = random.randrange(w), random.randrange(h)
        d.line((x, y, x + random.randint(40, 120), y + random.randint(-10, 10)), fill=(205, 158, 128), width=1)

    path = [(60 + t, 210 - 90 * __import__("math").sin(t / 95)) for t in range(0, 520, 4)]
    halo = Image.new("L", (w, h), 0)
    hd = ImageDraw.Draw(halo)
    hd.line(path[45:], fill=255, width=46)  # right part blew out
    halo = halo.filter(ImageFilter.GaussianBlur(16))
    ink = Image.new("RGB", (w, h), (52, 62, 98))
    skin = Image.composite(ink, skin, halo.point(lambda v: int(v * 0.8)))

    line = Image.new("L", (w, h), 0)
    ImageDraw.Draw(line).line(path, fill=255, width=7)
    line = line.filter(ImageFilter.GaussianBlur(0.8))
    skin = Image.composite(Image.new("RGB", (w, h), (25, 28, 40)), skin, line)

    vignette = Image.new("L", (w, h), 0)
    ImageDraw.Draw(vignette).ellipse((-120, -90, w + 120, h + 90), fill=255)
    vignette = vignette.filter(ImageFilter.GaussianBlur(80))
    skin = Image.composite(skin, Image.new("RGB", (w, h), (120, 90, 75)), vignette)
    skin.save(OUT / "blowout_photo.jpg", quality=86)


if __name__ == "__main__":
    render_svgs()
    blowout_photo()
    print(sorted(p.name for p in OUT.iterdir()))
