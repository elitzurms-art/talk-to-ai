#!/usr/bin/env python3
"""יוצר אייקוני PWA (192/512) — רקע כהה עם 'גלי שידור' תכלת. ללא ספריות חיצוניות."""
import math
import struct
import zlib


def write_png(path, size, pixels):
    def chunk(typ, data):
        return (struct.pack(">I", len(data)) + typ + data +
                struct.pack(">I", zlib.crc32(typ + data) & 0xffffffff))
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter: none
        raw += pixels[y * size * 3:(y + 1) * size * 3]
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)


def make(size, path):
    bg = (15, 23, 42)        # #0f172a
    c1 = (56, 189, 248)      # תכלת
    cx = cy = size / 2.0
    px = bytearray(size * size * 3)
    # רדיוסים יחסיים: נקודה מרכזית + שני טבעות (גלי שידור)
    dot = 0.10 * size
    rings = [(0.20, 0.245), (0.32, 0.365), (0.44, 0.485)]
    for y in range(size):
        for x in range(size):
            r = math.hypot(x - cx, y - cy)
            col = bg
            if r <= dot:
                col = c1
            else:
                for lo, hi in rings:
                    if lo * size <= r <= hi * size:
                        col = c1
                        break
            i = (y * size + x) * 3
            px[i], px[i + 1], px[i + 2] = col
    write_png(path, size, px)
    print("נוצר", path)


make(192, "icon-192.png")
make(512, "icon-512.png")
