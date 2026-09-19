# 自动标框 v2：把手臂/腿各拆两段（上臂+小臂、大腿+小腿）
# —— 11 个部件：head, upperArmL/R, foreArmL/R, torso, thighL/R, shinL/R（走路/挥手才有多关节的层次）
# 用法：py scripts/puppet-autorig.py --src <T字形透明立绘.png> --out <labels.json> [--image xiaoyu-stand]
import argparse, json
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument("--src", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--image", default="")
ap.add_argument("--tol", type=int, default=24)
ap.add_argument("--elbow", type=float, default=0.55, help="上臂占手臂长度的比例（从肩端算）")
ap.add_argument("--knee", type=float, default=0.52, help="大腿占腿长的比例（从髋端算）")
args = ap.parse_args()

im = Image.open(args.src).convert("RGBA")
W, H = im.size
a = im.getchannel("A").load()
x0, y0, x1, y1 = im.getbbox()
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


hip = min(range(y0 + int(Hc * 0.42), y0 + int(Hc * 0.68)), key=lambda y: width(y)[2] or 10 ** 6)
best_y, best_w = y0 + int(Hc * 0.10), 0
for y in range(y0 + int(Hc * 0.06), min(y1, y0 + int(Hc * 0.45))):
    w = width(y)[2]
    if w > best_w: best_w, best_y = w, y
arm_top = max(y0 + int(Hc * 0.06), best_y - int(Hc * 0.035))
arm_bottom = min(hip, best_y + int(Hc * 0.035))
neck = arm_top
body_x0, body_x1, _ = width(hip)
seam, best = None, -1
for x in range(body_x0, body_x1):
    cnt = sum(1 for y in range(hip, y1, 2) if a[x, y] <= args.tol)
    if cnt > best: best, seam = cnt, x
if seam is None or best < 3: seam = (body_x0 + body_x1) // 2

parts = []
def add(pid, bx0, by0, bx1, by1, pivot, exclude=None):
    parts.append({"id": pid, "box": [bx0, by0, bx1, by1], "pivot": pivot, "auto": True, **({"exclude": exclude} if exclude else {})})

add("head", x0, y0, x1, neck, [0.5, 1.0])
add("torso", x0, neck, x1, hip, [0.5, 1.0], exclude=["upperArmL", "foreArmL", "upperArmR", "foreArmR"])

for side, ax0, ax1 in (("L", x0, body_x0), ("R", body_x1, x1)):
    w = ax1 - ax0
    if side == "L":
        upx0, upx1 = ax1 - int(w * args.elbow), ax1
        fox0, fox1 = ax0, ax1 - int(w * args.elbow) + 4
        up_pivot, fo_pivot = [1.0, 0.5], [1.0, 0.5]
    else:
        upx0, upx1 = ax0, ax0 + int(w * args.elbow)
        fox0, fox1 = ax0 + int(w * args.elbow) - 4, ax1
        up_pivot, fo_pivot = [0.0, 0.5], [0.0, 0.5]
    add(f"upperArm{side}", upx0, arm_top, upx1, arm_bottom, up_pivot)
    add(f"foreArm{side}", fox0, arm_top, fox1, arm_bottom, fo_pivot)

for side, lx0, lx1 in (("L", x0, seam), ("R", seam, x1)):
    knee = hip + int((y1 - hip) * args.knee)
    add(f"thigh{side}", lx0, hip, lx1, knee + 4, [0.5, 0.0])
    add(f"shin{side}", lx0, knee - 4, lx1, y1, [0.5, 0.0])

out = {"image": args.image or "", "size": [W, H], "parts": []}
for p in parts:
    bx0, by0, bx1, by1 = p["box"]
    out["parts"].append({**p, "box": [round(bx0 / W, 4), round(by0 / H, 4), round(bx1 / W, 4), round(by1 / H, 4)]})
    print(f"  · {p['id']}: {bx1-bx0}×{by1-by0} @({bx0},{by0}) pivot={p['pivot']}")
json.dump(out, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(f"关节：肩线={neck} 髋={hip} 腿缝={seam}｜部件数={len(parts)}")
print("已写:", args.out)
