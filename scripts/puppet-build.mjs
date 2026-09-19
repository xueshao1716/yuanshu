// 木偶切件 + 生成骨骼：读标注页导出的 labels.json（工程/小语木偶/labels.json），
// 按人给的框切成 6 个部件（含 2% 羽化重叠，避免拼缝），写 parts + puppet.json 到
// frontend/public/puppet/，并顺带出一张"部件对照图"。
//
// 用法：node scripts/puppet-build.mjs [--labels <json>] [--src <png>] [--out <dir>]
// 部件来源图默认从 labels.json 的 image 字段推：/static/branding/<image>.png → frontend/public/branding/<image>.png
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const opt = (n, d = '') => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d }
const WS = process.env.PI_WORKSPACE || 'D:\\pi-workspace'
const labelsFile = opt('labels', path.join(WS, '工程', '小语木偶', 'labels.json'))
if (!fs.existsSync(labelsFile)) { console.error(`没有标注文件：${labelsFile}\n先在浏览器打开 /static/label.html 拖好 6 个框并点"保存到工作区"。`); process.exit(1) }
const labels = JSON.parse(fs.readFileSync(labelsFile, 'utf8'))
const src = opt('src', path.join('D:\\pi-web', 'frontend', 'public', 'branding', `${labels.image || 'xiaoyu-stand'}.png`))
const out = opt('out', path.join('D:\\pi-web', 'frontend', 'public', 'puppet'))
if (!fs.existsSync(src)) { console.error(`没有素材图：${src}`); process.exit(1) }
fs.mkdirSync(out, { recursive: true })

// 用 Pillow 切（Python 里有精确的 alpha 处理）；把框转成像素坐标交给它
const py = `
import json, sys
from PIL import Image, ImageFilter, ImageDraw, ImageChops
labels = json.loads(sys.argv[1]); src = sys.argv[2]; out = sys.argv[3]
im = Image.open(src).convert("RGBA"); W, H = im.size
meta = {"size": [W, H], "image": labels.get("image"), "parts": {}}
ov = 0.02
for p in labels["parts"]:
    x0, y0, x1, y1 = p["box"]
    px0, py0 = max(0, int((x0 - ov) * W)), max(0, int((y0 - ov) * H))
    px1, py1 = min(W, int((x1 + ov) * W)), min(H, int((y1 + ov) * H))
    piece = im.crop((px0, py0, px1, py1))
    # exclude：把别的部件占的区域在本件里抠掉（躯干要抠掉双臂，否则会"四条胳膊"）
    for other in p.get("exclude", []) or []:
        o = next((q for q in labels["parts"] if q["id"] == other), None)
        if not o: continue
        ox0, oy0, ox1, oy1 = o["box"]
        ex0, ey0 = int(ox0 * W) - px0, int(oy0 * H) - py0
        ex1, ey1 = int(ox1 * W) - px0, int(oy1 * H) - py0
        if ex1 > ex0 and ey1 > ey0:
            m = Image.new("L", piece.size, 255)
            ImageDraw.Draw(m).rectangle([ex0, ey0, ex1 - 1, ey1 - 1], fill=0)
            piece.putalpha(ImageChops.multiply(piece.getchannel("A"), m))
    a = piece.getchannel("A").filter(ImageFilter.GaussianBlur(0.6))
    piece.putalpha(a)
    fn = f'{p["id"]}.png'
    piece.save(out + "/" + fn)
    # pivot：支持 [x,y]（框内归一化，精确到肩/髋/颈）或 top-center / bottom-center 这类笼统写法
    pv = p.get("pivot", "top-center")
    bw, bh = px1 - px0, py1 - py0
    if isinstance(pv, (list, tuple)):
        cx, cy = bw * float(pv[0]), bh * float(pv[1])
    elif pv == "bottom-center":
        cx, cy = bw / 2, bh
    else:
        cx, cy = bw / 2, 0
    meta["parts"][p["id"]] = {"file": fn, "x": px0, "y": py0, "w": px1 - px0, "h": py1 - py0,
                              "pivot": [round(cx, 1), round(cy, 1)], "z": {"head": 5, "armL": 1, "armR": 1, "torso": 3, "legL": 2, "legR": 2}.get(p["id"], 2)}
open(out + "/puppet.json", "w", encoding="utf-8").write(json.dumps(meta, ensure_ascii=False, indent=2))
print("parts:", ", ".join(meta["parts"].keys()))
`
try {
  const out2 = execFileSync('py', ['-c', py, JSON.stringify(labels), src, out], { encoding: 'utf8', timeout: 120000 })
  console.log(out2.trim())
} catch (e) { console.error('切件失败:', String(e?.message || e).slice(0, 200)); process.exit(1) }

const manifest = path.join(out, 'puppet.json')
console.log(`骨骼清单: ${manifest}`)
console.log(`部件数: ${Object.keys(JSON.parse(fs.readFileSync(manifest, 'utf8')).parts).length}｜素材: ${path.basename(src)}`)
// 部件对照图
try {
  const proof = `
import json, sys
from PIL import Image, ImageDraw
out = sys.argv[1]; sp = sys.argv[2]
meta = json.load(open(out + "/puppet.json", encoding="utf-8"))
names = list(meta["parts"].keys()); cell = 200
sheet = Image.new("RGBA", (cell*len(names), cell), (255,255,255,255)); d = ImageDraw.Draw(sheet)
for yy in range(0, cell, 20):
    for xx in range(0, cell*len(names), 20):
        if (xx//20 + yy//20) % 2 == 0: d.rectangle([xx,yy,xx+19,yy+19], fill=(228,228,228,255))
for i, n in enumerate(names):
    p = Image.open(out + "/" + meta["parts"][n]["file"]); p.thumbnail((cell-10, cell-10), Image.LANCZOS)
    sheet.alpha_composite(p, (i*cell + (cell-p.size[0])//2, (cell-p.size[1])//2))
sheet.convert("RGB").save(sp); print("对照图:", sp)
`
  console.log(execFileSync('py', ['-c', proof, out, path.join(WS, 'tmp', 'puppet-parts-final.png')], { encoding: 'utf8', timeout: 60000 }).trim())
} catch (e) { console.log('对照图生成失败（不影响使用）:', String(e?.message || e).slice(0, 80)) }
