#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
元枢图标生成器 — 三向枢纽几何，科技感/未来感
输出：icon-512.png / icon-192.png / icon-maskable-512.png / yuanshu-app-icon.png / icon.ico
"""
import math, os, struct, zlib
from PIL import Image, ImageDraw, ImageFilter

ACCENT   = (84, 104, 255)      # #5468ff
ACCENT2  = (120, 180, 255)     # 高光蓝
BG       = (10, 14, 26)        # #0a0e1a 深空
GLOW1    = (84, 104, 255, 90)  # 外晕
GLOW2    = (84, 104, 255, 40)  # 远晕
WHITE    = (255, 255, 255)
DIM      = (160, 180, 220)


def lerp_color(c1, c2, t):
    return tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(len(c1)))


def draw_icon(size: int, maskable: bool = False) -> Image.Image:
    S = size
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    cx, cy = S // 2, S // 2
    bg_r = int(S // 2 * (0.90 if maskable else 1.0))

    # ── 背景：纯净深空，中心略亮 ──────────────────────────────
    for i in range(bg_r, 0, -1):
        t = 1.0 - (i / bg_r)          # 0=边缘 1=中心
        bright = int(t * t * 22)       # 中心微微提亮
        c = (10 + bright, 14 + bright, 26 + bright, 255)
        draw.ellipse([cx - i, cy - i, cx + i, cy + i], fill=c)

    # ── 外圈：极细，仅提示边界 ────────────────────────────────
    ring_r = int(bg_r * 0.87)
    lw = max(1, S // 200)
    draw.ellipse([cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r],
                 outline=(*ACCENT, 45), width=lw)
    # 三轴对齐位置各一个刻度点（只留 3 个，不做 12 个）
    for deg in [270, 30, 150]:
        angle = math.radians(deg)
        px = cx + math.cos(angle) * ring_r
        py = cy + math.sin(angle) * ring_r
        dr = max(2, S // 80)
        draw.ellipse([px - dr, py - dr, px + dr, py + dr], fill=(*ACCENT, 130))

    # ── 三向主轴线 ────────────────────────────────────────────
    axes   = [270, 30, 150]
    inner  = int(bg_r * 0.16)    # 从中心核外缘出发
    outer  = int(bg_r * 0.65)    # 线末端
    lw_main = max(2, S // 70)

    for idx, deg in enumerate(axes):
        angle  = math.radians(deg)
        x1 = cx + math.cos(angle) * inner
        y1 = cy + math.sin(angle) * inner
        x2 = cx + math.cos(angle) * outer
        y2 = cy + math.sin(angle) * outer

        # 主轴（上轴最亮，两侧轴稍暗）
        alpha_line = 210 if idx == 0 else 140
        draw.line([(x1, y1), (x2, y2)],
                  fill=(*ACCENT, alpha_line), width=lw_main)

        # 末端节点：实心 + 单层柔光晕
        ep_r  = max(3, S // 52) if idx == 0 else max(2, S // 65)
        halo  = int(ep_r * 2.2)
        ea    = 200 if idx == 0 else 145
        draw.ellipse([x2 - halo, y2 - halo, x2 + halo, y2 + halo],
                     fill=(*ACCENT, 30))
        draw.ellipse([x2 - ep_r, y2 - ep_r, x2 + ep_r, y2 + ep_r],
                     fill=(*ACCENT, ea))
        # 上轴顶端高光点
        if idx == 0:
            hl = max(1, ep_r // 2)
            draw.ellipse([x2 - hl, y2 - hl, x2 + hl, y2 + hl],
                         fill=(210, 225, 255, 230))

    # ── 三段弧（只在三轴之间，30° 短弧，暗示连接） ────────────
    arc_r = int(bg_r * 0.40)
    arc_w = max(1, S // 180)
    for start, end in [(300, 330), (60, 90), (180, 210)]:
        draw.arc([cx - arc_r, cy - arc_r, cx + arc_r, cy + arc_r],
                 start=start, end=end,
                 fill=(*ACCENT2, 60), width=arc_w)

    # ── 中心核：小而亮 ────────────────────────────────────────
    core_r = max(3, S // 38)
    # 中心大光晕（模糊叠加）
    glow_layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(glow_layer).ellipse(
        [cx - core_r * 5, cy - core_r * 5, cx + core_r * 5, cy + core_r * 5],
        fill=(*ACCENT, 50))
    glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(radius=S // 14))
    img = Image.alpha_composite(img, glow_layer)
    draw = ImageDraw.Draw(img)

    # 核实心
    draw.ellipse([cx - core_r, cy - core_r, cx + core_r, cy + core_r],
                 fill=(*ACCENT2, 255))
    # 核高光
    hl = max(1, core_r // 2)
    off = core_r // 3
    draw.ellipse([cx - off - hl, cy - off - hl, cx - off + hl, cy - off + hl],
                 fill=(255, 255, 255, 210))

    # ── 裁圆（非 maskable）────────────────────────────────────
    if not maskable:
        circle_mask = Image.new("L", (S, S), 0)
        ImageDraw.Draw(circle_mask).ellipse([0, 0, S - 1, S - 1], fill=255)
        img.putalpha(circle_mask)

    return img


def make_ico(images: list, path: str):
    """手工组装 ICO（支持 RGBA PNG 压缩格式）"""
    entries = []
    png_datas = []
    for img in images:
        import io
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        png_data = buf.getvalue()
        png_datas.append(png_data)
        w, h = img.size
        entries.append((w if w < 256 else 0, h if h < 256 else 0, len(png_data)))

    header = struct.pack("<HHH", 0, 1, len(entries))
    offset = 6 + len(entries) * 16
    dir_entries = b""
    for i, (w, h, size) in enumerate(entries):
        dir_entries += struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, size, offset)
        offset += size
    with open(path, "wb") as f:
        f.write(header + dir_entries)
        for d in png_datas:
            f.write(d)


if __name__ == "__main__":
    OUT_PUBLIC  = "D:/pi-web/public/icons"
    OUT_BRAND   = "D:/pi-web/public/branding"
    OUT_FBRAND  = "D:/pi-web/frontend/public/icons"
    OUT_FBRAND2 = "D:/pi-web/frontend/public/branding"
    OUT_TAURI   = "D:/pi-web/app/src-tauri/icons"

    print("生成图标中…")

    icon512   = draw_icon(512,  maskable=False)
    maskable  = draw_icon(512,  maskable=True)
    icon192   = draw_icon(192,  maskable=False)
    icon32    = draw_icon(32,   maskable=False)
    icon16    = draw_icon(16,   maskable=False)
    app_icon  = draw_icon(128,  maskable=False)   # rail 用，按 128 生成再展示

    def save(img, *paths):
        for p in paths:
            os.makedirs(os.path.dirname(p), exist_ok=True)
            img.save(p, "PNG")
            print(f"  ✓ {p}")

    OUT_APPDIST  = "D:/pi-web/app/dist"
    OUT_FEDIST   = "D:/pi-web/frontend/dist"

    # icon-512 / icon-192
    save(icon512,  f"{OUT_PUBLIC}/icon-512.png",  f"{OUT_FBRAND}/icon-512.png",  f"{OUT_APPDIST}/icons/icon-512.png",  f"{OUT_FEDIST}/icons/icon-512.png")
    save(icon192,  f"{OUT_PUBLIC}/icon-192.png",  f"{OUT_FBRAND}/icon-192.png",  f"{OUT_APPDIST}/icons/icon-192.png",  f"{OUT_FEDIST}/icons/icon-192.png")
    save(maskable, f"{OUT_PUBLIC}/icon-maskable-512.png", f"{OUT_FBRAND}/icon-maskable-512.png", f"{OUT_APPDIST}/icons/icon-maskable-512.png", f"{OUT_FEDIST}/icons/icon-maskable-512.png")

    # yuanshu-app-icon（rail 顶部 28px 展示用，存 128px 让浏览器缩放）
    save(app_icon,
         f"{OUT_BRAND}/yuanshu-app-icon.png",
         f"{OUT_FBRAND2}/yuanshu-app-icon.png",
         f"{OUT_APPDIST}/branding/yuanshu-app-icon.png")

    # Tauri
    if os.path.isdir(OUT_TAURI):
        save(icon512,  f"{OUT_TAURI}/icon-512.png", f"{OUT_TAURI}/icon.png")
        save(icon192,  f"{OUT_TAURI}/icon-192.png")
        ico_path = f"{OUT_TAURI}/icon.ico"
        make_ico([icon32, icon16], ico_path)
        print(f"  ✓ {ico_path}")
    else:
        print(f"  skip tauri（目录不存在）")

    print("完成。")
