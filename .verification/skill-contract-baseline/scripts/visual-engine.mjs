// ══ 视觉引擎（image-to-engine 的执行端）══════════════════════════════════
// 一个战役 = 一个目录 + 一份 visual-system.json。改里面一条字段 → 重跑 → 全套物料跟着变。
// 这就是那篇文章说的"引擎"：一次性出一张好图没有价值，能一条改动传导到全套物料才叫资产。
//
// 用法：
//   node scripts/visual-engine.mjs <战役目录> [--check] [--only kv] [--force] [--model ...] [--keep-html] [--scale 2]
// 每个物料：
//   ① 组装提示词（主体 → 张力 → 材质/色彩 → 构图/装置 → 负面清单；**排版与网格不进图像提示词**）
//   ② 调 /api/image 出【无字底图】（kind:"brief" 的物料跳过这步——brief 页不需要底图）
//   ③ 叠字：HTML/CSS 版式 → playwright CLI 截图（降级链 Chrome CLI → CDP → ffmpeg）
//   ④ 写 out/manifest.json（模型 / 提示词 / 渲染器 / 版式 / 导出 / 时间）
//
// 版式 layout：bottom（默认）| topLeft | bottomRight | center | verticalRight（竖排 + 印章）
// 印章 stamp / stampAlt / stampFont / stampShape（square|round）/ stampPos（auto|inline|corner）
// 分栏与页码 columns（正文栏数）| body（正文）| pageNo（左下页码）
// 多尺寸 exports：[{suffix:"sq", ratio:"1:1"}, {suffix:"story", ratio:"9:16"}] → 同底图换画幅再出一版
// brief 页 kind:"brief"：不生成底图，按 vs.brief 出一页纸面（brief / idea / goals / deliverables）
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const BASE = process.env.PI_BASE || 'http://127.0.0.1:8787'
const TOKEN = process.env.PI_TOKEN || 'love#1126469194'
const CDP = process.env.PI_CDP || 'http://127.0.0.1:9222'
const FFMPEG = process.env.FFMPEG || 'ffmpeg'
const FONT = process.env.PI_FONT || 'C:/Windows/Fonts/msyhbd.ttc'
const RATIOS = { '16:9': [1280, 720], '3:4': [1080, 1440], '1:1': [1080, 1080], '9:16': [1080, 1920], '4:5': [1080, 1350], '16:10': [1600, 1000] }

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
const SCALE = Number(opt('scale', vs.scale || 2))
const outDir = path.join(dir, 'out')
fs.mkdirSync(outDir, { recursive: true })
const SERIF = '"Noto Serif SC","Source Han Serif SC","Songti SC",SimSun,"Microsoft YaHei",serif'
const SANS = '"Microsoft YaHei","PingFang SC",system-ui,sans-serif'

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

async function generate(prompt, tries = 3) {
  let last = ''
  for (let i = 0; i < tries; i++) {
    try {
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
    } catch (e) { last = String(e?.message || e); await new Promise((r) => setTimeout(r, 1500)) }
  }
  throw new Error(last)
}

// ── 版式预设 ──
function layoutCss(layout, w, h, y) {
  const box = 'position:absolute;color:var(--ink);text-shadow:var(--tsh)'
  const pad = Math.round(w * 0.075)
  switch (layout) {
    case 'topLeft':
      return { text: `${box};left:${pad}px;top:${Math.round(h * 0.075)}px;right:${pad}px`, veil: 'linear-gradient(to bottom,var(--v1) 0%,var(--v2) 34%,transparent 62%)' }
    case 'bottomRight':
      return { text: `${box};right:${pad}px;bottom:${Math.round(h * 0.09)}px;left:${pad}px;text-align:right`, veil: 'linear-gradient(to bottom,var(--v3) 0%,transparent 30%,var(--v4) 100%)' }
    case 'center':
      return { text: `${box};left:${pad}px;right:${pad}px;top:50%;transform:translateY(-50%);text-align:center`, veil: 'linear-gradient(to bottom,var(--v1) 0%,transparent 45%,var(--v4) 100%)' }
    case 'verticalRight':
      return { text: `${box};writing-mode:vertical-rl;text-orientation:upright;right:${Math.round(w * 0.085)}px;top:${Math.round(h * 0.07)}px;height:${Math.round(h * 0.72)}px;display:flex;flex-direction:column;align-items:center`, veil: 'linear-gradient(to left,var(--v5) 0%,transparent 26%,transparent 55%,var(--v2) 100%)' }
    default:
      return { text: `${box};left:${pad}px;right:${pad}px;top:${(y * 100)}%`, veil: 'linear-gradient(to bottom,var(--v1) 0%,transparent 28%,var(--v2) 52%,var(--v4) 100%)' }
  }
}

function sealHtml(m, w) {
  const text = m.stamp || ''
  const alt = m.stampAlt || ''
  const font = m.stampFont || SERIF
  const round = m.stampShape === 'round'
  const size = Math.round(w * 0.085)
  const box = (t, s) => `<div class="stamp" style="width:${s}px;height:${s}px;font-family:${font};font-size:${Math.round(s * 0.5)}px;border-radius:${round ? '50%' : '6px'}">${t}</div>`
  if (!text && !alt) return ''
  return `<div class="seals">${text ? box(text, size) : ''}${alt ? box(alt, Math.round(size * 0.72)) : ''}</div>`
}

// ── 叠字：HTML/CSS 版式（版式 / 竖排 / 印章 / 分栏 / 页码 / brief 页 / 多语言）──
function buildHtml(baseFile, m, size, texts = {}) {
  const [w, h] = size
  const title = texts.title ?? m.title ?? ''
  const slogan = texts.slogan ?? m.slogan ?? ''
  const body = texts.body ?? m.body ?? ''
  const layout = m.layout || vs.layout || 'bottom'
  const vertical = layout === 'verticalRight'
  const brief = m.kind === 'brief'
  const dark = !brief                       // brief 页走纸面浅色，其余走深色影视感
  const fam = m.serif === false ? SANS : (texts.latin ? 'Georgia,"Times New Roman",serif' : SERIF)
  // brief 页内容多时整体缩一号（真机：4 条目标时最下面那条被切掉，页码还压在目标条上）
  const briefWeight = (vs.brief?.rows || []).length + (((vs.brief?.goals || []).length > 3) ? 1 : 0)
  const k = brief ? (briefWeight > 4 ? 0.84 : briefWeight > 3 ? 0.92 : 1) : 1
  const ts = Math.round(w * (m.titleSize || (brief ? 0.058 : 0.082)) * k)
  const ss = Math.round(w * (m.sloganSize || (brief ? 0.022 : 0.030)) * k)
  const bs = Math.round(w * (m.bodySize || 0.024) * k)
  const L = layoutCss(layout, w, h, m.textY ?? vs.textY ?? 0.68)
  const b64 = baseFile ? fs.readFileSync(baseFile).toString('base64') : ''
  const cols = Number(m.columns || vs.columns || 0)

  // brief 页的内容块
  const briefRows = brief
    ? (vs.brief?.rows || []).map((r) => `<div class="brow"><div class="bk">${r.k}</div><div class="bv">${r.v}</div></div>`).join('')
      + ((vs.brief?.goals || []).length ? `<div class="goals">${vs.brief.goals.map((g) => `<div class="goal">${g}</div>`).join('')}</div>` : '')
    : ''
  const inner = brief
    ? `<div class="btop"><div class="bkicker">${vs.campaign || ''} · BRIEF</div><div class="btitle">${title || '战役简报'}</div>
       <div class="brule"></div>${slogan ? `<div class="bslogan">${slogan}</div>` : ''}</div>
       <div class="bbody">${briefRows || `<div class="bv">${body || '（在 visual-system.json 的 brief.rows 里写 brief / idea / goals）'}</div>`}</div>`
    : `${title ? `<div class="title${vertical ? ' v' : ''}">${title}</div>` : ''}${title && slogan ? (vertical ? '<div class="vrule"></div>' : '<div class="rule"></div>') : ''}${slogan ? `<div class="slogan${vertical ? ' v' : ''}">${slogan}</div>` : ''}${body ? `<div class="body" style="${cols > 1 ? `column-count:${cols};column-gap:${Math.round(w * 0.05)}px` : ''}">${body}</div>` : ''}`

  const pageNo = m.pageNo || vs.pageNo || ''
  const ink = dark ? '#fff' : '#1c1a17'
  const bg = dark ? '#111' : '#f4f1ea'
  const pageBg = brief ? `var(--paper)` : `url(data:image/png;base64,${b64}) center/cover no-repeat`
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>
:root{--ink:${ink};--tsh:${dark ? '0 3px 20px rgba(0,0,0,.5)' : 'none'};
 --v1:rgba(0,0,0,.18);--v2:rgba(0,0,0,.10);--v3:rgba(0,0,0,.14);--v4:rgba(0,0,0,.64);--v5:rgba(0,0,0,.5);
 --paper:linear-gradient(180deg,#f7f4ee 0%,#efe9de 100%)}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${w}px;height:${h}px;overflow:hidden;background:${bg}}
.kv{position:relative;width:${w}px;height:${h}px;background:${pageBg}}
.veil{position:absolute;inset:0;background:${brief ? 'none' : L.veil}}
.text{${L.text};padding:0 ${Math.round(w * 0.075)}px}
.title{font-family:${fam};font-weight:700;font-size:${ts}px;letter-spacing:${Math.round(ts * 0.16)}px;line-height:1.18}
.slogan{font-family:${fam};font-weight:400;font-size:${ss}px;letter-spacing:${Math.round(ss * 0.34)}px;opacity:.94}
.title.v{letter-spacing:${Math.round(ts * 0.2)}px;line-height:1.08;margin-bottom:${Math.round(w * 0.02)}px}
.slogan.v{letter-spacing:${Math.round(ss * 0.3)}px;margin-top:${Math.round(w * 0.02)}px}
.body{font-family:${fam};font-size:${bs}px;line-height:1.75;letter-spacing:${Math.round(bs * 0.06)}px;opacity:.92;margin-top:${Math.round(ss * 0.9)}px;text-align:justify}
.rule{width:${Math.round(w * 0.13)}px;height:2px;background:currentColor;opacity:.78;margin:${Math.round(ts * 0.32)}px 0 ${Math.round(ts * 0.26)}px}
.vrule{width:2px;height:${Math.round(w * 0.08)}px;background:currentColor;opacity:.75;margin:${Math.round(w * 0.02)}px 0}
.seals{display:flex;gap:${Math.round(w * 0.014)}px;align-items:center;${vertical ? `margin-top:${Math.round(w * 0.03)}px` : `position:absolute;bottom:${Math.round(h * 0.06)}px;left:${Math.round(w * 0.075)}px`}}
.stamp{background:#b03028;color:#fff;font-weight:700;display:flex;align-items:center;justify-content:center;transform:rotate(-3deg);box-shadow:0 4px 14px rgba(0,0,0,.4)}
.meta{position:absolute;right:${Math.round(w * 0.075)}px;bottom:${Math.round(h * 0.045)}px;opacity:.8;font-family:${fam};font-size:${Math.round(w * 0.017)}px;letter-spacing:3px;color:var(--ink)}
.pageno{position:absolute;left:${Math.round(w * 0.075)}px;bottom:${Math.round(h * 0.045)}px;font-family:${fam};font-size:${Math.round(w * 0.018)}px;letter-spacing:4px;color:var(--ink);opacity:.72}
.pageno::before{content:'';display:inline-block;width:${Math.round(w * 0.05)}px;height:1px;background:currentColor;vertical-align:middle;margin-right:${Math.round(w * 0.012)}px;opacity:.6}
.btop{padding:${Math.round(h * 0.085)}px ${Math.round(w * 0.085)}px 0}
.bkicker{font-family:${fam};font-size:${Math.round(w * 0.016)}px;letter-spacing:6px;color:#8a7f6d;text-transform:uppercase}
.btitle{font-family:${fam};font-weight:700;font-size:${ts}px;letter-spacing:${Math.round(ts * 0.1)}px;color:#1c1a17;margin-top:${Math.round(h * 0.02)}px}
.brule{width:${Math.round(w * 0.1)}px;height:3px;background:#1c1a17;margin:${Math.round(h * 0.025)}px 0 ${Math.round(h * 0.02)}px}
.bslogan{font-family:${fam};font-size:${ss}px;letter-spacing:${Math.round(ss * 0.3)}px;color:#5d554a}
.bbody{padding:${Math.round(h * 0.035)}px ${Math.round(w * 0.085)}px ${Math.round(h * 0.145)}px;display:flex;flex-direction:column;gap:${Math.round(h * 0.022)}px}
.brow{display:grid;grid-template-columns:${Math.round(w * 0.16)}px 1fr;gap:${Math.round(w * 0.03)}px;align-items:baseline;border-top:1px solid rgba(28,26,23,.14);padding-top:${Math.round(h * 0.018)}px}
.bk{font-family:${fam};font-size:${Math.round(w * 0.018)}px;letter-spacing:2px;color:#8a7f6d}
.bv{font-family:${fam};font-size:${bs}px;line-height:1.7;color:#241f1a}
.goals{display:flex;flex-wrap:wrap;gap:${Math.round(w * 0.012)}px;margin-top:${Math.round(h * 0.01)}px}
.goal{font-family:${fam};font-size:${Math.round(bs * 0.82)}px;color:#3b3229;border:1px solid rgba(28,26,23,.22);border-radius:999px;padding:${Math.round(w * 0.008)}px ${Math.round(w * 0.018)}px}
</style></head><body><div class="kv">${brief ? '' : '<div class="veil"></div>'}
${brief ? inner : `<div class="text">${inner}</div>`}
${brief ? '' : sealHtml(m, w)}
${pageNo ? `<div class="pageno"${brief ? ' style="top:' + Math.round(h * 0.045) + 'px;bottom:auto;left:auto;right:' + Math.round(w * 0.075) + 'px"' : ''}>${pageNo}</div>` : ''}
<div class="meta">${m.meta || vs.campaign || ''}</div></div></body></html>`
}

// ── 渲染器：playwright CLI（首选）→ Chrome CLI → CDP(30s) → ffmpeg ──
async function renderViaPlaywrightCli(htmlFile, finalFile, size) {
  const [w, h] = size
  execFileSync('playwright', ['screenshot', '--browser=chromium', `--viewport-size=${w},${h}`, '--wait-for-timeout=1600', 'file:///' + htmlFile.split(path.sep).join('/').replace(/^\//, ''), finalFile], { stdio: 'ignore', timeout: 90000, shell: true })
  if (!fs.existsSync(finalFile) || fs.statSync(finalFile).size < 1000) throw new Error('playwright 截图没产出有效文件')
  return `playwright 截图 ${w}×${h}`
}

function resolveChrome() {
  const cands = []
  if (process.env.PI_CHROME) cands.push(process.env.PI_CHROME)
  try {
    const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright')
    for (const d of fs.readdirSync(base)) {
      for (const sub of ['chrome-win64', 'chrome-win']) {
        const p = path.join(base, d, sub, 'chrome.exe')
        if (fs.existsSync(p)) cands.push(p)
      }
    }
  } catch {}
  cands.push('C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe')
  return cands.find((p) => { try { return fs.existsSync(p) } catch { return false } }) || ''
}

async function renderViaChromeCli(htmlFile, finalFile, size) {
  const exe = resolveChrome()
  if (!exe) throw new Error('找不到 chrome/chromium')
  const [w, h] = size
  const tmpRoot = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'visual-engine-'))
  const tmpHtml = path.join(tmpRoot, 'page.html')
  const tmpPng = path.join(tmpRoot, 'shot.png')
  fs.copyFileSync(htmlFile, tmpHtml)
  execFileSync(exe, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${path.join(tmpRoot, 'profile')}`, `--window-size=${w},${h}`, `--force-device-scale-factor=1`,
    '--virtual-time-budget=2500', `--screenshot=${tmpPng}`, 'file:///' + tmpHtml.split(path.sep).join('/').replace(/^\//, '')], { stdio: 'ignore', timeout: 90000 })
  if (!fs.existsSync(tmpPng) || fs.statSync(tmpPng).size < 1000) throw new Error('CLI 截图没产出有效文件')
  fs.copyFileSync(tmpPng, finalFile)
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
  return `Chrome CLI 截图 ${w}×${h}`
}

let cdpConn = null
async function getCdp() {
  if (cdpConn) return cdpConn
  const t = await (await fetch(CDP + '/json/new?about:blank', { method: 'PUT' })).json()
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('CDP 连不上'))) })
  let id = 0
  const q = new Map()
  ws.addEventListener('message', (e) => { const msg = JSON.parse(e.data); const sl = msg.id && q.get(msg.id); if (sl) { q.delete(msg.id); msg.error ? sl.rej(new Error(JSON.stringify(msg.error))) : sl.res(msg.result) } })
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; q.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) })
  await send('Page.enable')
  cdpConn = { send, ws }
  return cdpConn
}

async function renderViaCdp(htmlFile, finalFile, size) {
  const [w, h] = size
  const { send } = await getCdp()
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false, screenWidth: w, screenHeight: h })
  await send('Page.navigate', { url: 'file:///' + htmlFile.split(path.sep).join('/').replace(/^\//, '') })
  await new Promise((r) => setTimeout(r, 1500))
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(finalFile, Buffer.from(shot.data, 'base64'))
  return `CDP 截图 ${w}×${h}`
}

function overlayFfmpeg(baseFile, m, finalFile, size, texts = {}) {
  const tf = path.join(outDir, `.${path.basename(finalFile, '.png')}.txt`)
  fs.writeFileSync(tf, [texts.title ?? m.title, texts.slogan ?? m.slogan].filter(Boolean).join('\n'), 'utf8')
  const [w, h] = size
  const fz = Math.round(w * (m.titleSize || 0.085))
  const vf = [
    `scale=${w}:${h}:force_original_aspect_ratio=increase`,
    `crop=${w}:${h}`,
    `drawtext=fontfile=${FONT.replace(/:/g, '\\\\:')}:textfile=${tf.split(path.sep).join('/').replace(/:/g, '\\\\:')}:fontcolor=white:fontsize=${fz}:line_spacing=${Math.round(fz * 0.3)}:x=(w-text_w)/2:y=h*${m.textY ?? 0.72}:shadowcolor=black@0.55:shadowx=3:shadowy=3`,
  ].join(',')
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', baseFile, '-vf', vf, finalFile], { stdio: 'inherit' })
  fs.rmSync(tf, { force: true })
  return 'ffmpeg drawtext（兜底）'
}

async function renderHtml(baseFile, m, finalFile, size, texts = {}) {
  const big = [size[0] * SCALE, size[1] * SCALE]
  const htmlFile = path.join(outDir, `.${path.basename(finalFile, '.png')}.html`)
  fs.writeFileSync(htmlFile, buildHtml(baseFile, m, big, texts), 'utf8')
  let how = ''
  try {
    how = await renderViaPlaywrightCli(htmlFile, finalFile, big)
  } catch (e0) {
    console.log(`    · playwright 不可用（${String(e0?.message || e0).slice(0, 50)}），试 Chrome CLI`)
    try { how = await renderViaChromeCli(htmlFile, finalFile, big) }
    catch (e1) {
      console.log(`    · Chrome CLI 不可用（${String(e1?.message || e1).slice(0, 50)}），试 CDP`)
      how = await Promise.race([renderViaCdp(htmlFile, finalFile, big), new Promise((_, rej) => setTimeout(() => rej(new Error('CDP 渲染超时 30s')), 30000))])
    }
  }
  if (!flag('keep-html')) fs.rmSync(htmlFile, { force: true })
  return 'HTML 版式(' + (m.layout || vs.layout || 'bottom') + ') + ' + how
}

async function renderOne(baseFile, m, finalFile, size, texts = {}) {
  const hasText = (texts.title ?? m.title) || (texts.slogan ?? m.slogan) || m.kind === 'brief'
  if (!hasText) { fs.copyFileSync(baseFile, finalFile); return '（无文字）' }
  if (m.renderer !== 'ffmpeg') {
    try { return await renderHtml(baseFile, m, finalFile, size, texts) }
    catch (e) { console.log(`    · HTML 渲染不可用（${String(e?.message || e).slice(0, 60)}），退回 ffmpeg`) }
  }
  return overlayFfmpeg(baseFile, m, finalFile, size, texts)
}

const materials = (vs.materials || []).filter((m) => !opt('only') || m.id === opt('only'))
if (!materials.length) { console.error('visual-system.json 里没有 materials（或 --only 没匹配上）'); process.exit(1) }

console.log(`战役: ${vs.campaign || path.basename(dir)}  张力: ${vs.tension ? `${vs.tension.a} × ${vs.tension.b}` : '（未定！张力前置是这套流程的第一条）'}`)
console.log(`模型: ${provider}/${modelId}  物料: ${materials.length} 个  倍率: ${SCALE}x  输出: ${outDir}`)

const manifest = []
for (const m of materials) {
  const brief = m.kind === 'brief'
  const size = RATIOS[m.ratio || vs.ratio || '3:4'] || RATIOS['3:4']
  const baseFile = path.join(outDir, `${m.id}-base.png`)
  const finalFile = path.join(outDir, `${m.id}-final.png`)
  const prompt = brief ? '（brief 页：不生成底图）' : buildPrompt(m)
  if (flag('check')) {
    console.log(`  [check] ${m.id}${brief ? ' [brief]' : ''} ${m.ratio || vs.ratio} layout=${m.layout || vs.layout || 'bottom'}${m.stamp ? ' stamp=' + m.stamp : ''}${m.stampAlt ? '+' + m.stampAlt : ''}${m.columns ? ' columns=' + m.columns : ''}${m.pageNo ? ' page=' + m.pageNo : ''}${m.alt ? ' alt=' + Object.keys(m.alt).join('/') : ''}${m.exports ? ' exports=' + m.exports.map((e) => e.suffix).join('/') : ''}`)
    console.log(`          ${prompt.slice(0, 130)}${brief ? '' : '…'}`)
    continue
  }
  if (fs.existsSync(finalFile) && !flag('force')) { console.log(`  · ${m.id}: 已存在（--force 可重跑）`); manifest.push({ id: m.id, file: finalFile, skipped: true }); continue }
  const t0 = Date.now()
  try {
    let reused = false
    if (!brief) {
      if (fs.existsSync(baseFile) && !flag('force')) reused = true
      else fs.writeFileSync(baseFile, await generate(prompt))
    }
    const how = await renderOne(brief ? null : baseFile, m, finalFile, size)
    const kb = Math.round(fs.statSync(finalFile).size / 1024)
    console.log(`  ✓ ${m.id}${brief ? ' [brief]' : ''}: ${brief ? '' : reused ? '复用底图 + ' : '新出底图 + '}${how} → ${path.basename(finalFile)}（${kb}KB, ${((Date.now() - t0) / 1000).toFixed(1)}s）`)
    const item = { id: m.id, kind: brief ? 'brief' : 'image', ratio: m.ratio || vs.ratio, layout: m.layout || vs.layout || 'bottom', file: finalFile, renderer: how, prompt, model: brief ? null : `${provider}/${modelId}`, at: new Date().toISOString() }
    // 多语言：同底图再叠一版
    for (const [lang, t] of Object.entries(m.alt || {})) {
      const altFile = path.join(outDir, `${m.id}-${lang}.png`)
      const howAlt = await renderOne(brief ? null : baseFile, m, altFile, size, { ...t, latin: true })
      console.log(`    ↳ ${lang}: ${howAlt} → ${path.basename(altFile)}（${Math.round(fs.statSync(altFile).size / 1024)}KB）`)
      item.alt = { ...(item.alt || {}), [lang]: altFile }
    }
    // 多尺寸：同底图换画幅（不出图，只换裁切与版式）
    for (const ex of m.exports || []) {
      const exSize = RATIOS[ex.ratio] || size
      const exFile = path.join(outDir, `${m.id}-${ex.suffix}.png`)
      const howEx = await renderOne(brief ? null : baseFile, { ...m, ...ex, alt: undefined, exports: undefined }, exFile, exSize)
      console.log(`    ↳ ${ex.suffix}(${ex.ratio}): ${howEx} → ${path.basename(exFile)}（${Math.round(fs.statSync(exFile).size / 1024)}KB）`)
      item.exports = { ...(item.exports || {}), [ex.suffix]: exFile }
    }
    manifest.push(item)
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
