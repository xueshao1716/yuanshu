# 透明立绘抠底（通用版）——把"人物 + 纯色背景"的立绘抠成透明 PNG，能像贴纸一样浮在页面上。
#
# 用法：
#   py scripts/cutout-art.py --src "<源目录>" --out "<输出目录>" --prefix xiaoyu [--tol 28] [--sizes 512,256] [--max 12]
#   py scripts/cutout-art.py --src "D:\...\2026-09-19-3D玩偶小姐姐" --out "D:\pi-web\frontend\public\branding" --prefix doll
#
# 做法：四角取背景色 → 从 8 个边界种子 floodfill（带容差）抠掉连通背景 →
#      alpha 羽化 + 阈值去灰边 → 按内容裁边留白 → 导出透明 PNG（多尺寸）+ 格子底对照图。
# 依赖：Pillow（py -m pip install Pillow）。
import argparse
import os
import re
from PIL import Image, ImageDraw, ImageFilter

ap = argparse.ArgumentParser()
ap.add_argument("--src", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--prefix", required=True)
ap.add_argument("--tol", type=int, default=28)
ap.add_argument("--sizes", default="512,256")
ap.add_argument("--max", type=int, default=16, help="最多处理几张（按文件名排序）")
ap.add_argument("--sheet", default="", help="对照图输出路径")
ap.add_argument("--pad", type=float, default=0.04)
args = ap.parse_args()

SIZES = [int(s) for s in args.sizes.split(",") if s.strip()]
os.makedirs(args.out, exist_ok=True)


def cutout(path, tol):
    im = Image.open(path).convert("RGB")
    w, h = im.size
    corners = [im.crop((cx, cy, cx + 12, cy + 12)).resize((1, 1), Image.BOX).getpixel((0, 0))
               for (cx, cy) in [(6, 6), (w - 18, 6), (6, h - 18), (w - 18, h - 18)]]
    bg = tuple(sorted(c[i] for c in corners)[1] for i in range(3))
    marker = (255, 0, 255)
    fill = im.copy()
    seeds = [(2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3),
             (w // 2, 2), (w // 2, h - 3), (2, h // 2), (w - 3, h // 2)]
    for s in seeds:
        ImageDraw.floodfill(fill, s, marker, thresh=tol)
    alpha = Image.new("L", (w, h), 255)
    pf, pa = fill.load(), alpha.load()
    for y in range(h):
        for x in range(w):
            if pf[x, y] == marker:
                pa[x, y] = 0
    alpha = alpha.filter(ImageFilter.GaussianBlur(1.2))
    alpha = alpha.point(lambda v: 0 if v < 40 else (255 if v > 235 else int((v - 40) * 255 / 195)))
    out = im.convert("RGBA")
    out.putalpha(alpha)
    bbox = out.getbbox()
    if bbox:
        pad = int(max(bbox[2] - bbox[0], bbox[3] - bbox[1]) * args.pad)
        out = out.crop((max(0, bbox[0] - pad), max(0, bbox[1] - pad),
                        min(w, bbox[2] + pad), min(h, bbox[3] + pad)))
    return out, bg


files = sorted(f for f in os.listdir(args.src) if f.lower().endswith((".png", ".jpg", ".jpeg", ".webp")))
if args.max:
    files = files[:args.max]
proof = []
for i, name in enumerate(files):
    src = os.path.join(args.src, name)
    try:
        img, bg = cutout(src, args.tol)
    except Exception as e:
        print(f"!! {name}: {e}")
        continue
    tag = f"{args.prefix}-{i + 1:02d}"
    for size in SIZES:
        t = img.copy()
        t.thumbnail((size, size), Image.LANCZOS)
        suffix = "" if size == SIZES[0] else f"-{size}"
        t.save(os.path.join(args.out, f"{tag}{suffix}.png"))
    print(f"✓ {tag} ← {name[:44]} (bg {bg}, {img.size[0]}×{img.size[1]})")
    proof.append((tag, img.copy()))

if proof:
    cols, cell = 4, 256
    rows = (len(proof) + cols - 1) // cols
    sheet = Image.new("RGBA", (cols * cell, rows * cell), (255, 255, 255, 255))
    d = ImageDraw.Draw(sheet)
    for yy in range(0, rows * cell, 32):
        for xx in range(0, cols * cell, 32):
            if (xx // 32 + yy // 32) % 2 == 0:
                d.rectangle([xx, yy, xx + 31, yy + 31], fill=(226, 226, 226, 255))
    for i, (tag, im) in enumerate(proof):
        im.thumbnail((cell - 16, cell - 16), Image.LANCZOS)
        sheet.alpha_composite(im.convert("RGBA"),
                              ((i % cols) * cell + (cell - im.size[0]) // 2,
                               (i // cols) * cell + (cell - im.size[1]) // 2))
    p = args.sheet or os.path.join("D:\\pi-workspace\\tmp", f"{args.prefix}-cutout-proof.png")
    sheet.convert("RGB").save(p)
    print("对照图:", p)
