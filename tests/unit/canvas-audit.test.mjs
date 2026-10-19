// 画布巡检（2026-10-19）。
// 来源：Lovart 2.0 的 Arti 最值得抄的一点——拿最初规范去核当前画布（它抓到过 1920×1088 差 8 像素）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { auditCanvasDoc, auditCanvas, formatAudit, normalizeBrief, briefIsEmpty, localPathFromUrl, dimensionsFromFile } from '../../engine/canvas-audit.mjs'

const node = (id, kind, extra = {}) => ({ id, kind, x: 0, y: 0, text: '', url: '', provider: '', modelId: '', size: '', template: 'plain', title: kind, ...extra })
const edge = (from, to, kind) => ({ id: `${from}-${to}`, from, to, kind })

test('规范只收四类可核对项，脏数据被丢掉', () => {
  const b = normalizeBrief({ deliverables: ['主海报', 123, '竖版'], requiredText: ['研究样片'], forbidden: ['奖杯'], ratios: { image: 1.7778, video: 'x' } })
  assert.deepEqual(b.deliverables, ['主海报', '竖版'])
  assert.deepEqual(b.requiredText, ['研究样片'])
  assert.deepEqual(b.forbidden, ['奖杯'])
  assert.deepEqual(Object.keys(b.ratios), ['image'])
  assert.equal(briefIsEmpty({}), true)
})

test('空画布给提醒而不是报错', () => {
  const r = auditCanvasDoc({ nodes: [], edges: [] })
  assert.equal(r.ok, true)
  assert.equal(r.issues[0].code, 'empty_canvas')
})

test('媒体节点缺提示词/缺模型/没出图分别报出来', () => {
  const doc = { nodes: [node('i1', 'image')], edges: [] }
  const codes = auditCanvasDoc(doc).issues.map((i) => i.code)
  assert.ok(codes.includes('media_without_prompt'))
  assert.ok(codes.includes('media_without_model'))
  assert.ok(codes.includes('media_not_generated'))
})

test('提示词连进来的也算有提示词（与画布语义一致）', () => {
  const doc = {
    nodes: [node('p', 'prompt', { text: '产品主视觉' }), node('i', 'image', { provider: 'p', modelId: 'm', url: '/x.png' })],
    edges: [edge('p', 'i', 'prompt')],
  }
  const codes = auditCanvasDoc(doc).issues.map((i) => i.code)
  assert.ok(!codes.includes('media_without_prompt'))
})

test('规范要求出现的文案没写 → error；禁止的词出现 → error', () => {
  const doc = { nodes: [node('p', 'prompt', { text: '用奖杯庆祝' }), node('i', 'image', { text: '海报', provider: 'p', modelId: 'm', url: '/x.png' })], edges: [] }
  const r = auditCanvasDoc(doc, { brief: { requiredText: ['研究样片'], forbidden: ['奖杯'] } })
  const codes = r.issues.map((i) => i.code)
  assert.ok(codes.includes('required_text_missing'))
  assert.ok(codes.includes('forbidden_word_present'))
  assert.equal(r.ok, false)
})

test('交付件数不够 → warn 而不是 error', () => {
  const doc = { nodes: [node('i', 'image', { text: 'a', provider: 'p', modelId: 'm', url: '/x.png' })], edges: [] }
  const r = auditCanvasDoc(doc, { brief: { deliverables: ['主海报', '竖版', '方卡'] } })
  assert.equal(r.ok, true)
  assert.ok(r.issues.some((i) => i.code === 'deliverables_short' && i.level === 'warn'))
})

test('尺寸核验：比例不符报 error，读不到只记 info', async () => {
  const doc = { nodes: [node('i', 'image', { text: '海报', provider: 'p', modelId: 'm', url: '/x.png', size: '1920x1200' })], edges: [] }
  // 1920x1200 = 1.6，规范要 16:9(1.7778) → 差 10%，必须报
  const mismatch = await auditCanvas(doc, { brief: { ratios: { image: 1.7778 } }, verify: async () => ({ width: 1920, height: 1200 }) })
  assert.ok(mismatch.issues.some((i) => i.code === 'ratio_mismatch'))
  assert.equal(mismatch.ok, false)

  const unknown = await auditCanvas(doc, { brief: { ratios: { image: 1.7778 } }, verify: async () => null })
  assert.ok(unknown.issues.some((i) => i.code === 'dimension_unverified' && i.level === 'info'))
  assert.equal(unknown.ok, true)
})

test('全景模板默认按 2:1 核，不用写规范', async () => {
  const make = (h) => ({ nodes: [node('i', 'image', { text: '全景', provider: 'p', modelId: 'm', url: '/x.png', template: 'panorama' })], edges: [] })
  const ok = await auditCanvas(make(1024), { verify: async () => ({ width: 2048, height: 1024 }) })
  assert.ok(!ok.issues.some((i) => i.code === 'ratio_mismatch'), '正好 2:1 不该报')
  const bad = await auditCanvas(make(1500), { verify: async () => ({ width: 2048, height: 1500 }) })
  assert.ok(bad.issues.some((i) => i.code === 'ratio_mismatch' && /2:1/.test(i.message)), '偏离 2:1 要报')
})

test('formatAudit 汇总条数并给可读结论', () => {
  const text = formatAudit({ ok: false, issues: [
    { level: 'error', code: 'x', message: 'A' },
    { level: 'warn', code: 'y', message: 'B' },
  ] })
  assert.match(text, /1 个问题、1 个提醒/)
  assert.match(text, /❌ \[x\] A/)
  assert.match(text, /⚠️ \[y\] B/)
})

test('本地结果文件：直读文件头核比例（画布地址多是相对路径）', async () => {
  // 造一张 100x50 的 PNG（2:1），再用 1:1 的规范去核 → 应报比例错误
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000064000000320806000000', 'hex')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-probe-'))
  fs.mkdirSync(path.join(dir, '生成物'), { recursive: true })
  const file = path.join(dir, '生成物', 'a.png')
  fs.writeFileSync(file, png)
  const url = `/api/ws/file?path=${encodeURIComponent('生成物/a.png')}`
  assert.equal(localPathFromUrl(dir, url), path.resolve(file))
  assert.equal(dimensionsFromFile(file)?.width, 100)
  const doc = { nodes: [node('i', 'image', { text: 'a', provider: 'p', modelId: 'm', url, title: 'a' })], edges: [] }
  const r = await auditCanvas(doc, { brief: { ratios: { image: 1 } }, wsRoot: dir })
  assert.ok(r.issues.some((i) => i.code === 'ratio_mismatch'), JSON.stringify(r.issues))
})

test('工作区外的路径不许读（防越界）', () => {
  assert.equal(localPathFromUrl('C:/ws', '/api/ws/file?path=' + encodeURIComponent('../../etc/passwd')), '')
})
