// 画布巡检（2026-10-19）。
// 来源：Lovart 2.0 的 Arti 最值得抄的一点——拿最初规范去核当前画布（它抓到过 1920×1088 差 8 像素）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { auditCanvasDoc, auditCanvas, formatAudit, normalizeBrief, briefIsEmpty } from '../../engine/canvas-audit.mjs'

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
  const doc = { nodes: [node('i', 'image', { text: '海报', provider: 'p', modelId: 'm', url: '/x.png', size: '1920x1088' })], edges: [] }
  const mismatch = await auditCanvas(doc, { brief: { ratios: { image: 1.7778 } }, verify: async () => ({ status: 'mismatch', width: 1920, height: 1088 }) })
  assert.ok(mismatch.issues.some((i) => i.code === 'ratio_mismatch'))
  assert.equal(mismatch.ok, false)

  const unknown = await auditCanvas(doc, { brief: { ratios: { image: 1.7778 } }, verify: async () => ({ status: 'unverified' }) })
  assert.ok(unknown.issues.some((i) => i.code === 'dimension_unverified' && i.level === 'info'))
  assert.equal(unknown.ok, true)
})

test('全景模板默认按 2:1 核，不用写规范', async () => {
  const doc = { nodes: [node('i', 'image', { text: '全景', provider: 'p', modelId: 'm', url: '/x.png', template: 'panorama', size: '2048x1024' })], edges: [] }
  let asked = ''
  await auditCanvas(doc, { verify: async (_u, _s, ratio) => { asked = ratio; return { status: 'matched', width: 2048, height: 1024 } } })
  assert.equal(asked, '2:1')
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
