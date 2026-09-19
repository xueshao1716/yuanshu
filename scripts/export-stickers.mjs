// 贴纸包导出：把透明立绘打包成一个能直接用的目录（PNG + 预览页 + 说明）
// 用法：node scripts/export-stickers.mjs [--out "D:\pi-workspace\交付\小语贴纸包"]
import fs from 'node:fs'
import path from 'node:path'

const SRC = 'D:\\pi-web\\frontend\\public\\branding'
const args = process.argv.slice(2)
const i = args.indexOf('--out')
const OUT = i >= 0 ? args[i + 1] : 'D:\\pi-workspace\\交付\\小语贴纸包'
const STK = path.join(OUT, 'stickers')
fs.mkdirSync(STK, { recursive: true })

// 只收"抠过底"的：xiaoyu-*-t.png（Q版七帧）+ walk-*.png（走路帧）+ doll-*.png（盲盒公仔）；跳过 256 缩略图
const files = fs.readdirSync(SRC).filter((f) => /\.png$/i.test(f) && (/^xiaoyu-.+-t\.png$/i.test(f) || /^doll-\d+\.png$/i.test(f) || /^walk-\d+\.png$/i.test(f)))
const groupOf = (f) => (/^walk-0[5-8]/i.test(f) ? 'Q版小语 · 走路' : /^walk-/i.test(f) ? '盲盒公仔 · 走路' : /^doll/i.test(f) ? '盲盒公仔' : 'Q版小语')
const items = []
for (const f of files.sort()) {
  const src = path.join(SRC, f)
  const buf = fs.readFileSync(src)
  fs.writeFileSync(path.join(STK, f), buf)
  items.push({ file: f, kb: Math.round(buf.length / 1024), group: groupOf(f) })
}

const card = (it) => `  <figure>
    <div class="cell"><img src="stickers/${it.file}" alt="${it.file}" loading="lazy"></div>
    <figcaption>${it.file}<br><span>${it.kb} KB</span> · <a href="stickers/${it.file}" download>下载</a></figcaption>
  </figure>`
const group = (name) => {
  const g = items.filter((x) => x.group === name)
  return g.length ? `<h2>${name}（${g.length}）</h2>\n<div class="grid">\n${g.map(card).join('\n')}\n</div>` : ''
}
const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>小语贴纸包 · ${items.length} 张透明 PNG</title>
<style>
:root{color-scheme:dark}
body{margin:0;padding:40px;background:#14161a;color:#e8e6e2;font:14px/1.7 "Microsoft YaHei",system-ui,sans-serif}
h1{font-size:22px;letter-spacing:1px;margin:0 0 6px}
h2{font-size:15px;color:#9aa3ad;font-weight:400;margin:34px 0 14px;letter-spacing:2px}
.lead{color:#9aa3ad;margin-bottom:8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:18px}
figure{margin:0;background:#1b1e24;border:1px solid #262b33;border-radius:12px;padding:12px;text-align:center}
.cell{height:170px;display:flex;align-items:center;justify-content:center;border-radius:8px;
  background-image:linear-gradient(45deg,#2a2f37 25%,transparent 25%),linear-gradient(-45deg,#2a2f37 25%,transparent 25%),
  linear-gradient(45deg,transparent 75%,#2a2f37 75%),linear-gradient(-45deg,transparent 75%,#2a2f37 75%);
  background-size:20px 20px;background-position:0 0,0 10px,10px -10px,-10px 0}
.cell img{max-height:100%;max-width:100%;filter:drop-shadow(0 6px 12px rgba(0,0,0,.5))}
figcaption{font-size:11px;color:#8b939c;margin-top:10px;line-height:1.5;word-break:break-all}
figcaption a{color:#6ee7b7}
</style></head><body>
<h1>小语贴纸包</h1>
<div class="lead">共 <b>${items.length}</b> 张透明 PNG（格子底＝透明区域）。直接拖进 PPT / 网页 / 微信表情都能用；网页用法：<code>&lt;img src="stickers/xxx.png"&gt;</code></div>
${group('Q版小语')}
${group('Q版小语 · 走路')}
${group('盲盒公仔')}
${group('盲盒公仔 · 走路')}
</body></html>`
fs.writeFileSync(path.join(OUT, 'index.html'), html, 'utf8')
fs.writeFileSync(path.join(OUT, 'README.md'), `# 小语贴纸包

- \`stickers/\`：${items.length} 张透明 PNG（Q版七帧 + 盲盒公仔两帧）
- \`index.html\`：双击打开就是预览页（格子底显示透明区域，每张可单独下载）
- 来源：\`记忆/人格定义.json\` 约束的角色设定 → 出图通道生成 → \`scripts/cutout-art.py\`（纯色底）或 rembg（渐变底）抠底
- 重新生成：\`node scripts/export-stickers.mjs\`（素材更新后重跑即可）
`, 'utf8')
console.log(`贴纸包：${items.length} 张 → ${OUT}`)
console.log(items.map((x) => `  ${x.group}  ${x.file}  ${x.kb}KB`).join('\n'))
