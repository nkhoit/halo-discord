#!/usr/bin/env python3
"""Generate the hosted page's icon: an original 64x64 pixel-art ring badge.

Writes server/icons/icon-64.png (native size), favicon.ico (32 and 64) and
apple-touch-icon.png (180). Every size is a nearest-neighbour resize of the
64x64 art, so the pixels stay crisp. The art is deterministic; run this again
after changing it. Requires Pillow.
"""

from __future__ import annotations

import argparse
import math
import random
from pathlib import Path

from PIL import Image

N = 64
OUTLINE = (4, 6, 14)


def mix(a, b, t):
    t = max(0.0, min(1.0, t))
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def ellipse(u, v, rx, ry):
    return (u / rx) ** 2 + (v / ry) ** 2


def rotate(x, y, cx, cy, deg):
    a = math.radians(-deg)
    dx, dy = x - cx, y - cy
    return dx * math.cos(a) - dy * math.sin(a), dx * math.sin(a) + dy * math.cos(a)


def outline(img, mask):
    px = img.load()
    for y in range(N):
        for x in range(N):
            if mask[y][x]:
                continue
            for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if 0 <= nx < N and 0 <= ny < N and mask[ny][nx]:
                    px[x, y] = OUTLINE
                    break


def badge() -> Image.Image:
    """A bold, high-contrast ring emblem on a dark round badge."""
    bg, rim, rim2 = (8, 12, 26), (40, 64, 110), (90, 140, 210)
    glow = (120, 220, 255)
    surf = [(40, 120, 210), (70, 170, 110), (110, 200, 240), (240, 248, 255)]
    hull_hi, hull, hull_lo = (240, 246, 252), (170, 182, 198), (80, 92, 110)

    img = Image.new("RGB", (N, N), (0, 0, 0))
    px = img.load()
    mask = [[False] * N for _ in range(N)]
    rng = random.Random(3)
    for y in range(N):
        for x in range(N):
            cx, cy = x + 0.5, y + 0.5
            r = math.hypot(cx - 32, cy - 32)
            if r > 31.5:
                px[x, y] = (0, 0, 0)
                continue
            col = rim2 if r > 30.2 else rim if r > 28.8 else bg
            if r < 28.8 and rng.random() < 0.025:
                col = (200, 210, 255)

            u, v = rotate(cx, cy, 32, 33, -24)
            eo, ei = ellipse(u, v, 25, 13.5), ellipse(u, v, 20.5, 9.2)
            if eo <= 1.0 and ei > 1.0:
                mask[y][x] = True
                if v < 0:
                    t = math.atan2(v / 13.5, u / 25)
                    col = surf[int((t + math.pi) * 6.3) % 4]
                    if ei < 1.25:
                        col = glow
                else:
                    f = u / 25
                    col = hull_hi if abs(f) < 0.18 else hull if abs(f) < 0.7 else hull_lo
            elif ei <= 1.0 and eo <= 1.0 and 1.0 - ei < 0.12 and v < 0:
                col = mix(col, glow, 0.35)
            px[x, y] = col
    outline(img, mask)
    for x, y in ((14, 18), (15, 18), (14, 19), (13, 18), (14, 17)):
        px[x, y] = (255, 246, 210)
    return img


def main() -> int:
    repository = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=repository / "server" / "icons")
    arguments = parser.parse_args()
    out: Path = arguments.out
    out.mkdir(parents=True, exist_ok=True)

    art = badge()
    art.save(out / "icon-64.png", optimize=True)
    art.resize((180, 180), Image.NEAREST).save(out / "apple-touch-icon.png", optimize=True)
    # Pillow would resample missing ICO sizes smoothly; supply the 32x32 frame.
    small = art.resize((32, 32), Image.NEAREST)
    art.save(out / "favicon.ico", sizes=[(32, 32), (64, 64)], append_images=[small])
    print(f"wrote icon-64.png, favicon.ico and apple-touch-icon.png to {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
