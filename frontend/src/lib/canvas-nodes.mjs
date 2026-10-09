// 画布节点纯逻辑：节点工厂 / 提示词模板 / 连线派生 / 渲染守卫 / 序列化校验
// 复刻来源：文档/逆向-可乐AI无限画布架构.md（源码实证）
//  - 全景提示词三条硬约束（几何 / 负面清单 / 场景纯净）+ 文生、图生两条分支
//  - 配置节点把「模型 · 尺寸 · 模板」共享给下游图片节点
//  - 渲染守卫 LRU 上限，超限降级为占位卡片（原版 WebGL 上限 4，DOM 节点更便宜故放到 6）
// 这一文件不碰 DOM，可在 node --test 里直接跑。

export const CANVAS_LIMITS = {
  render: 6,
  zoom: { min: 0.2, max: 2.5 },
  node: { max: 4000 },
}

export const NODE_KINDS = {
  prompt: { label: '提示词', w: 300, h: 176, outputs: ['prompt'], inputs: [] },
  config: { label: '配置', w: 264, h: 168, outputs: ['config'], inputs: [] },
  image: { label: '图片', w: 300, h: 320, outputs: [], inputs: ['prompt', 'config'] },
}

export const NODE_STATUS = ['idle', 'running', 'done', 'error']

// ── 全景提示词（chunk 263015 原文实读）──
export const PANORAMA = {
  imageSize: '2:1',
  nodeSize: { width: 340, height: 170 },
  geometry: '等距柱状投影（equirectangular），画面比例严格 2:1，水平方向完整 360 度，垂直方向 180 度，观看者位于场景正中心，地平线落在画面垂直中心附近，左右边缘无缝衔接',
  negative: '不要横幅照片，不要 21:9 电影宽银幕，不要鱼眼圆形边框，不要多图拼接，不要文字、水印、边框或接缝',
  purity: '不要摄影师、相机、镜头、三脚架、头显或任何拍摄设备，不要分屏拼贴，不要画中画，不要小图',
  usage: '最终用途：适合作为 3D 导演台环境球内壁贴图',
}

let seq = 0

/** 图片节点尺寸：全景图按 2:1 横盒，普通图按竖盒（patch 显式给了 w/h 就以 patch 为准） */
export function nodeSizeFor(kind, template) {
  const meta = NODE_KINDS[kind]
  if (!meta) return { w: 300, h: 200 }
  if (kind === 'image' && template === 'panorama') {
    return { w: PANORAMA.nodeSize.width, h: PANORAMA.nodeSize.height }
  }
  return { w: meta.w, h: meta.h }
}

export function createNode(kind, patch = {}) {
  const meta = NODE_KINDS[kind]
  if (!meta) throw new Error(`未知节点类型：${kind}`)
  seq += 1
  const id = String(patch.id || `n${Date.now().toString(36)}${seq.toString(36)}`)
  const template = patch.template === 'panorama' ? 'panorama' : 'plain'
  const size = nodeSizeFor(kind, template)
  const base = {
    id,
    kind,
    x: 0, y: 0, w: size.w, h: size.h,
    title: String(patch.title || meta.label),
    text: '', template,
    model: '', size: '',
    provider: '', modelId: '',
    status: 'idle', url: '', error: '', ref: '',
  }
  return { ...base, ...patch, id, kind, template }
}

/** 全景提示词：userPrompt + 三条硬约束；hasReference 走「图生全景」分支 */
export function buildPanoramaPrompt(userPrompt, hasReference = false) {
  const u = String(userPrompt || '').trim() || '一个安静的场景'
  const head = hasReference
    ? `请基于参考图生成一张全景环境图：${u}。若参考图本身是全景图，保留主体只修几何；若不是全景图，则把它当场景参考，补全四周缺失的环境，禁止简单拉伸原图。`
    : `请生成一张全景环境图：${u}。`
  return `${head}${PANORAMA.geometry}。${PANORAMA.negative}。${PANORAMA.purity}。${PANORAMA.usage}。`
}

/** 普通提示词：原样 + 可选负面词；全景走 buildPanoramaPrompt */
export function buildPrompt({ userPrompt = '', template = 'plain', hasReference = false, negative = '' } = {}) {
  const u = String(userPrompt || '').trim()
  if (template === 'panorama') return buildPanoramaPrompt(u, hasReference)
  const n = String(negative || '').trim()
  return n ? `${u}。${n}` : u
}

/** 连线规则：只有图片节点能接收；提示词/配置节点才有输出；不能连自己 */
export function canConnect(from, to) {
  if (!from || !to) return { ok: false, reason: '缺少节点' }
  if (from.id === to.id) return { ok: false, reason: '不能连自己' }
  const outKind = from.kind === 'prompt' ? 'prompt' : from.kind === 'config' ? 'config' : ''
  if (!outKind) return { ok: false, reason: `${NODE_KINDS[from.kind]?.label || from.kind}节点没有输出` }
  if (to.kind !== 'image') return { ok: false, reason: `只有图片节点能接收连线` }
  if (!NODE_KINDS.image.inputs.includes(outKind)) return { ok: false, reason: '图片节点不接受这类输入' }
  return { ok: true, reason: '' }
}

/** 加连线：去重；同一图片节点的提示词输入只保留一条（新的替换旧的） */
export function addEdge(edges, from, to) {
  const check = canConnect(from, to)
  if (!check.ok) return { ok: false, reason: check.reason, edges }
  const list = Array.isArray(edges) ? edges : []
  const dup = list.some(e => e.from === from.id && e.to === to.id)
  if (dup) return { ok: true, reason: '已存在', edges: list }
  // 同一图片节点的「提示词输入」只保留一条：新连线顶掉旧的
  const src = from.kind
  const next = list.filter(e => !(e.to === to.id && edgeKind(e) === src))
  const edge = { id: `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, from: from.id, to: to.id, kind: from.kind }
  return { ok: true, reason: '', edges: [...next, edge], edge }
}

function edgeKind(e) { return e.kind === 'config' ? 'config' : 'prompt' }

export function removeEdge(edges, id) {
  return (Array.isArray(edges) ? edges : []).filter(e => e.id !== id)
}

export function incoming(nodeId, edges) {
  return (Array.isArray(edges) ? edges : []).filter(e => e.to === nodeId)
}

/** 图片节点的提示词来源：上游提示词节点优先，否则用自己写的 */
export function resolvePrompt(node, nodes, edges) {
  const list = Array.isArray(nodes) ? nodes : []
  if (node.kind === 'image') {
    const up = incoming(node.id, edges).map(e => list.find(n => n.id === e.from)).find(n => n && n.kind === 'prompt')
    if (up && String(up.text || '').trim()) return { text: up.text, sourceId: up.id, inherited: true }
  }
  return { text: String(node.text || ''), sourceId: null, inherited: false }
}

/**
 * 配置继承：上游配置节点提供「模型 · 尺寸 · 模板」，节点自己的填写优先。
 * model 只是给人看的展示串，真正发请求用 provider + modelId（/api/image 的契约，缺一个就 400）。
 */
export function resolveConfig(node, nodes, edges) {
  const list = Array.isArray(nodes) ? nodes : []
  let cfg = { provider: '', modelId: '', size: '', template: '', sourceId: null }
  if (node.kind === 'image') {
    const up = incoming(node.id, edges).map(e => list.find(n => n.id === e.from)).find(n => n && n.kind === 'config')
    if (up) cfg = { provider: up.provider || '', modelId: up.modelId || '', size: up.size || '', template: up.template || '', sourceId: up.id }
  }
  const provider = node.provider || cfg.provider
  const modelId = node.modelId || cfg.modelId
  const ownTemplate = node.template && node.template !== 'plain' ? node.template : ''
  return {
    provider,
    modelId,
    model: provider && modelId ? `${provider}/${modelId}` : (node.model || cfg.model || ''),
    size: node.size || cfg.size,
    template: ownTemplate || cfg.template,
    sourceId: provider || node.size || ownTemplate ? null : cfg.sourceId,
  }
}

/** 能不能出图：提示词和模型都齐了才放行 */
export function imageReady(node, nodes, edges) {
  const { text } = resolvePrompt(node, nodes, edges)
  if (!String(text || '').trim()) return { ok: false, reason: '还没有提示词：在节点里写一段，或从提示词节点连一条线进来' }
  const cfg = resolveConfig(node, nodes, edges)
  if (!cfg.provider || !cfg.modelId) return { ok: false, reason: '还没选出图模型：连一个配置节点，或在本节点上选模型' }
  return { ok: true, reason: '' }
}

/** 直接拼成 MediaApi.image 的请求体（/api/image 要 provider + modelId + prompt + size） */
export function imageRequest(node, nodes, edges) {
  const cfg = resolveConfig(node, nodes, edges)
  return {
    provider: cfg.provider,
    modelId: cfg.modelId,
    prompt: finalPrompt(node, nodes, edges),
    size: cfg.size || undefined,
  }
}

/** 最终送进 /api/image 的提示词 */
export function finalPrompt(node, nodes, edges) {
  const { text } = resolvePrompt(node, nodes, edges)
  const cfg = resolveConfig(node, nodes, edges)
  return buildPrompt({ userPrompt: text, template: cfg.template || 'plain', hasReference: !!node.ref })
}

// ── 渲染守卫：LRU 上限，超限降级 ──
export class RenderGuard {
  constructor(limit = CANVAS_LIMITS.render) {
    this.limit = Math.max(1, Number(limit) || 1)
    this.order = []
  }
  has(id) { return this.order.includes(id) }
  touch(id) {
    const i = this.order.indexOf(id)
    if (i >= 0) this.order.splice(i, 1)
    this.order.push(id)
    return this.evict()
  }
  evict() {
    const dropped = []
    while (this.order.length > this.limit) dropped.push(this.order.shift())
    return dropped
  }
  get ids() { return [...this.order] }
  get size() { return this.order.length }
}

/** 从候选（当前视口内）里挑出真正渲染的节点，其余降级为占位卡片 */
export function selectRenderable(candidates, guard) {
  const uniq = [...new Set((Array.isArray(candidates) ? candidates : []).filter(Boolean))]
  const rank = new Map(guard.ids.map((id, i) => [id, i]))
  uniq.sort((a, b) => (rank.get(b) ?? -1) - (rank.get(a) ?? -1))
  const render = uniq.slice(0, guard.limit)
  const degraded = uniq.slice(guard.limit)
  render.forEach(id => guard.touch(id))
  return { render, degraded }
}

// ── 视口换算（纯函数，便于单测）──
export function clampZoom(z) {
  const { min, max } = CANVAS_LIMITS.zoom
  const n = Number(z)
  if (!Number.isFinite(n)) return 1
  return Math.min(max, Math.max(min, n))
}

export function screenToWorld(pt, view) {
  const z = clampZoom(view?.z ?? 1)
  return { x: (pt.x - (view?.x ?? 0)) / z, y: (pt.y - (view?.y ?? 0)) / z }
}

export function worldToScreen(pt, view) {
  const z = clampZoom(view?.z ?? 1)
  return { x: pt.x * z + (view?.x ?? 0), y: pt.y * z + (view?.y ?? 0) }
}

/** 以指针为中心缩放：保持指针下的世界坐标不动 */
export function zoomAt(pointer, view, factor) {
  const z = clampZoom((view?.z ?? 1) * factor)
  const world = screenToWorld(pointer, view)
  return { z, x: pointer.x - world.x * z, y: pointer.y - world.y * z }
}

/** 新节点落点：网格扫一个不和现有节点重叠的位置 */
export function nextPosition(nodes, kind, size) {
  const list = Array.isArray(nodes) ? nodes : []
  const w = size?.w ?? NODE_KINDS[kind]?.w ?? 300
  const h = size?.h ?? NODE_KINDS[kind]?.h ?? 200
  const col = list.length % 4
  const row = Math.floor(list.length / 4)
  let x = 96 + col * 340
  let y = 96 + row * 380
  const hit = (a, b) => !(a.x + w + 24 < b.x || b.x + (b.w || 300) + 24 < a.x || a.y + h + 24 < b.y || b.y + (b.h || 200) + 24 < a.y)
  let guard = 0
  while (list.some(n => hit({ x, y, w, h }, n)) && guard < 60) { y += 60; guard += 1 }
  return { x, y }
}

// ── 序列化：导出 / 导入，带白名单校验 ──
const NODE_KEYS = ['id', 'kind', 'x', 'y', 'w', 'h', 'title', 'text', 'template', 'model', 'size', 'provider', 'modelId', 'status', 'url', 'error', 'ref']

export function serializeCanvas(doc) {
  return JSON.stringify({
    version: 1,
    nodes: (doc?.nodes || []).map(n => {
      const out = {}
      for (const k of NODE_KEYS) out[k] = n[k]
      return out
    }),
    edges: (doc?.edges || []).map(e => ({ id: e.id, from: e.from, to: e.to, kind: e.kind })),
    view: { x: Number(doc?.view?.x) || 0, y: Number(doc?.view?.y) || 0, z: clampZoom(doc?.view?.z ?? 1) },
  })
}

export function parseCanvas(text) {
  const errors = []
  let raw
  try { raw = JSON.parse(String(text)) } catch (e) { return { ok: false, doc: null, errors: ['不是合法 JSON：' + (e?.message || e)] } }
  const nodes = []
  const seen = new Set()
  for (const item of Array.isArray(raw?.nodes) ? raw.nodes : []) {
    if (!item || typeof item !== 'object') { errors.push('跳过非对象节点'); continue }
    if (!NODE_KINDS[item.kind]) { errors.push(`跳过未知类型节点：${item.kind}`); continue }
    const id = String(item.id || '')
    if (!id || seen.has(id)) { errors.push('跳过缺少 id 或 id 重复的节点'); continue }
    seen.add(id)
    const n = createNode(item.kind, item)
    const meta = NODE_KINDS[item.kind]
    for (const k of ['x', 'y']) if (!Number.isFinite(Number(n[k]))) n[k] = 0
    for (const k of ['w', 'h']) if (!Number.isFinite(Number(n[k])) || Number(n[k]) <= 0) n[k] = meta[k]
    if (!NODE_STATUS.includes(n.status)) n.status = 'idle'
    if (n.template !== 'panorama') n.template = 'plain'
    n.x = Math.max(-CANVAS_LIMITS.node.max, Math.min(CANVAS_LIMITS.node.max, Number(n.x) || 0))
    n.y = Math.max(-CANVAS_LIMITS.node.max, Math.min(CANVAS_LIMITS.node.max, Number(n.y) || 0))
    nodes.push(n)
  }
  const edges = []
  for (const e of Array.isArray(raw?.edges) ? raw.edges : []) {
    const from = nodes.find(n => n.id === e?.from)
    const to = nodes.find(n => n.id === e?.to)
    const check = canConnect(from, to)
    if (!check.ok) { errors.push(`跳过无效连线：${e?.from} → ${e?.to}（${check.reason}）`); continue }
    edges.push({ id: String(e.id || `e${Math.random().toString(36).slice(2, 8)}`), from: from.id, to: to.id, kind: from.kind })
  }
  const view = { x: Number(raw?.view?.x) || 0, y: Number(raw?.view?.y) || 0, z: clampZoom(raw?.view?.z ?? 1) }
  return { ok: nodes.length > 0, doc: { nodes, edges, view }, errors }
}

