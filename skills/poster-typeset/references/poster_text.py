# -*- coding: utf-8 -*-
"""
poster_text.py —— AI 底图 + 代码艺术字 合成流水线

用途：AI 出的「无字底图」交到这里，用代码叠中文标题/副标题/信息条。
      AI 只负责画，字永远由代码渲染 —— 杜绝乱码。

用法：python 工具/poster_text.py <spec.json>

spec.json 结构：
{
  "base":  "生成物/图片/.../无字底图.png",
  "out":   "生成物/图片/.../艺术字成品.png",
  "canvas": [1080, 1620],          // 目标画布；比底图高则自动接纸
  "paper_sample_rows": 120,        // 取样底部多少行判断纸色
  "elements": [ ... ]
}

element 支持 type: text / rule / specks
  text : {"type":"text","text":"第七个夏天","font":"simhei","size":175,
          "tracking":14,"color":"#C1121F","xy":[540,1240],"anchor":"mm",
          "jitter":{"rot":1.2,"dx":3,"dy":4},           // 手工活字抖动
          "ghost":{"color":"#1B4F9C","offset":[-8,7],"alpha":210}, // 套色错位
          "inkbleed":0.35,                              // 油墨不匀强度
          "shadow":{"color":"#000000","offset":[3,4],"alpha":60}}
  rule : {"type":"rule","xy":[[120,1420],[960,1420]],"width":2,"color":"#2B2B2B","alpha":120}
  specks:{"type":"specks","box":[120,1400,960,1560],"count":40,"color":"#2B2B2B","alpha":70}
"""
import json
import os
import random
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

FONT_DIR = r"C:\Windows\Fonts"
FONTS = {
    "simhei": "simhei.ttf",
    "msyh": "msyh.ttc",
    "msyhbd": "msyhbd.ttc",
    "msyhl": "msyhl.ttc",
    "simsun": "simsun.ttc",
    "deng": "Deng.ttf",
    "dengb": "Dengb.ttf",
}

ANCHOR_MAP = {
    "lt": "la", "mt": "ma", "rt": "ra",
    "lm": "lm", "mm": "mm", "rm": "rm",
    "lb": "ld", "mb": "md", "rb": "rd",
    "ls": "ls", "ms": "ms", "rs": "rs",
}


def hex2rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def load_font(name, size):
    path = os.path.join(FONT_DIR, FONTS.get(name, name))
    return ImageFont.truetype(path, size)


def text_size(text, font):
    box = font.getbbox(text)
    return box[2] - box[0], box[3] - box[1]


def tracked_width(text, font, tracking):
    return sum(font.getlength(c) for c in text) + tracking * max(0, len(text) - 1)


def render_char(ch, font, color, inkbleed=0.0, seed=0):
    """单字渲染成一张紧贴字宽的小图。返回 (图, 步进宽, 行高)。
    margin 只用于旋转留边，不计入排版宽度 —— 之前在字号里混了边距，
    导致标题横向溢出半屏。"""
    adv = font.getlength(ch)
    asc, desc = font.getmetrics()
    line_h = asc + desc
    margin = max(4, int(font.size * 0.16))
    tile = Image.new("RGBA", (int(adv) + margin * 2, line_h + margin * 2), (0, 0, 0, 0))
    ImageDraw.Draw(tile).text((margin, margin), ch, font=font,
                              fill=(255, 255, 255, 255), anchor="la")
    mask = tile.split()[3]
    if inkbleed:
        mask = make_ink_bleed(mask, inkbleed, seed)
    solid = Image.new("RGBA", tile.size, (*color, 255))
    out = Image.new("RGBA", tile.size, (0, 0, 0, 0))
    out.paste(solid, (0, 0), mask)
    out.putalpha(mask)
    return out, adv, line_h


def make_ink_bleed(mask, strength, seed=0):
    """油墨不匀：用噪声啃掉一部分笔画的 alpha。"""
    if strength <= 0:
        return mask
    rnd = random.Random(seed)
    noise = Image.effect_noise(mask.size, 96).convert("L")
    noise = noise.point(lambda v: 255 if v > 150 - int(strength * 90) else 0)
    noise = noise.filter(ImageFilter.GaussianBlur(0.8))
    out = ImageChops.subtract(mask, ImageChops.multiply(noise, mask.point(lambda v: int(v * strength))))
    return out


def draw_text_element(canvas, el, seed=1):
    font = load_font(el.get("font", "simhei"), el["size"])
    text = el["text"]
    tracking = el.get("tracking", 0)
    color = hex2rgb(el["color"])
    alpha = el.get("alpha", 255)
    jitter = el.get("jitter") or {}
    rnd = random.Random(seed)

    tiles, advs = [], []
    for i, ch in enumerate(text):
        tile, adv, line_h = render_char(ch, font, color, el.get("inkbleed", 0), seed * 31 + i)
        if jitter.get("rot"):
            tile = tile.rotate(rnd.uniform(-jitter["rot"], jitter["rot"]),
                               resample=Image.BICUBIC, expand=True)
        tiles.append(tile)
        advs.append(adv)

    total_w = sum(advs) + tracking * max(0, len(text) - 1)
    line_h = max(font.getmetrics()) + font.getmetrics()[1]

    layer = Image.new("RGBA", (int(total_w) + 200, line_h + 200), (0, 0, 0, 0))
    x = 0.0
    for t, adv in zip(tiles, advs):
        dx = rnd.randint(-jitter["dx"], jitter["dx"]) if jitter.get("dx") else 0
        dy = rnd.randint(-jitter["dy"], jitter["dy"]) if jitter.get("dy") else 0
        # 以「字身中心」对齐，旋转 expand 后也能咬住基线
        cx = 100 + x + adv / 2 + dx
        cy = 100 + line_h / 2 + dy
        layer.alpha_composite(t, (int(cx - t.width / 2), int(cy - t.height / 2)))
        x += adv + tracking

    if alpha < 255:
        a = layer.split()[3].point(lambda v: int(v * alpha / 255))
        layer.putalpha(a)

    # 套色错位：幽灵层（先画，压在下面）
    ghost = el.get("ghost")
    if ghost:
        gc = hex2rgb(ghost["color"])
        g = Image.new("RGBA", layer.size, (0, 0, 0, 0))
        solid = Image.new("RGBA", layer.size, (*gc, 255))
        g.paste(solid, (0, 0), layer.split()[3])
        g.putalpha(layer.split()[3].point(lambda v: int(v * ghost.get("alpha", 200) / 255)))
        g = g.filter(ImageFilter.GaussianBlur(ghost.get("blur", 0.7)))

    shadow = el.get("shadow")

    # 定位
    aw, ah = ANCHOR_MAP.get(el.get("anchor", "mm"), "mm")
    cx, cy = el["xy"]
    if "l" in aw:
        px = cx - 100
    elif "m" in aw and aw.startswith("m") or aw in ("ma", "mm", "md", "ms"):
        px = cx - layer.width // 2
    else:
        px = cx - layer.width + 100
    if aw in ("la", "ma", "ra", "ls", "ms", "rs"):
        py = cy - 100
    elif aw in ("lm", "mm", "rm"):
        py = cy - layer.height // 2
    else:
        py = cy - layer.height + 100

    if shadow:
        sc = hex2rgb(shadow["color"])
        s = Image.new("RGBA", layer.size, (0, 0, 0, 0))
        solid = Image.new("RGBA", layer.size, (*sc, 255))
        s.paste(solid, (0, 0), layer.split()[3])
        s.putalpha(layer.split()[3].point(lambda v: int(v * shadow.get("alpha", 60) / 255)))
        s = s.filter(ImageFilter.GaussianBlur(shadow.get("blur", 2.5)))
        canvas.alpha_composite(s, (px + shadow["offset"][0], py + shadow["offset"][1]))

    if ghost:
        canvas.alpha_composite(g, (px + ghost["offset"][0], py + ghost["offset"][1]))
    canvas.alpha_composite(layer, (px, py))


def extend_paper(base, canvas_h, sample_rows=80, overlap=60, seed=11):
    """底图下方接纸。

    做法：把底部若干行做「纵向列平均」压成一行 —— 颗粒噪声被平均掉，
    但纸面的横向渐晕（左右偏暗、中间偏亮）原样保留；再把这行纵向重复
    铺满接纸区，最后叠一层细颗粒并羽化接缝。直接拉伸会出竖纹，填纯色
    会看出色差，都不行。"""
    w, h = base.size
    if canvas_h <= h:
        return base.crop((0, 0, w, canvas_h))
    need = canvas_h - h
    ext_h = need + overlap

    rows = base.crop((0, h - sample_rows, w, h))
    rp = rows.load()
    line = Image.new("RGB", (w, 1))
    lp = line.load()
    mid = sample_rows // 2
    for x in range(w):
        cols = [[], [], []]
        for y in range(sample_rows):
            c = rp[x, y]
            cols[0].append(c[0]); cols[1].append(c[1]); cols[2].append(c[2])
        # 中位数而非均值：底部残留的网点/散点会把均值拉暗，
        # 纵向重复后就成了一条灰带；中位数直接排掉少数脏点
        lp[x, 0] = tuple(sorted(c)[mid] for c in cols)

    ext = line.resize((w, ext_h), Image.NEAREST)
    # 零均值加性颗粒：effect_noise 以 128 为中心，add(-128) 只抖动亮度不抬底色；
    # 早先的 multiply + 提亮系数会把纸面色顶到 255 溢出，纸色就丢了
    grain = Image.effect_noise((w, ext_h), 9).convert("RGB")
    ext = ImageChops.add(ext, grain, 1, -128)

    canvas = Image.new("RGB", (w, canvas_h), (0, 0, 0))
    canvas.paste(base, (0, 0))
    mask = Image.new("L", (w, ext_h), 255)
    md = ImageDraw.Draw(mask)
    for y in range(overlap):
        md.line([(0, y), (w, y)], fill=int(255 * y / overlap))
    canvas.paste(ext, (0, h - overlap), mask)
    return canvas


def main():
    spec_path = sys.argv[1]
    with open(spec_path, encoding="utf-8") as f:
        spec = json.load(f)

    base = Image.open(spec["base"]).convert("RGB")
    cw, ch = spec.get("canvas", [base.width, base.height])
    if base.width != cw:
        base = base.resize((cw, int(base.height * cw / base.width)), Image.LANCZOS)
    page = extend_paper(base, ch, spec.get("paper_sample_rows", 120))
    page = page.convert("RGBA")

    for i, el in enumerate(spec["elements"]):
        t = el.get("type", "text")
        if t == "text":
            draw_text_element(page, el, seed=100 + i)
        elif t == "rule":
            d = ImageDraw.Draw(page, "RGBA")
            c = hex2rgb(el["color"])
            d.line([tuple(el["xy"][0]), tuple(el["xy"][1])],
                   fill=(*c, el.get("alpha", 255)), width=el.get("width", 2))
        elif t == "specks":
            rnd = random.Random(7 + i)
            d = ImageDraw.Draw(page, "RGBA")
            c = hex2rgb(el["color"])
            x0, y0, x1, y1 = el["box"]
            for _ in range(el.get("count", 30)):
                x = rnd.randint(x0, x1)
                y = rnd.randint(y0, y1)
                r = rnd.choice([1, 1, 1, 2, 2, 3])
                d.ellipse([x - r, y - r, x + r, y + r], fill=(*c, el.get("alpha", 70)))

    out = spec["out"]
    os.makedirs(os.path.dirname(out), exist_ok=True)
    page.convert("RGB").save(out, "PNG")
    print("OK", out, page.size)


if __name__ == "__main__":
    main()
