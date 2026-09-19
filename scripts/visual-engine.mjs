// ══ 视觉引擎（image-to-engine 的执行端）══════════════════════════════════
// 一个战役 = 一个目录 + 一份 visual-system.json。改里面一条字段 → 重跑 → 全套物料跟着变。
// 这就是那篇文章说的"引擎"：一次性出一张好图没有价值，能一条改动传导到全套物料才叫资产。
//
// 用法：
//   node scripts/visual-engine.mjs <战役目录> [--check] [--only kv] [--force] [--model agnes/agnes-image-2.0-flash]
// 做的事（每个物料）：
//   ① 用 visual-system.json 组装提示词（主体 → 质感/材质/色彩 → 版式/装置/网格 → 负面清单 → 无字硬约束）
//   ② 调 /api/image 出【无字底图】（绝不交给模型写中文，必错字）
//   ③ ffmpeg 缩放裁切到目标画幅 + 程序叠字（标题/口号，微软雅黑）→ <id>-final.png
//   ④ 写 out/manifest.json（谁、什么模型、什么提示词、什么产物）——可复现、可对比
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const BASE = process.env.PI_BASE || 'http://127.0.0.1:8787'
const TOKEN = process.env.PI_TOKEN || 'love#1126469194'
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

// ── 组装提示词：张力在前，画面在后；负面清单收尾（原文最值钱的两条）──
function buildPrompt(m) {
  const neg = [
    ...(vs.negatives || []),
    // 真机教训（2026-09-19）：中文负面词挡不住模型画"像汉字的符号"，英文硬清单更管用；
    // 一旦底图里出现伪汉字/招牌，叠字再漂亮也废——所以这一条是硬约束。
    'no text', 'no words', 'no letters', 'no numbers', 'no logo', 'no watermark', 'no signature',
    'no Chinese characters', 'no calligraphy', 'no signage', 'no signboard', 'no poster text',
  ]
  const parts = [
    m.subject || vs.subject,
    vs.tension ? `核心张力：${vs.tension.a} × ${vs.tension.b}${vs.tension.why ? `（${vs.tension.why}）` : ''}` : '',
    vs.material ? `材质与质感：${vs.material}` : '',
    vs.palette ? `色彩：${vs.palette}` : '',
    // 故意**不**把 vs.typography / vs.grid 塞进图像提示词：那是叠字段（见 skills/image-to-engine）
    vs.device ? `标志性视觉装置：${vs.device}` : '',
    vs.composition ? `构图：${vs.composition}` : '',
    m.extra || '',
    RATIOS[m.ratio || vs.ratio || '3:4'] ? `画幅 ${m.ratio || vs.ratio}，主体居中偏下，上方大片留白（留白里什么都不要画，不要任何笔触或书法）` : '主体居中偏下，上方大片留白（留白里什么都不要画）',
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

function overlay(baseFile, m, finalFile, size) {
  const title = m.title || ''
  const slogan = m.slogan || ''
  if (!title && !slogan) { fs.copyFileSync(baseFile, finalFile); return '（无文字，直接复制）' }
  const tf = path.join(outDir, `.${m.id}.txt`)
  fs.writeFileSync(tf, [title, slogan].filter(Boolean).join('\n'), 'utf8')
  const [w, h] = size
  const fs2 = Math.round(w * (m.titleSize || 0.085))
  const fs3 = Math.round(w * (m.sloganSize || 0.035))
  // 中文字幕：用 textfile= 传文本，避开命令行里中文/引号的转义地狱
  const vf = [
    `scale=${w}:${h}:force_original_aspect_ratio=increase`,
    `crop=${w}:${h}`,
    `drawtext=fontfile=${FONT.replace(/:/g, '\\\\:')}:textfile=${tf.replace(/\\/g, '/').replace(/:/g, '\\\\:')}:fontcolor=white:fontsize=${fs2}:line_spacing=${Math.round(fs2 * 0.3)}:x=(w-text_w)/2:y=h*${m.textY ?? 0.72}:shadowcolor=black@0.55:shadowx=3:shadowy=3`,
  ].join(',')
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', baseFile, '-vf', vf, finalFile], { stdio: 'inherit' })
  fs.rmSync(tf, { force: true })
  return '底图 + 程序叠字'
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
    if (fs.existsSync(baseFile) && !flag('force')) { reused = true } else { const buf = await generate(prompt); fs.writeFileSync(baseFile, buf) }
    const how = overlay(baseFile, m, finalFile, size)
    const kb = Math.round(fs.statSync(finalFile).size / 1024)
    console.log(`  ✓ ${m.id}: ${reused ? '复用底图' : '新出底图'} + ${how} → ${path.basename(finalFile)}（${kb}KB, ${((Date.now() - t0) / 1000).toFixed(1)}s）`)
    manifest.push({ id: m.id, ratio: m.ratio || vs.ratio, file: finalFile, prompt, model: `${provider}/${modelId}`, at: new Date().toISOString() })
  } catch (e) {
    console.log(`  ✗ ${m.id}: ${String(e?.message || e).slice(0, 140)}`)
    manifest.push({ id: m.id, error: String(e?.message || e).slice(0, 200) })
  }
}
if (!flag('check')) {
  const mf = path.join(outDir, 'manifest.json')
  const old = fs.existsSync(mf) ? JSON.parse(fs.readFileSync(mf, 'utf8')) : []
  fs.writeFileSync(mf, JSON.stringify({ campaign: vs.campaign, visualSystem: vs, runs: [...old.runs || [], { at: new Date().toISOString(), items: manifest }] }, null, 2), 'utf8')
  console.log(`清单: ${mf}（改 visual-system.json 里任意一条，重跑即可全套更新）`)
}
