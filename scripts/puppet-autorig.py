# 自动标框：从"T 字形纸片人"立绘里用 alpha 轮廓解析出 6 个部件框 → 直接写 labels.json
# （和标注页保存的格式一致，pivot 用 [x,y] 归一化到框内，精确到肩/髋/颈）
# 用法：py scripts/puppet-autorig.py --src <透明立绘png> --out <labels.json> [--image xiaoyu-stand]
import argparse, json
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument("--src", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--image", default="")
ap.add_argument("--tol", type=int, default=24)
args = ap.parse_args()

im = Image.open(args.src).convert("RGBA")
W, H = im.size
a = im.getchannel("A").load()
box = im.getbbox()
x0, y0, x1, y1 = box
Hc = y1 - y0

def runs(y):
    out, start = [], None
    for x in range(W):
        on = a[x, y] > args.tol
        if on and start is None: start = x
        if not on and start is not None:
            if x - start >= 3: out.append((start, x - 1))
            start = None
    if start is not None and W - start >= 3: out.append((start, W - 1))
    return out

def width(y):
    rs = runs(y)
    return (rs[0][0], rs[-1][1], rs[-1][1] - rs[0][0]) if rs else (0, 0, 0)

# 1) 脖子：上部 8%~30% 最窄的一行；髋：中部 42%~68% 最窄的一行
hip = min(range(y0 + int(Hc * 0.42), y0 + int(Hc * 0.68)), key=lambda y: width(y)[2] or 10 ** 6)
neck = None  # 下面用手臂带上沿来定（"上部最窄行"会落在猫耳和脸之间，把头切残）

# 2) 手臂带：从脖子往下找"明显比躯干宽"的行段（T 字形的手臂），取最宽那一行定肩膀高度
body_x0, body_x1, _ = width(hip)
best_y, best_w = y0 + int(Hc * 0.10), 0
for y in range(y0 + int(Hc * 0.06), min(y1, y0 + int(Hc * 0.45))):
    w = width(y)[2]
    if w > best_w: best_w, best_y = w, y
arm_top = max(y0 + int(Hc * 0.06), best_y - int(Hc * 0.035))
if neck is None: neck = arm_top   # 肩线＝手臂带上沿
arm_bottom = min(hip, best_y + int(Hc * 0.035))
armL_x1 = body_x0
armR_x0 = body_x1

# 3) 腿缝：髋以下找一条几乎全透明的竖直带
seam, best = None, -1
for x in range(body_x0, body_x1):
    cnt = sum(1 for y in range(hip, y1, 2) if a[x, y] <= args.tol)
    if cnt > best: best, seam = cnt, x
if seam is None or best < 3:
    seam = (body_x0 + body_x1) // 2

parts = [
    ("head",  (x0, y0, x1, neck),                                   (0.5, 1.0)),
    ("armL",  (x0, arm_top, armL_x1, arm_bottom),                    (1.0, 0.5)),
    ("armR",  (armR_x0, arm_top, x1, arm_bottom),                    (0.0, 0.5)),
    ("torso", (x0, neck, x1, hip),                                  (0.5, 1.0)),
    ("legL",  (x0, hip, seam, y1),                                  (0.5, 0.0)),
    ("legR",  (seam, hip, x1, y1),                                  (0.5, 0.0)),
]
out = {"image": args.image or "", "size": [W, H], "parts": []}
for pid, (bx0, by0, bx1, by1), (px, py) in parts:
    bw, bh = max(1, bx1 - bx0), max(1, by1 - by0)
    out["parts"].append({
        "id": pid,
        "box": [round(bx0 / W, 4), round(by0 / H, 4), round(bx1 / W, 4), round(by1 / H, 4)],
        "pivot": [round(px, 3), round(py, 3)],   # 归一化到框内：0=左/上，1=右/下
        "auto": True,
        **({"exclude": ["armL", "armR"]} if pid == "torso" else {}),
    })
    print(f"  · {pid}: {bw}×{bh}  @({bx0},{by0})  pivot={px},{py}")
json.dump(out, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(f"关节：neck={neck} hip={hip} seam={seam} 手臂带={arm_top}~{arm_bottom}")
print("已写:", args.out)
