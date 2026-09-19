// ══ 视觉引擎（image-to-engine 的执行端）══════════════════════════════════
// 一个战役 = 一个目录 + 一份 visual-system.json。改里面一条字段 → 重跑 → 全套物料跟着变。
// 这就是那篇文章说的"引擎"：一次性出一张好图没有价值，能一条改动传导到全套物料才叫资产。
//
// 用法：
//   node scripts/visual-engine.mjs <战役目录> [--check] [--only kv] [--force] [--model agnes/agnes-image-2.0-flash] [--keep-html]
// 每个物料：
//   ① 组装提示词（主体 → 张力 → 材质/色彩 → 构图/装置 → 负面清单；**排版与网格不进图像提示词**）
//   ② 调 /api/image 出【无字底图】
//   ③ 叠字：HTML/CSS 版式（四种版式预设 + 竖排 + 印章 + 多语言）→ Chrome(:9222) 截图；不可用时退回 ffmpeg
//   ④ 写 out/manifest.json（模型 / 提示词全文 / 渲染器 / 版式 / 时间）—— 可复现、可对比
//
// 版式（material.layout 或 visual-system.layout）：
//   bottom（默认，左下大字）  topLeft（左上）  bottomRight（右下）  center（居中）  verticalRight（竖排 + 印章位）
// 多语言（material.alt）：{ en: { title, slogan } } → 同一张底图再出一版 <id>-en.png
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

// ── 版式预设：每种只决定"文字块放哪、怎么排、遮罩往哪压" ──
function layoutCss(layout, w, h) {
  const box = 'position:absolute;color:#fff;text-shadow:0 3px 20px rgba(0,0,0,.5)'
  const pad = Math.round(w * 0.075)
  switch (layout) {
    case 'topLeft':
      return {
        text: `${box};left:${pad}px;top:${Math.round(h * 0.075)}px;right:${pad}px`,
        veil: 'linear-gradient(to bottom,rgba(0,0,0,.62) 0%,rgba(0,0,0,.12) 34%,rgba(0,0,0,0) 62%)',
      }
    case 'bottomRight':
      return {
        text: `${box};right:${pad}px;bottom:${Math.round(h * 0.09)}px;left:${pad}px;text-align:right`,
        veil: 'linear-gradient(to bottom,rgba(0,0,0,.14) 0%,rgba(0,0,0,0) 30%,rgba(0,0,0,.66) 100%)',
      }
    case 'center':
      return {
        text: `${box};left:${pad}px;right:${pad}px;top:50%;transform:translateY(-50%);text-align:center`,
        veil: 'linear-gradient(to bottom,rgba(0,0,0,.44) 0%,rgba(0,0,0,.24) 45%,rgba(0,0,0,.52) 100%)',
      }
    case 'verticalRight':
      return {
        text: `${box};writing-mode:vertical-rl;text-orientation:upright;right:${Math.round(w * 0.085)}px;top:${Math.round(h * 0.07)}px;height:${Math.round(h * 0.72)}px;display:flex;flex-direction:column;align-items:center`,
        veil: 'linear-gradient(to left,rgba(0,0,0,.5) 0%,rgba(0,0,0,.06) 26%,rgba(0,0,0,0) 55%,rgba(0,0,0,.2) 100%)',
      }
    default:
      return {
        text: `${box};left:${pad}px;right:${pad}px;top:${((vs.textY ?? 0.68) * 100)}%`,
        veil: 'linear-gradient(to bottom,rgba(0,0,0,.18) 0%,rgba(0,0,0,0) 28%,rgba(0,0,0,.10) 52%,rgba(0,0,0,.64) 100%)',
      }
  }
}

// ── 叠字①：HTML/CSS 版式（四种预设 + 竖排 + 印章 + 多语言）──
function buildHtml(baseFile, m, size, texts = {}) {
  const [w, h] = size
  const b64 = fs.readFileSync(baseFile).toString('base64')
  const title = texts.title ?? m.title ?? ''
  const slogan = texts.slogan ?? m.slogan ?? ''
  const layout = m.layout || vs.layout || 'bottom'
  const vertical = layout === 'verticalRight'
  const fam = m.serif === false
    ? '"Microsoft YaHei","PingFang SC",system-ui,sans-serif'
    : (texts.latin
      ? 'Georgia,"Times New Roman",serif'
      : '"Noto Serif SC","Source Han Serif SC","Songti SC",SimSun,"Microsoft YaHei",serif')
  const ts = Math.round(w * (m.titleSize || 0.082))
  const ss = Math.round(w * (m.sloganSize || 0.030))
  const L = layoutCss(layout, w, h)
  // 竖排：标题在上、细竖线、口号在下，整块从右往左（writing-mode 决定）
  const inner = vertical
    ? `${title ? `<div class="title v">${title}</div>` : ''}${title && slogan ? '<div class="vrule"></div>' : ''}${slogan ? `<div class="slogan v">${slogan}</div>` : ''}`
    : `${title ? `<div class="title">${title}</div>` : ''}${title && slogan ? '<div class="rule"></div>' : ''}${slogan ? `<div class="slogan">${slogan}</div>` : ''}`
  // 印章：CSS 画的朱砂小方章（不依赖任何图片），竖排默认挂在标题下
  const stampText = m.stamp || ''
  const stamp = stampText
    ? `<div class="stamp" style="${vertical ? `margin-top:${Math.round(w * 0.03)}px` : `position:absolute;bottom:${Math.round(h * 0.06)}px;left:${Math.round(w * 0.075)}px`}">${stampText}</div>`
    : ''
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${w}px;height:${h}px;overflow:hidden}
.kv{position:relative;width:${w}px;height:${h}px;background:#111 url(data:image/png;base64,${b64}) center/cover no-repeat}
.veil{position:absolute;inset:0;background:${L.veil}}
.text{${L.text};padding:0 ${Math.round(w * 0.075)}px}
.title{font-family:${fam};font-weight:700;font-size:${ts}px;letter-spacing:${Math.round(ts * 0.16)}px;line-height:1.18}
.slogan{font-family:${fam};font-weight:400;font-size:${ss}px;letter-spacing:${Math.round(ss * 0.34)}px;opacity:.94}
.title.v{letter-spacing:${Math.round(ts * 0.2)}px;line-height:1.08;margin-bottom:${Math.round(w * 0.02)}px}
.slogan.v{letter-spacing:${Math.round(ss * 0.3)}px;margin-top:${Math.round(w * 0.02)}px;opacity:.95}
.rule{width:${Math.round(w * 0.13)}px;height:2px;background:rgba(255,255,255,.78);margin:${Math.round(ts * 0.32)}px 0 ${Math.round(ts * 0.26)}px}
.vrule{width:2px;height:${Math.round(w * 0.08)}px;background:rgba(255,255,255,.75);margin:${Math.round(w * 0.02)}px 0}
.stamp{width:${Math.round(w * 0.085)}px;height:${Math.round(w * 0.085)}px;background:#b03028;color:#fff;
  font-family:${fam};font-size:${Math.round(w * 0.045)}px;font-weight:700;display:flex;align-items:center;justify-content:center;
  border-radius:6px;transform:rotate(-3deg);box-shadow:0 4px 14px rgba(0,0,0,.4)}
${layout === 'bottomRight' || layout === 'center' ? '.title,.slogan{text-align:' + (layout === 'center' ? 'center' : 'right') + '}' : ''}
.meta{position:absolute;right:${Math.round(w * 0.075)}px;bottom:${Math.round(h * 0.045)}px;color:rgba(255,255,255,.8);font-family:${fam};font-size:${Math.round(w * 0.017)}px;letter-spacing:3px}
</style></head><body><div class="kv"><div class="veil"></div>
<div class="text">${inner}${stamp}</div>
<div class="meta">${m.meta || vs.campaign || ''}</div></div></body></html>`
}

// ── 首选渲染：playwright CLI（`playwright screenshot`）──
// 实测最稳：每次全新浏览器进程、viewport 直接给目标像素（2 倍图就传 2 倍尺寸），
// 没有 CDP 会话状态、没有 --user-data-dir 锁、中文路径也没问题。
async function renderViaPlaywrightCli(htmlFile, finalFile, size) {
  const [w, h] = size
  execFileSync('playwright', ['screenshot', '--browser=chromium', `--viewport-size=${w},${h}`, '--wait-for-timeout=1600', 'file:///' + htmlFile.split(path.sep).join('/').replace(/^\//, ''), finalFile], { stdio: 'ignore', timeout: 90000, shell: true })
  if (!fs.existsSync(finalFile) || fs.statSync(finalFile).size < 1000) throw new Error('playwright 截图没产出有效文件')
  return `playwright 截图 ${w}×${h}`
}

// ── 备选：Chrome/Chromium 命令行截图 ──
function resolveChrome() {
  const cands = []
  if (process.env.PI_CHROME) cands.push(process.env.PI_CHROME)
  try {
    const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright')
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, 'chrome-win64', 'chrome.exe')
      if (fs.existsSync(p)) cands.push(p)
      const p2 = path.join(base, d, 'chrome-win', 'chrome.exe')
      if (fs.existsSync(p2)) cands.push(p2)
    }
  } catch {}
  cands.push('C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe')
  return cands.find((p) => { try { return fs.existsSync(p) } catch { return false } }) || ''
}

async function renderViaChromeCli(htmlFile, finalFile, size) {
  const exe = resolveChrome()
  if (!exe) throw new Error('找不到 chrome/chromium')
  const [w, h] = size
  // 关键：**在纯 ASCII 的临时目录里干活**（HTML、profile、截图都放这儿），渲染完再拷回目标路径。
  // 真机教训：把中文路径（工程\视觉引擎示例）和 --screenshot 一起交给 headless，会出现
  // "命令成功但没产出文件"或被上一个进程的 profile 锁住；换成 ASCII 临时目录后一次就过。
  const tmpRoot = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'visual-engine-'))
  const tmpHtml = path.join(tmpRoot, 'page.html')
  const tmpPng = path.join(tmpRoot, 'shot.png')
  fs.copyFileSync(htmlFile, tmpHtml)
  execFileSync(exe, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--allow-file-access-from-files', '--disable-extensions',
    `--user-data-dir=${path.join(tmpRoot, 'profile')}`,
    `--window-size=${w},${h}`, '--force-device-scale-factor=2',
    '--virtual-time-budget=2500',
    `--screenshot=${tmpPng}`,
    'file:///' + tmpHtml.split(path.sep).join('/').replace(/^\//, ''),
  ], { stdio: 'ignore', timeout: 90000 })
  if (!fs.existsSync(tmpPng) || fs.statSync(tmpPng).size < 1000) throw new Error('CLI 截图没产出有效文件')
  fs.copyFileSync(tmpPng, finalFile)
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
  return 'Chrome CLI 截图'
}

// CDP 连接**复用**：一个进程只连一次、只开一个页，每个物料只是导航 + 截图。
// 真机踩过：每个物料都 /json/new 开新页 → 开到第三个就卡住（Chrome 里堆了一堆临时页），
// 现在改成单页复用 + 收尾 Page.close，稳定且快。
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
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false, screenWidth: w, screenHeight: h })
  await send('Page.navigate', { url: 'file:///' + htmlFile.split(path.sep).join('/').replace(/^\//, '') })
  await new Promise((r) => setTimeout(r, 1500))   // 等 data URI 底图解码 + 字体就位
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(finalFile, Buffer.from(shot.data, 'base64'))
  return 'Chrome 截图'
}

// ── 叠字②：ffmpeg drawtext（兜底；只支持 title/slogan 两行居中）──
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

async function renderOne(baseFile, m, finalFile, size, texts = {}) {
  if (!(texts.title ?? m.title) && !(texts.slogan ?? m.slogan)) { fs.copyFileSync(baseFile, finalFile); return '（无文字）' }
  if (m.renderer !== 'ffmpeg') {
    try {
      // 2 倍图：HTML 就按 2 倍尺寸画，viewport 也给 2 倍 —— 不依赖 device-scale-factor
      const scale = Number(m.scale || 2)
      const big = [size[0] * scale, size[1] * scale]
      const htmlFile = path.join(outDir, `.${path.basename(finalFile, '.png')}.html`)
      fs.writeFileSync(htmlFile, buildHtml(baseFile, m, big, texts), 'utf8')
      let how = ''
      try {
        how = await renderViaPlaywrightCli(htmlFile, finalFile, big)
      } catch (e0) {
        console.log(`    · playwright 不可用（${String(e0?.message || e0).slice(0, 50)}），试 Chrome CLI`)
        try {
          how = await renderViaChromeCli(htmlFile, finalFile, big)
        } catch (e1) {
          console.log(`    · Chrome CLI 不可用（${String(e1?.message || e1).slice(0, 50)}），试 CDP`)
          how = await Promise.race([
            renderViaCdp(htmlFile, finalFile, big),
            new Promise((_, rej) => setTimeout(() => rej(new Error('CDP 渲染超时 30s')), 30000)),
          ])
        }
      }
      if (!flag('keep-html')) fs.rmSync(htmlFile, { force: true })
      return 'HTML 版式(' + (m.layout || vs.layout || 'bottom') + ') + ' + how
    } catch (e) {
      console.log(`    · HTML 渲染不可用（${String(e?.message || e).slice(0, 60)}），退回 ffmpeg`)
    }
  }
  return overlayFfmpeg(baseFile, m, finalFile, size, texts)
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
  if (flag('check')) {
    console.log(`  [check] ${m.id} ${m.ratio || vs.ratio} layout=${m.layout || vs.layout || 'bottom'}${m.stamp ? ' stamp=' + m.stamp : ''}${m.alt ? ' 多语言=' + Object.keys(m.alt).join('/') : ''}`)
    console.log(`          ${prompt.slice(0, 130)}…`)
    continue
  }
  if (fs.existsSync(finalFile) && !flag('force')) { console.log(`  · ${m.id}: 已存在（--force 可重跑）`); manifest.push({ id: m.id, file: finalFile, skipped: true }); continue }
  const t0 = Date.now()
  try {
    let reused = false
    if (fs.existsSync(baseFile) && !flag('force')) reused = true
    else fs.writeFileSync(baseFile, await generate(prompt))
    const how = await renderOne(baseFile, m, finalFile, size)
    const kb = Math.round(fs.statSync(finalFile).size / 1024)
    console.log(`  ✓ ${m.id}: ${reused ? '复用底图' : '新出底图'} + ${how} → ${path.basename(finalFile)}（${kb}KB, ${((Date.now() - t0) / 1000).toFixed(1)}s）`)
    const item = { id: m.id, ratio: m.ratio || vs.ratio, layout: m.layout || vs.layout || 'bottom', file: finalFile, renderer: how, prompt, model: `${provider}/${modelId}`, at: new Date().toISOString() }
    // 多语言：同一张底图再叠一版（不重新出图）
    for (const [lang, t] of Object.entries(m.alt || {})) {
      const altFile = path.join(outDir, `${m.id}-${lang}.png`)
      const howAlt = await renderOne(baseFile, m, altFile, size, { ...t, latin: true })
      console.log(`    ↳ ${lang}: ${howAlt} → ${path.basename(altFile)}（${Math.round(fs.statSync(altFile).size / 1024)}KB）`)
      item.alt = { ...(item.alt || {}), [lang]: altFile }
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
