#!/usr/bin/env python3
"""Regenerate the mica-code-app icons from resources/icon.svg.

macOS only: uses sips to rasterize the SVG and iconutil to build the .icns.
Pillow is used for supersampled downscaling and PNG re-encoding.

Usage:
    python3 scripts/generate-icons.py
"""

import os
import shutil
import struct
import subprocess
import sys
import tempfile

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SVG = os.path.join(ROOT, "resources", "icon.svg")
SS = 4  # supersample factor: render 4x, then downscale with LANCZOS
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)
ICNS_SIZES = (16, 32, 128, 256, 512)


def render(size, out):
    big = size * SS
    tmp = os.path.join(tempfile.gettempdir(), "mica-icon-%d.png" % big)
    subprocess.run(
        ["sips", "-s", "format", "png", "-z", str(big), str(big), SVG, "--out", tmp],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    image = Image.open(tmp).convert("RGBA").resize((size, size), Image.LANCZOS)
    os.remove(tmp)
    image.save(out, "PNG", optimize=True, compress_level=9)


def report(path):
    print("%s (%d bytes)" % (os.path.relpath(path, ROOT), os.path.getsize(path)))


def write_ico(pngs, out):
    entries = [(size, open(path, "rb").read()) for size, path in pngs]
    offset = 6 + 16 * len(entries)
    directory = b""
    blobs = b""
    for size, data in entries:
        dim = 0 if size == 256 else size
        directory += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
        blobs += data
    with open(out, "wb") as handle:
        handle.write(struct.pack("<HHH", 0, 1, len(entries)) + directory + blobs)
    report(out)


def main():
    if sys.platform != "darwin":
        sys.exit("generate-icons.py requires macOS (sips + iconutil)")
    if not shutil.which("sips") or not shutil.which("iconutil"):
        sys.exit("missing sips or iconutil in PATH")
    if not os.path.exists(SVG):
        sys.exit("missing %s" % SVG)

    for target in ("resources/icon.png", "build/icon.png"):
        path = os.path.join(ROOT, target)
        render(1024, path)
        report(path)

    with tempfile.TemporaryDirectory() as tmp:
        iconset = os.path.join(tmp, "icon.iconset")
        os.makedirs(iconset)
        for size in ICNS_SIZES:
            render(size, os.path.join(iconset, "icon_%dx%d.png" % (size, size)))
            render(size * 2, os.path.join(iconset, "icon_%dx%d@2x.png" % (size, size)))
        icns = os.path.join(ROOT, "build", "icon.icns")
        subprocess.run(
            ["iconutil", "-c", "icns", iconset, "-o", icns],
            check=True,
        )
        report(icns)

        pngs = []
        for size in ICO_SIZES:
            path = os.path.join(tmp, "ico-%d.png" % size)
            render(size, path)
            pngs.append((size, path))
        write_ico(pngs, os.path.join(ROOT, "build", "icon.ico"))


if __name__ == "__main__":
    main()
