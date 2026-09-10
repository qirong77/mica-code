#!/usr/bin/env python3
"""Regenerate the mica-code-app icons from resources/icon.svg.

macOS only: uses sips to rasterize the SVG and iconutil to build the .icns.
Pillow is used for supersampled downscaling and PNG re-encoding.

resources/icon.svg 是满幅形态（瓦片铺满 viewBox），也是全仓库唯一的品牌标志：官网、
config-web、README 直接引用同一份文件。这里只负责桌面端需要的位图：

  - 原生图标（.icns/.ico 与 resources/build 下的 icon.png）按 macOS 经典网格补上
    824/1024 的透明外边距——渲染时外扩 viewBox，不动物件本身；
  - 网页图标（tab favicon、iOS 主屏图标、PWA manifest 图标）直接满幅渲染后写进
    src/renderer/public，由 Vite 复制进 renderer 产物。

Usage:
    python3 scripts/generate-icons.py
"""

import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SVG = os.path.join(ROOT, "resources", "icon.svg")
WEB_DIR = os.path.join(ROOT, "src", "renderer", "public")
SS = 4  # supersample factor: render 4x, then downscale with LANCZOS
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)
ICNS_SIZES = (16, 32, 128, 256, 512)
# macOS 经典网格：圆角方块占画布 824/1024，四周留白。icon.svg 本身是满幅的，渲染
# 原生图标时把 viewBox 按这个比例外扩，等价于原来的透明外边距。
NATIVE_TILE_RATIO = 0.8046875
WEB_ICONS = (
    ("favicon-32.png", 32),
    ("apple-touch-icon.png", 180),
    ("icon-192.png", 192),
    ("icon-512.png", 512),
)


def render(size, out, svg=SVG):
    big = size * SS
    tmp = os.path.join(tempfile.gettempdir(), "mica-icon-%d.png" % big)
    subprocess.run(
        ["sips", "-s", "format", "png", "-z", str(big), str(big), svg, "--out", tmp],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    image = Image.open(tmp).convert("RGBA").resize((size, size), Image.LANCZOS)
    os.remove(tmp)
    image.save(out, "PNG", optimize=True, compress_level=9)


def native_svg():
    """把 icon.svg 的 viewBox 外扩到 macOS 经典网格，落到临时文件供 sips 渲染。"""
    with open(SVG, encoding="utf-8") as handle:
        markup = handle.read()
    view_box = re.search(r'viewBox="([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)"', markup)
    if not view_box:
        sys.exit("missing viewBox in %s" % SVG)
    x, y, width, height = (float(value) for value in view_box.groups())
    scale = 1 / NATIVE_TILE_RATIO
    box = (x - width * (scale - 1) / 2, y - height * (scale - 1) / 2, width * scale, height * scale)
    boxed = markup[: view_box.start()] + 'viewBox="%s"' % " ".join(str(round(v, 6)) for v in box) + markup[view_box.end() :]
    path = os.path.join(tempfile.gettempdir(), "mica-icon-native.svg")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(boxed)
    return path


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

    native = native_svg()

    for target in ("resources/icon.png", "build/icon.png"):
        path = os.path.join(ROOT, target)
        render(1024, path, native)
        report(path)

    os.makedirs(WEB_DIR, exist_ok=True)
    for name, size in WEB_ICONS:
        path = os.path.join(WEB_DIR, name)
        render(size, path)
        report(path)

    with tempfile.TemporaryDirectory() as tmp:
        iconset = os.path.join(tmp, "icon.iconset")
        os.makedirs(iconset)
        for size in ICNS_SIZES:
            render(size, os.path.join(iconset, "icon_%dx%d.png" % (size, size)), native)
            render(size * 2, os.path.join(iconset, "icon_%dx%d@2x.png" % (size, size)), native)
        icns = os.path.join(ROOT, "build", "icon.icns")
        subprocess.run(
            ["iconutil", "-c", "icns", iconset, "-o", icns],
            check=True,
        )
        report(icns)

        pngs = []
        for size in ICO_SIZES:
            path = os.path.join(tmp, "ico-%d.png" % size)
            render(size, path, native)
            pngs.append((size, path))
        write_ico(pngs, os.path.join(ROOT, "build", "icon.ico"))


if __name__ == "__main__":
    main()
