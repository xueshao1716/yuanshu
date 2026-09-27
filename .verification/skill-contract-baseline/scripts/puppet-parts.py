# 木偶切件：把"正面中性站姿 + 四肢留空隙"的立绘切成可动部件（头/躯干/左臂/右臂/左腿/右腿）
# 思路：alpha 轮廓分析找关节行（脖子=上部最窄行，髋=中部最窄行；腿缝=底部最大透明列间隙），
#      再按这些线切件；每件留 2% 重叠并羽化 3px，避免拼接缝。
# 用法：py scripts/puppet-parts.py --src <图> --out <目录> --name xiaoyu [--closed <闭眼图>]
import argparse, json, os
from PIL import Image, ImageDraw, ImageFilter

ap = argparse.ArgumentParser()
ap.add_argument("--src", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--name", required=True)
ap.add_argument("--closed", default="", help="闭眼版的同一姿势图（切出 head_closed 用于眨眼）")
args = ap.parse_args()
os.makedirs(args.out, exist_ok=True)

im = Image.open(args.src).convert("RGBA")
W, H = im.size
alpha = im.getchannel("A")
px = alpha.load()

def row_width(y):
    xs = [x for x in range(W) if px[x, y] > 24]
    return (min(xs), max(xs), len(xs)) if xs else (0, 0, 0)

box = im.getbbox() or (0, 0, W, H)
top, bottom = box[1], box[3]
height = bottom - top

# 脖子：上部 10%~30% 里最窄的一行
neck = min(range(top + int(height * 0.10), top + int(height * 0.32)), key=lambda y: row_width(y)[2])
# 髋：中部 42%~66% 里最窄的一行
hip = min(range(top + int(height * 0.42), top + int(height * 0.66)), key=lambda y: row_width(y)[2])
# 腿缝：髋以下，找一条竖直透明带（该列在髋~底之间几乎全透明）
seam = None
cand = []
for x in range(W):
    ys = range(hip, bottom, 2)
    empty = sum(1 for y in ys if px[x, y] <= 24)
    if empty >= len(list(ys)) * 0.85:
        cand.append(x)
if cand:
    # 取中间那段连续区间的中心
    mid = sorted(cand)[len(cand) // 2]
    seam = mid

parts = {}
def cut(name, bx, pivot):
    x0, y0, x1, y1 = bx
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(W, x1), min(H, y1)
    piece = im.crop((x0, y0, x1, y1))
    # 边缘羽化一点点，拼回去不留硬缝
    a = piece.getchannel("A").filter(ImageFilter.GaussianBlur(0.8))
    piece.putalpha(a)
    fn = f"{args.name}-{name}.png"
    piece.save(os.path.join(args.out, fn))
    parts[name] = {"file": fn, "w": x1 - x0, "h": y1 - y0,
                   "pivot": [round(pivot[0] - x0, 1), round(pivot[1] - y0, 1)],
                   "at": [round(x0, 1), round(y0, 1)]}
    print(f"  · {name}: {x1-x0}×{y1-y0}  pivot={parts[name]['pivot']}")

ov = int(height * 0.02)
lw = row_width(neck + int(height * 0.12))
# 头（含耳机）＋脖子
cut("head", (box[0], top, box[2], neck + ov), (W / 2, neck))
# 躯干（连帽卫衣，含肩）
torso_x0, torso_x1 = row_width(neck + int(height * 0.18))[0], row_width(neck + int(height * 0.18))[1]
cut("torso", (box[0], neck - ov, box[2], hip + ov), (W / 2, hip))
if seam:
    cut("legL", (box[0], hip - ov, seam + 2, bottom), (seam / 2, hip))
    cut("legR", (seam - 2, hip - ov, box[2], bottom), (seam / 2, hip))
else:
    cut("legs", (box[0], hip - ov, box[2], bottom), (W / 2, hip))
# 手臂：逐行找"连通段"，每行最左段归左臂、最右段归右臂（必须 ≥3 段才认，否则那行手臂与躯干连着）
def runs(y):
    out, start = [], None
    for x in range(W):
        on = px[x, y] > 24
        if on and start is None: start = x
        if not on and start is not None: out.append((start, x - 1)); start = None
    if start is not None: out.append((start, W - 1))
    return [r for r in out if r[1] - r[0] >= 3]

arm_top = neck + int(height * 0.06)
arm_bottom = min(bottom, hip + int(height * 0.08))
L, R = [], []
for y in range(arm_top, arm_bottom):
    rs = runs(y)
    if len(rs) >= 3:
        L.append((y, rs[0][0], rs[0][1]))
        R.append((y, rs[-1][0], rs[-1][1]))

def cut_column(name, rows, side):
    if len(rows) < 6:
        print(f"  · {name}: 跳过（只有 {len(rows)} 行是分离的）"); return
    ys = [r[0] for r in rows]
    x0 = min(r[1] for r in rows); x1 = max(r[2] for r in rows)
    y0, y1 = min(ys), max(ys) + 1
    cut(name, (x0, y0, x1 + 1, y1), (rows[0][1] if side == "L" else rows[0][2], y0))

cut_column("armL", L, "L")
cut_column("armR", R, "R")

# 闭眼头：从闭眼图切同一区域，运行时叠在 head 上（眨眼）
if args.closed and os.path.exists(args.closed):
    im2 = Image.open(args.closed).convert("RGBA")
    if im2.size != im.size:
        im2 = im2.resize(im.size, Image.LANCZOS)
    hx0, hy0 = parts["head"]["at"]
    hw, hh = parts["head"]["w"], parts["head"]["h"]
    head_closed = im2.crop((int(hx0), int(hy0), int(hx0) + hw, int(hy0) + hh))
    head_closed.save(os.path.join(args.out, f"{args.name}-head_closed.png"))
    print(f"  · head_closed: {hw}×{hh}（眨眼用）")

meta = {"name": args.name, "size": [W, H], "neck": neck, "hip": hip, "seam": seam, "parts": parts}
with open(os.path.join(args.out, f"{args.name}-puppet.json"), "w", encoding="utf-8") as f:
    json.dump(meta, f, ensure_ascii=False, indent=2)
print(f"关节行：neck={neck} hip={hip} seam={seam}")
print("输出:", args.out)

# 对照图：每件单独放一格
if parts:
    cell = 220
    names = list(parts.keys())
    sheet = Image.new("RGBA", (cell * len(names), cell), (255, 255, 255, 255))
    d = ImageDraw.Draw(sheet)
    for yy in range(0, cell, 20):
        for xx in range(0, cell * len(names), 20):
            if (xx // 20 + yy // 20) % 2 == 0:
                d.rectangle([xx, yy, xx + 19, yy + 19], fill=(228, 228, 228, 255))
    for i, n in enumerate(names):
        p = Image.open(os.path.join(args.out, parts[n]["file"]))
        p.thumbnail((cell - 10, cell - 10), Image.LANCZOS)
        sheet.alpha_composite(p, (i * cell + (cell - p.size[0]) // 2, (cell - p.size[1]) // 2))
    sp = f"D:\\pi-workspace\\tmp\\{args.name}-parts-proof.png"
    sheet.convert("RGB").save(sp)
    print("对照图:", sp)
