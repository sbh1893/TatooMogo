"""Turns the text PDF into a scanned-look, image-only PDF (no text layer): slight tilt, grey paper, noise, blur."""
import random, subprocess, glob
from pathlib import Path
from PIL import Image, ImageFilter, ImageOps, ImageChops

OUT = Path(__file__).parent / "out"
tmp = Path("/tmp/scanpages"); tmp.mkdir(exist_ok=True)
for f in tmp.glob("*"): f.unlink()
subprocess.run(["pdftoppm", "-r", "150", "-gray", "-png", str(OUT / "TATQ_test_paper_A_text.pdf"), str(tmp / "s")], check=True)

random.seed(11)
pages = []
for f in sorted(tmp.glob("s-*.png")):
    im = Image.open(f).convert("L")
    im = im.rotate(random.uniform(-0.9, 0.9), resample=Image.BICUBIC, expand=False, fillcolor=255)
    im = im.filter(ImageFilter.GaussianBlur(0.6))
    noise = Image.effect_noise(im.size, 18).point(lambda v: v - 128 + 128)
    im = ImageChops.multiply(im, noise.point(lambda v: 235 + (v - 128) // 6))  # grey paper texture
    im = ImageOps.autocontrast(im, cutoff=1).point(lambda v: min(255, int(v * 0.97 + 6)))
    dx, dy = random.randint(-12, 12), random.randint(-10, 10)  # page not perfectly placed on the glass
    im = ImageChops.offset(im, dx, dy)
    pages.append(im.convert("RGB"))

dst = OUT / "TATQ_test_paper_A_scan.pdf"
pages[0].save(dst, save_all=True, append_images=pages[1:], resolution=150, quality=70)
print(dst, len(pages))
