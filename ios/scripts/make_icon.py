"""Draws the app icon (1024x1024, opaque RGB as iOS requires). Needs Pillow.
Run: python ios/scripts/make_icon.py"""
import pathlib
from PIL import Image, ImageDraw

S = 4096  # draw large, then downsample for smooth edges
img = Image.new("RGB", (S, S))
d = ImageDraw.Draw(img)
top, bottom = (88, 99, 232), (40, 48, 150)
for y in range(S):
    t = y / (S - 1)
    d.line([(0, y), (S, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)))

cx = S / 2
# timeframe lines flowing in from the left and converging on the coin (the "confluence")
tip = (cx - S * 0.215, S * 0.56)
for y0, alpha in [(0.24, 60), (0.38, 90), (0.56, 130), (0.74, 90), (0.88, 60)]:
    col = tuple(round(255 * alpha / 255 + c * (1 - alpha / 255)) for c in (60, 70, 185))
    d.line([(-S * 0.02, S * y0), tip], fill=col, width=int(S * 0.014))

# two-part diamond
upper = [(cx, S * 0.17), (cx - S * 0.205, S * 0.535), (cx, S * 0.645), (cx + S * 0.205, S * 0.535)]
lower = [(cx - S * 0.205, S * 0.585), (cx, S * 0.835), (cx + S * 0.205, S * 0.585), (cx, S * 0.695)]
d.polygon(upper, fill=(255, 255, 255))
d.polygon(lower, fill=(214, 219, 255))
d.line([(cx, S * 0.17), (cx, S * 0.645)], fill=(225, 229, 255), width=int(S * 0.006))

out = pathlib.Path(__file__).resolve().parents[1] / "Confluence" / "Assets.xcassets" / "AppIcon.appiconset" / "icon-1024.png"
img.resize((1024, 1024), Image.LANCZOS).save(out, optimize=True)
print("wrote", out)
