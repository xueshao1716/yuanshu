// canvas-nodes.mjs 测试：无限画布的纯逻辑（连线规则 / 继承 / 渲染守卫 / 序列化）
// 运行：node --test tests/unit/canvas-nodes.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NODE_KINDS, PANORAMA, CANVAS_LIMITS,
  createNode, buildPanoramaPrompt, buildPrompt,
  canConnect, addEdge, removeEdge, incoming,
  resolvePrompt, resolveConfig, resolveRefs, imageReady, imageRequest, finalPrompt,
  RenderGuard, selectRenderable, clampZoom,
  screenToWorld, worldToScreen, zoomAt, nextPosition,
  serializeCanvas, parseCanvas,
} from '../../frontend/src/lib/canvas-nodes.mjs'

const P = () => createNode('prompt', { id: 'p1', x: 0, y: 0, text: '一条河，正午' })
const C = () => createNode('config', { id: 'c1', x: 400, y: 0, provider: 'prov-x', modelId: 'm-x', size: '1024x1024' })
const I = () => createNode('image', { id: 'i1', x: 800, y: 0, text: '兜底提示词' })

test('节点尺寸：全景图节点是 2:1 横盒，普通图是竖盒', () => {
  const pano = createNode('image', { template: 'panorama' })
  assert.equal(pano.w / pano.h, 2)
  assert.equal(pano.w, PANORAMA.nodeSize.width)
  const plain = createNode('image')
  assert.ok(plain.h > plain.w)
  // 2026-10-18 改：图片节点现在能输出，用来做「连续参考」（上一张结果连到下一次生成）
  assert.deepEqual(NODE_KINDS.image.outputs, ['image'], '图片节点可作为参考图来源')
  assert.ok(NODE_KINDS.image.inputs.includes('image'), '图片节点也要能接收参考图')
  // patch 显式给了尺寸就以 patch 为准（导入旧画布时不强行改尺寸）
  assert.equal(createNode('image', { template: 'panorama', w: 300, h: 320 }).w, 300)
})

test('全景提示词：三条硬约束（几何 / 负面清单 / 场景纯净）+ 用途说明每次都注入', () => {
  const text = buildPanoramaPrompt('黄昏的雪山湖泊')
  assert.match(text, /黄昏的雪山湖泊/)
  assert.match(text, /equirectangular/)
  assert.match(text, /2:1/)
  assert.ok(text.includes(PANORAMA.negative), '负面清单要原样进提示词')
  assert.ok(text.includes(PANORAMA.purity), '场景纯净要禁拍摄设备')
  assert.ok(text.includes(PANORAMA.usage), '要说明用途是 3D 环境球贴图')
})

test('图生全景：带参考图时走「补全四周」分支，且禁止拉伸原图', () => {
  const t = buildPanoramaPrompt('同一个房间', true)
  assert.match(t, /参考图/)
  assert.match(t, /禁止简单拉伸原图/)
  assert.equal(buildPanoramaPrompt('', false), buildPanoramaPrompt('一个安静的场景', false), '空提示词有兜底场景')
})

test('plain 模板不注入任何约束，panorama 模板才注入', () => {
  assert.equal(buildPrompt({ userPrompt: '一只猫', template: 'plain' }), '一只猫')
  assert.match(buildPrompt({ userPrompt: '一只猫', template: 'panorama' }), /equirectangular/)
  assert.equal(buildPrompt({ userPrompt: '   ' }), '', '空白提示词不给下游发')
})

test('连线：prompt/config 只能指向 image，image 可作为参考图来源，自连与重复都拒', () => {
  const [p, c, i] = [P(), C(), I()]
  assert.equal(canConnect(p, i).ok, true)
  assert.equal(canConnect(c, i).ok, true)
  assert.equal(canConnect(i, p).ok, false, 'image 只能连到图片节点')
  assert.equal(canConnect(p, p).ok, false, '不能自连')
  assert.equal(canConnect(p, c).ok, false, 'config 不是终点')
  assert.equal(canConnect(undefined, i).ok, false)

  const r1 = addEdge([], p, i)
  assert.equal(r1.ok, true)
  assert.equal(r1.edges.length, 1)
  assert.equal(r1.edge.kind, 'prompt')
  // 同一条线重复连：静默去重（ok=true / 已存在），不产生新边
  const r2 = addEdge(r1.edges, p, i)
  assert.equal(r2.ok, true)
  assert.match(r2.reason, /已存在/)
  assert.equal(r2.edges.length, 1, '重复连线不产生新边')
  // 同类新源顶掉旧源：同一图片节点的提示词输入只保留一条
  const p2 = createNode('prompt', { id: 'p2', x: 0, y: 300, text: '另一条河' })
  const r3 = addEdge(r1.edges, p2, i)
  assert.equal(r3.ok, true)
  assert.equal(r3.edges.filter(e => e.kind === 'prompt' && e.to === 'i1').length, 1, '提示词输入只留最新')
  assert.equal(removeEdge(r3.edges, r3.edge.id).filter(e => e.id === r3.edge.id).length, 0)
})

test('提示词继承：图片节点没接提示词时用自己的兜底文案', () => {
  const p = P(), i = I()
  const r0 = resolvePrompt(i, [p, i], [])
  assert.equal(r0.inherited, false)
  assert.equal(r0.text, '兜底提示词')

  const { edges } = addEdge([], p, i)
  const r1 = resolvePrompt(i, [p, i], edges)
  assert.equal(r1.inherited, true)
  assert.equal(r1.text, '一条河，正午')
  assert.equal(r1.sourceId, 'p1')

  // 上游被删/不在节点表里时，回落到自己的兜底，不能抛异常
  const r2 = resolvePrompt(i, [i], edges)
  assert.equal(r2.inherited, false)
  assert.equal(r2.text, '兜底提示词')
})

test('配置继承：图片节点没填模型/尺寸时，接上的 config 说了算', () => {
  const c = C(), i = I()
  const { edges } = addEdge([], c, i)
  const cfg = resolveConfig(i, [c, i], edges)
  assert.equal(cfg.model, 'prov-x/m-x', 'model 展示串由 provider/modelId 拼出')
  assert.equal(cfg.provider, 'prov-x')
  assert.equal(cfg.modelId, 'm-x')
  assert.equal(cfg.size, '1024x1024')
  assert.equal(cfg.sourceId, 'c1')

  const own = createNode('image', { id: 'i2', model: 'm-own', size: '512x512' })
  const ownCfg = resolveConfig(own, [c, own], edges)
  assert.equal(ownCfg.model, 'm-own', '自己填了就不继承')
})

test('可生成判定：没有提示词或没有模型都要拦住，并说清原因', () => {
  const p = P(), c = C(), i = I()
  const e1 = addEdge([], p, i)
  const e2 = addEdge(e1.edges, c, i)
  assert.equal(imageReady(i, [p, c, i], e2.edges).ok, true)

  const bare = createNode('image', { id: 'i9' })
  const r = imageReady(bare, [bare], [])
  assert.equal(r.ok, false)
  assert.match(r.reason, /提示词/)

  const noModel = createNode('image', { id: 'i8', text: '有提示词' })
  const r2 = imageReady(noModel, [noModel], [])
  assert.equal(r2.ok, false)
  assert.match(r2.reason, /模型/)
})

test('finalPrompt：按节点自己的模板决定要不要注入全景约束', () => {
  const p = createNode('prompt', { id: 'p1', text: '海边日落' })
  const i = createNode('image', { id: 'i1', template: 'panorama' })
  const { edges } = addEdge([], p, i)
  assert.match(finalPrompt(i, [p, i], edges), /equirectangular/)
})

test('RenderGuard：LRU 上限 6，超限自动踢最老，再次激活移到队尾', () => {
  assert.equal(CANVAS_LIMITS.render, 6)
  const g = new RenderGuard(6)
  for (const id of ['a', 'b', 'c', 'd', 'e']) g.touch(id)
  assert.deepEqual(g.ids, ['a', 'b', 'c', 'd', 'e'])
  g.touch('a')
  assert.deepEqual(g.ids, ['b', 'c', 'd', 'e', 'a'], '再次激活要移到队尾')
  assert.deepEqual(g.touch('f'), [], '第 6 个进来正好到上限，无人被踢')
  assert.deepEqual(g.ids, ['b', 'c', 'd', 'e', 'a', 'f'])
  assert.deepEqual(g.touch('g'), ['b'], '第 7 个进来自动踢最老的 b 并返回被踢者')
  assert.deepEqual(g.ids, ['c', 'd', 'e', 'a', 'f', 'g'])
  assert.equal(g.size, 6)
  assert.equal(g.has('b'), false)
  assert.equal(g.has('g'), true)
})

test('selectRenderable：超过 guard 上限的降级成静态图，按激活新近排序', () => {
  const g = new RenderGuard(2)
  g.touch('n1'); g.touch('n2')
  g.touch('n1') // 顺序变 n2, n1（n1 最新）
  const r = selectRenderable(['n1', 'n2', 'n5'], g)
  assert.deepEqual(r.render, ['n1', 'n2'], 'guard 限额内按新近排序渲染')
  assert.deepEqual(r.degraded, ['n5'], 'guard 装不下的降级成静态图')
})

test('缩放：夹在 0.2~2.5，且缩放锚在指针处', () => {
  assert.equal(clampZoom(99), 2.5)
  assert.equal(clampZoom(0.01), 0.2)
  assert.equal(clampZoom(1.5), 1.5)

  const view = { x: 0, y: 0, z: 1 }
  const p = { x: 200, y: 100 }
  const w0 = screenToWorld(p, view)
  const v1 = zoomAt(p, view, 2)
  assert.equal(v1.z, 2)
  const w1 = screenToWorld(p, v1)
  assert.ok(Math.abs(w1.x - w0.x) < 1e-6 && Math.abs(w1.y - w0.y) < 1e-6, '指针下的世界坐标不能漂移')
  const back = worldToScreen(w1, v1)
  assert.ok(Math.abs(back.x - p.x) < 1e-6)
})

test('nextPosition：4 列横向错开摆放，放不下自动下移', () => {
  const a = nextPosition([], 'prompt')
  assert.equal(a.x, 96); assert.equal(a.y, 96)
  const nodeA = createNode('prompt', { x: a.x, y: a.y })
  const b = nextPosition([nodeA], 'prompt')
  assert.equal(b.x, a.x + 340, '第 2 个节点横向错开一格')
  const row = [nodeA]
  let last = a
  for (let k = 0; k < 3; k++) { last = nextPosition(row, 'prompt'); row.push(createNode('prompt', { x: last.x, y: last.y })) }
  const below = nextPosition(row, 'prompt')
  assert.ok(below.y > a.y, '一行放满后往下找空位')
})

test('序列化：导出可再导入，坏数据被剔掉并报出来', () => {
  const doc = {
    nodes: [P(), C(), I()],
    edges: addEdge(addEdge([], P(), I()).edges, C(), I()).edges,
    view: { x: 10, y: -20, z: 1.5 },
  }
  const back = parseCanvas(serializeCanvas(doc))
  assert.equal(back.ok, true)
  assert.equal(back.doc.nodes.length, 3)
  assert.equal(back.doc.edges.length, 2)
  assert.deepEqual(back.doc.view, doc.view)

  const broken = parseCanvas('{"nodes":[{"id":"x","kind":"nope"},{"id":"y","kind":"image","text":"在的"}],"edges":[{"id":"e","from":"x","to":"y","kind":"prompt"}],"view":{}}')
  assert.equal(broken.ok, true, '整体可读，坏节点单独丢'
  )
  assert.equal(broken.doc.nodes.length, 1)
  assert.equal(broken.doc.edges.length, 0, '指向不存在节点的边要丢')
  assert.ok(broken.errors.length >= 2)

  assert.equal(parseCanvas('不是 JSON').ok, false)
  assert.equal(parseCanvas('[]').ok, false, '顶层必须是对象')
})

test('parseCanvas：非法坐标/尺寸回落到默认值，不会出现 NaN', () => {
  const r = parseCanvas('{"nodes":[{"id":"i","kind":"image","x":"abc","w":-5,"h":null,"status":"飞"}],"edges":[]}')
  const n = r.doc.nodes[0]
  assert.equal(n.x, 0)
  assert.equal(n.w, NODE_KINDS.image.w)
  assert.equal(n.h, NODE_KINDS.image.h)
  assert.equal(n.status, 'idle')
  assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y))
})

// ── 连续参考（2026-10-18）：上一张结果连到下一次生成 ─────────────────
test('连续参考：image → image 可连，且允许多条', () => {
  const a = createNode('image', { id: 'a', text: '产品主视觉', url: '/api/ws/file?path=x.png' })
  const b = createNode('image', { id: 'b', text: '森林场景', url: '/api/ws/file?path=y.png' })
  const c = createNode('image', { id: 'c', text: '城市场景' })
  assert.equal(canConnect(a, c).ok, true, '图片节点可以作为参考图来源')

  let edges = addEdge([], a, c).edges
  edges = addEdge(edges, b, c).edges
  assert.equal(edges.length, 2, '参考图可以连多张（产品 + 人物）')
  assert.ok(edges.every(e => e.kind === 'image'))

  const refs = resolveRefs(c, [a, b, c], edges)
  assert.deepEqual(refs.map(r => r.id), ['a', 'b'])
})

test('参考图只取已经出图的节点（没 url 的跳过，不报错）', () => {
  const a = createNode('image', { id: 'a', url: '/api/ws/file?path=a.png' })
  const b = createNode('image', { id: 'b', url: '' })
  const t = createNode('image', { id: 't' })
  const edges = [addEdge([], a, t).edge, addEdge([], b, t).edge]
  assert.deepEqual(resolveRefs(t, [a, b, t], edges).map(r => r.id), ['a'])
})

test('imageRequest 带上第一张参考图', () => {
  const a = createNode('image', { id: 'a', url: '/api/ws/file?path=a.png' })
  const t = createNode('image', { id: 't', text: '把产品放进森林', provider: 'prov', modelId: 'm' })
  const edges = addEdge([], a, t).edges
  const body = imageRequest(t, [a, t], edges)
  assert.equal(body.image, '/api/ws/file?path=a.png')
  assert.equal(body.provider, 'prov')
  assert.match(body.prompt, /把产品放进森林/)
})

test('没有上游参考图时回落到节点自己的 ref 字段；都没有就不带 image', () => {
  const t = createNode('image', { id: 't', text: 'x', provider: 'p', modelId: 'm', ref: '/api/ws/file?path=own.png' })
  assert.equal(imageRequest(t, [t], []).image, '/api/ws/file?path=own.png')
  const plain = createNode('image', { id: 'z', text: 'y', provider: 'p', modelId: 'm' })
  assert.equal('image' in imageRequest(plain, [plain], []), false, '没有参考图就不该带这个字段')
})

test('有参考图时全景模板走「补全四周」分支', () => {
  const a = createNode('image', { id: 'a', url: '/api/ws/file?path=a.png' })
  const t = createNode('image', { id: 't', text: '雪山', template: 'panorama', provider: 'p', modelId: 'm' })
  const edges = addEdge([], a, t).edges
  const prompt = finalPrompt(t, [a, t], edges)
  assert.match(prompt, /基于参考图生成一张全景环境图/)
})

test('提示词输入仍然只保留一条（新连线顶掉旧的），参考图不受影响', () => {
  const p1 = createNode('prompt', { id: 'p1', text: '甲' })
  const p2 = createNode('prompt', { id: 'p2', text: '乙' })
  const a = createNode('image', { id: 'a', url: '/api/ws/file?path=a.png' })
  const t = createNode('image', { id: 't' })
  let edges = addEdge([], p1, t).edges
  edges = addEdge(edges, a, t).edges
  edges = addEdge(edges, p2, t).edges
  assert.equal(edges.filter(e => e.kind === 'prompt').length, 1, '提示词只留一条')
  assert.equal(edges.filter(e => e.kind === 'image').length, 1, '参考图不被顶掉')
  assert.deepEqual(resolvePrompt(t, [p1, p2, a, t], edges).text, '乙')
})
