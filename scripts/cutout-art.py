# 小语立绘抠底（透明背景）——像网上那种"贴纸/大肥鱼"一样能浮在页面上
# 做法：从四边种子做 floodfill 抠掉连通的背景（带容差）→ 羽化 alpha → 去掉半透明残边 →
#      按内容裁边 + 留白 → 导出 512（高清）与 256（挂件用）+ 一张格子底对照图
import os
from PIL import Image, ImageDraw, ImageFilter, ImageChops

SRC = r"D:\pi-workspace\生成物\图片\2026-09-19"
OUT = r"D:\pi-web\frontend\public\branding"
FRAMES = [
    ("open",     "小语肖像_图片_20260919-144642-458-3ec1879d_v2.86.0.png"),
    ("closed",   "小语肖像_图片_20260919-144654-995-e0acc5c9_v2.86.0.png"),
    ("happy",    "小语肖像_图片_20260919-150839-576-0c104873_v2.86.0.png"),
    ("focused",  "小语肖像_图片_20260919-150852-187-6e176613_v2.86.0.png"),
    ("thinking", "小语肖像_图片_20260919-150905-311-5509d7d9_v2.86.0.png"),
    ("sleepy",   "小语肖像_图片_20260919-150920-177-3830344b_v2.86.0.png"),
    ("wave",     "小语肖像_图片_20260919-150933-502-ccc6af81_v2.86.0.png"),
]

def cutout(path, tol=28):
    im = Image.open(path).convert("RGB")
    w, h = im.size
    # 背景色取样：四角各 12x12 的中位色
    corners = []
    for (cx, cy) in [(6, 6), (w - 18, 6), (6, h - 18), (w - 18, h - 18)]:
        corners.append(im.crop((cx, cy, cx + 12, cy + 12)).resize((1, 1), Image.BOX).getpixel((0, 0)))
    bg = tuple(sorted(c[i] for c in corners)[1] for i in range(3))
    # 用 floodfill 把与种子连通的背景涂成一个不会撞车的标记色
    marker = (255, 0, 255)
    fill = im.copy()
    seeds = [(2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3), (w // 2, 2), (w // 2, h - 3), (2, h // 2), (w - 3, h // 2)]
    for s in seeds:
        ImageDraw.floodfill(fill, s, marker, thresh=tol)
    # 标记色 → 透明
    alpha = Image.new("L", (w, h), 255)
    px_f, px_a = fill.load(), alpha.load()
    for y in range(h):
        for x in range(w):
            if px_f[x, y] == marker:
                px_a[x, y] = 0
    # 羽化 1.2px，再去掉很淡的残边（避免灰边）
    alpha = alpha.filter(ImageFilter.GaussianBlur(1.2))
    alpha = alpha.point(lambda v: 0 if v < 40 else (255 if v > 235 else int((v - 40) * 255 / 195)))
    out = im.convert("RGBA")
    out.putalpha(alpha)
    # 按内容裁边并留 4% 白边（立绘站姿要留脚部空间）
    bbox = out.getbbox()
    if bbox:
        pad = int(max(bbox[2] - bbox[0], bbox[3] - bbox[1]) * 0.04)
        out = out.crop((max(0, bbox[0] - pad), max(0, bbox[1] - pad), min(w, bbox[2] + pad), min(h, bbox[3] + pad)))
    return out, bg

proof = []
for key, name in FRAMES:
    src = os.path.join(SRC, name)
    if not os.path.exists(src):
        print(f"!! 缺源图 {name}")
        continue
    img, bg = cutout(src)
    for size, suffix in [(512, ""), (256, "")]:
        target = img.copy()
        target.thumbnail((size, size), Image.LANCZOS)
        fn = os.path.join(OUT, f"xiaoyu-{key}{'-t' if suffix == '' else suffix}.png")
        target.save(fn)
    print(f"✓ {key}: 背景取样 {bg} → xiaoyu-{key}-t.png（{img.size[0]}×{img.size[1]} 原件 / 512 / 256）")
    proof.append((key, img.copy()))

# 格子底对照图：证明真的是透明，而不是画了灰底
if proof:
    cols, cell = 4, 256
    rows = (len(proof) + cols - 1) // cols
    sheet = Image.new("RGBA", (cols * cell, rows * cell), (255, 255, 255, 255))
    d = ImageDraw.Draw(sheet)
    for yy in range(0, rows * cell, 32):
        for xx in range(0, cols * cell, 32):
            if (xx // 32 + yy // 32) % 2 == 0:
                d.rectangle([xx, yy, xx + 31, yy + 31], fill=(226, 226, 226, 255))
    for i, (key, im) in enumerate(proof):
        im.thumbnail((cell - 16, cell - 16), Image.LANCZOS)
        x = (i % cols) * cell + (cell - im.size[0]) // 2
        y = (i // cols) * cell + (cell - im.size[1]) // 2
        sheet.alpha_composite(im.convert("RGBA"), (x, y))
    p = r"D:\pi-workspace\tmp\xiaoyu-cutout-proof.png"
    sheet.convert("RGB").save(p)
    print("对照图:", p)
