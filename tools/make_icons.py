#!/usr/bin/env python3
"""Generate the extension icons.

A 3x3 dot grid with the middle top and bottom dots left out, so the remaining seven form
an H. Deliberately not Tailscale's mark: theirs is a full nine-dot grid, and shipping
something that reads as it under someone else's name would be wrong. The grid shape keeps
a family resemblance without borrowing the logo.

Regenerate with: python3 tools/make_icons.py
"""

import struct
import zlib
from pathlib import Path

ICONS = Path(__file__).resolve().parent.parent / "icons"

BACKGROUND = (32, 33, 38, 255)
FOREGROUND = (245, 246, 250, 255)

# The two gaps that turn a grid into an H.
OMIT = {(1, 0), (1, 2)}


def render(size):
    pixels = [[(0, 0, 0, 0)] * size for _ in range(size)]
    radius = size * 0.22

    for y in range(size):
        for x in range(size):
            dx = max(radius - x, 0, x - (size - 1 - radius))
            dy = max(radius - y, 0, y - (size - 1 - radius))
            if dx * dx + dy * dy <= radius * radius:
                pixels[y][x] = BACKGROUND

    # Optical sizing. Dots of any useful radius turn square below about 32px, and the
    # middle row then reads as a plus rather than an H. At small sizes the same letter is
    # drawn with solid strokes, which survives.
    if size < 32:
        draw_strokes(pixels, size)
    else:
        draw_dots(pixels, size)
    return pixels


def draw_dots(pixels, size):
    dot_radius = size * 0.082
    for gx in range(3):
        for gy in range(3):
            if (gx, gy) in OMIT:
                continue
            cx = size * (0.28 + 0.22 * gx)
            cy = size * (0.28 + 0.22 * gy)
            for y in range(size):
                for x in range(size):
                    if (x - cx) ** 2 + (y - cy) ** 2 <= dot_radius * dot_radius:
                        pixels[y][x] = FOREGROUND


def draw_strokes(pixels, size):
    def fill(x0, y0, x1, y1):
        for y in range(max(0, round(y0)), min(size, round(y1))):
            for x in range(max(0, round(x0)), min(size, round(x1))):
                pixels[y][x] = FOREGROUND

    stroke = max(2, round(size * 0.14))
    top, bottom = size * 0.26, size * 0.74
    left, right = size * 0.28, size * 0.72
    fill(left, top, left + stroke, bottom)              # left upright
    fill(right - stroke, top, right, bottom)            # right upright
    mid = (top + bottom) / 2
    fill(left, mid - stroke / 2, right, mid + stroke / 2)  # crossbar


def write_png(path, pixels, size):
    raw = b"".join(
        b"\x00" + b"".join(struct.pack("4B", *pixels[y][x]) for x in range(size))
        for y in range(size)
    )

    def chunk(tag, data):
        body = struct.pack(">I", len(data)) + tag + data
        return body + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


if __name__ == "__main__":
    for size in (16, 48, 128):
        target = ICONS / f"icon{size}.png"
        write_png(target, render(size), size)
        print(f"wrote {target.relative_to(ICONS.parent)} ({size}x{size})")
