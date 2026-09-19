// ══ 视觉引擎（image-to-engine 的执行端）══════════════════════════════════
// 一个战役 = 一个目录 + 一份 visual-system.json。改里面一条字段 → 重跑 → 全套物料跟着变。
// 这就是那篇文章说的"引擎"：一次性出一张好图没有价值，能一条改动传导到全套物料才叫资产。
//
// 用法：
//   node scripts/visual-engine.mjs <战役目录> [--check] [--only kv] [--force] [--model agnes/agnes-image-2.0-flash] [--keep-html]
// 每个物料：
//   ① 组装提示词（主体 → 张力 → 材质/色彩 → 构图/装置 → 负面清单；**排版与网格不进图像提示词**）
//   ② 调 /api/image 出【无字底图】
//   ③ 叠字：HTML/CSS 版式（宋体 + 字距 + 渐变遮罩 + 细横线 + 角标）→ 用已在跑的 Chrome(:9222) 按容器尺寸截图
//      渲染器不可用时自动退回 ffmpeg drawtext
//   ④ 写 out/manifest.json（模型 / 提示词全文 / 渲染器 / 时间）—— 可复现、可对比
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const BASE = process.env.PI_BASE || 'http://127.0.0.1:8787'
const TOKEN = process.env.PI_TOKEN || 'love#1126469194'
const CDP = process.env.PI_CDP || 'http://127.0.0.1:9222'
const FFMPEG = process.env.FFMPEG || 'ffmpeg'
const FONT = process.env.PI_FONT || 'C:/Windows/Fonts/msyhbd.ttc'
const RATIOS = { '16:9': [1280, 720], '3:4': [1080, 1440], '1:1': [1080, 1080], '9:16': [1080, 1920], '4:5': [1080, 1350] }

const args = process.argv.slice(2)
const dir = args.find((a) => !a.startsWith('--'))
const flag = (n) => args.includes(`--${n}`)
const opt = (n, d = '') => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d }
if (!dir) { console.error('用法: node scripts/visual-engine.mjs <战役目录> [--check] [--only id] [--force]'); process.exit(1) }

const sysFile = path.join(dir, 'visual-system.json')
if (!fs.existsSync(sysFile)) { console.error(`缺 ${sysFile}（战役必须要一份视觉系统）`); process.exit(1) }
const vs = JSON.parse(fs.readFileSync(sysFile, 'utf8'))
const model = opt('model', vs.model || 'agnes/agnes-image-2.0-flash')
const [provider, modelId] = model.includes('/') ? [model.split('/')[0], model.split('/').slice(1).join('/')] : ['agnes', model]
const outDir = path.join(dir, 'out')
fs.mkdirSync(outDir, { recursive: true })

// ── 提示词：张力在前，画面在后；排版/网格刻意不进（它们属于叠字段）──
function buildPrompt(m) {
  const neg = [
    ...(vs.negatives || []),
    // 真机教训：中文负面词挡不住模型画"像汉字的符号"，英文硬清单更管用
    'no text', 'no words', 'no letters', 'no numbers', 'no logo', 'no watermark', 'no signature',
    'no Chinese characters', 'no calligraphy', 'no signage', 'no signboard', 'no poster text',
  ]
  const parts = [
    m.subject || vs.subject,
    vs.tension ? `核心张力：${vs.tension.a} × ${vs.tension.b}${vs.tension.why ? `（${vs.tension.why}）` : ''}` : '',
    vs.material ? `材质与质感：${vs.material}` : '',
    vs.palette ? `色彩：${vs.palette}` : '',
    vs.device ? `标志性视觉装置：${vs.device}` : '',
    vs.composition ? `构图：${vs.composition}` : '',
    m.extra || '',
    `画幅 ${m.ratio || vs.ratio || '3:4'}，主体居中偏下，上方大片留白（留白里什么都不要画，不要任何笔触或书法）`,
    `不要出现：${neg.join('、')}`,
  ].filter(Boolean)
  return parts.join('；')
}

async function generate(prompt) {
  const r = await fetch(`${BASE}/api/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ provider, modelId, prompt, size: '1024x1024' }),
  })
  const d = await r.json()
  if (!d.image) throw new Error(String(d.error || `HTTP ${r.status}`).slice(0, 120))
  const raw = String(d.image)
  if (/^https?:\/\//.test(raw)) return Buffer.from(await (await fetch(raw)).arrayBuffer())
  return Buffer.from(raw.includes(',') ? raw.split(',').pop() : raw, 'base64')
}

// ── 叠字①：HTML/CSS 版式（字距呼吸 + 渐变遮罩 + 细横线 + 角标）──
function buildHtml(baseFile, m, size) {
  const [w, h] = size
  const b64 = fs.readFileSync(baseFile).toString('base64')
  const title = m.title || ''
  const slogan = m.slogan || ''
  const fam = m.serif === false
    ? '"Microsoft YaHei","PingFang SC",system-ui,sans-serif'
    : '"Noto Serif SC","Source Han Serif SC","Songti SC",SimSun,"Microsoft YaHei",serif'
  const ts = Math.round(w * (m.titleSize || 0.082))
  const ss = Math.round(w * (m.sloganSize || 0.030))
  const y = (m.textY ?? 0.68) * 100
  const rule = '<div class="rule"></div>'
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${w}px;height:${h}px;overflow:hidden}
.kv{position:relative;width:${w}px;height:${h}px;background:#111 url(data:image/png;base64,${b64}) center/cover no-repeat}
.veil{position:absolute;inset:0;background:linear-gradient(to bottom,rgba(0,0,0,.18) 0%,rgba(0,0,0,0) 28%,rgba(0,0,0,.10) 52%,rgba(0,0,0,.64) 100%)}
.text{position:absolute;left:0;right:0;top:${y}%;padding:0 ${Math.round(w * 0.075)}px;color:#fff;text-shadow:0 3px 20px rgba(0,0,0,.5)}
.title{font-family:${fam};font-weight:700;font-size:${ts}px;letter-spacing:${Math.round(ts * 0.16)}px;line-height:1.18}
.rule{width:${Math.round(w * 0.13)}px;height:2px;background:rgba(255,255,255,.78);margin:${Math.round(ts * 0.32)}px 0 ${Math.round(ts * 0.26)}px}
.slogan{font-family:${fam};font-weight:400;font-size:${ss}px;letter-spacing:${Math.round(ss * 0.34)}px;opacity:.94}
.meta{position:absolute;right:${Math.round(w * 0.075)}px;bottom:${Math.round(h * 0.045)}px;color:rgba(255,255,255,.8);font-family:${fam};font-size:${Math.round(w * 0.017)}px;letter-spacing:3px}
</style></head><body><div class="kv"><div class="veil"></div>
<div class="text">${title ? `<div class="title">${title}</div>` : ''}${title && slogan ? rule : ''}${slogan ? `<div class="slogan">${slogan}</div>` : ''}</div>
<div class="meta">${m.meta || vs.campaign || ''}</div></div></body></html>`
}

async function renderViaCdp(htmlFile, finalFile, size) {
  const [w, h] = size
  const t = await (await fetch(CDP + '/json/new?about:blank', { method: 'PUT' })).json()
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('CDP 连不上'))) })
  let id = 0
  const q = new Map()
  ws.addEventListener('message', (e) => { const msg = JSON.parse(e.data); const sl = msg.id && q.get(msg.id); if (sl) { q.delete(msg.id); msg.error ? sl.rej(new Error(JSON.stringify(msg.error))) : sl.res(msg.result) } })
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; q.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) })
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false, screenWidth: w, screenHeight: h })
  await send('Page.navigate', { url: 'file:///' + htmlFile.split(path.sep).join('/').replace(/^\//, '') })
  await new Promise((r) => setTimeout(r, 1400))   // 等 data URI 底图解码 + 字体就位
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(finalFile, Buffer.from(shot.data, 'base64'))
  try { ws.close() } catch {}
  return 'Chrome 截图'
}

// ── 叠字②：ffmpeg drawtext（兜底，版式能力有限）──
function overlayFfmpeg(baseFile, m, finalFile, size) {
  const tf = path.join(outDir, `.${m.id}.txt`)
  fs.writeFileSync(tf, [m.title, m.slogan].filter(Boolean).join('\n'), 'utf8')
  const [w, h] = size
  const fz = Math.round(w * (m.titleSize || 0.085))
  const vf = [
    `scale=${w}:${h}:force_original_aspect_ratio=increase`,
    `crop=${w}:${h}`,
    `drawtext=fontfile=${FONT.replace(/:/g, '\\:')}:textfile=${tf.split(path.sep).join('/').replace(/:/g, '\\:')}:fontcolor=white:fontsize=${fz}:line_spacing=${Math.round(fz * 0.3)}:x=(w-text_w)/2:y=h*${m.textY ?? 0.72}:shadowcolor=black@0.55:shadowx=3:shadowy=3`,
  ].join(',')
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', baseFile, '-vf', vf, finalFile], { stdio: 'inherit' })
  fs.rmSync(tf, { force: true })
  return 'ffmpeg drawtext（兜底）'
}

async function overlay(baseFile, m, finalFile, size) {
  if (!m.title && !m.slogan) { fs.copyFileSync(baseFile, finalFile); return '（无文字）' }
  if (m.renderer !== 'ffmpeg') {
    try {
      const htmlFile = path.join(outDir, `.${m.id}.html`)
      fs.writeFileSync(htmlFile, buildHtml(baseFile, m, size), 'utf8')
      const how = await renderViaCdp(htmlFile, finalFile, size)
      if (!flag('keep-html')) fs.rmSync(htmlFile, { force: true })
      return 'HTML 版式 + ' + how
    } catch (e) {
      console.log(`    · HTML 渲染不可用（${String(e?.message || e).slice(0, 60)}），退回 ffmpeg`)
    }
  }
  return overlayFfmpeg(baseFile, m, finalFile, size)
}

const materials = (vs.materials || []).filter((m) => !opt('only') || m.id === opt('only'))
if (!materials.length) { console.error('visual-system.json 里没有 materials（或 --only 没匹配上）'); process.exit(1) }

console.log(`战役: ${vs.campaign || path.basename(dir)}  张力: ${vs.tension ? `${vs.tension.a} × ${vs.tension.b}` : '（未定！张力前置是这套流程的第一条）'}`)
console.log(`模型: ${provider}/${modelId}  物料: ${materials.length} 个  输出: ${outDir}`)

const manifest = []
for (const m of materials) {
  const size = RATIOS[m.ratio || vs.ratio || '3:4'] || RATIOS['3:4']
  const baseFile = path.join(outDir, `${m.id}-base.png`)
  const finalFile = path.join(outDir, `${m.id}-final.png`)
  const prompt = buildPrompt(m)
  if (flag('check')) { console.log(`  [check] ${m.id} ${m.ratio || vs.ratio} → ${path.basename(finalFile)}\n          ${prompt.slice(0, 150)}…`); continue }
  if (fs.existsSync(finalFile) && !flag('force')) { console.log(`  · ${m.id}: 已存在（--force 可重跑）`); manifest.push({ id: m.id, file: finalFile, skipped: true }); continue }
  const t0 = Date.now()
  try {
    let reused = false
    if (fs.existsSync(baseFile) && !flag('force')) reused = true
    else fs.writeFileSync(baseFile, await generate(prompt))
    const how = await overlay(baseFile, m, finalFile, size)
    const kb = Math.round(fs.statSync(finalFile).size / 1024)
    console.log(`  ✓ ${m.id}: ${reused ? '复用底图' : '新出底图'} + ${how} → ${path.basename(finalFile)}（${kb}KB, ${((Date.now() - t0) / 1000).toFixed(1)}s）`)
    manifest.push({ id: m.id, ratio: m.ratio || vs.ratio, file: finalFile, renderer: how, prompt, model: `${provider}/${modelId}`, at: new Date().toISOString() })
  } catch (e) {
    console.log(`  ✗ ${m.id}: ${String(e?.message || e).slice(0, 140)}`)
    manifest.push({ id: m.id, error: String(e?.message || e).slice(0, 200) })
  }
}
if (!flag('check')) {
  const mf = path.join(outDir, 'manifest.json')
  const old = fs.existsSync(mf) ? JSON.parse(fs.readFileSync(mf, 'utf8')) : {}
  fs.writeFileSync(mf, JSON.stringify({ campaign: vs.campaign, visualSystem: vs, runs: [...(old.runs || []), { at: new Date().toISOString(), items: manifest }] }, null, 2), 'utf8')
  console.log(`清单: ${mf}（改 visual-system.json 里任意一条，重跑即可全套更新）`)
}
