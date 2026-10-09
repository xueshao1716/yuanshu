// canvas-nodes.mjs 测试：无限画布的纯逻辑（连线规则 / 继承 / 渲染守卫 / 序列化）
// 运行：node --test tests/unit/canvas-nodes.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NODE_KINDS, PANORAMA, CANVAS_LIMITS,
  createNode, buildPanoramaPrompt, buildPrompt,
  canConnect, addEdge, removeEdge, incoming,
  resolvePrompt, resolveConfig, imageReady, finalPrompt,
  RenderGuard, selectRenderable, clampZoom,
  screenToWorld, worldToScreen, zoomAt, nextPosition,
  serializeCanvas, parseCanvas,
} from '../../frontend/src/lib/canvas-nodes.mjs'

const P = () => createNode('prompt', { id: 'p1', x: 0, y: 0, text: '一条河，正午' })
const C = () => createNode('config', { id: 'c1', x: 400, y: 0, model: 'm-x', size: '1024x1024' })
const I = () => createNode('image', { id: 'i1', x: 800, y: 0, text: '兜底提示词' })

test('节点尺寸：全景图节点是 2:1 横盒，普通图是竖盒', () => {
  const pano = createNode('image', { template: 'panorama' })
  assert.equal(pano.w / pano.h, 2)
  assert.equal(pano.w, PANORAMA.nodeSize.width)
  const plain = createNode('image')
  assert.ok(plain.h > plain.w)
  assert.equal(NODE_KINDS.image.outputs.length, 0, '图片节点是终点，不再往外连')
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

test('连线：prompt/config 只能指向 image，image 是终点，自连与重复都拒', () => {
  const [p, c, i] = [P(), C(), I()]
  assert.equal(canConnect(p, i).ok, true)
  assert.equal(canConnect(c, i).ok, true)
  assert.equal(canConnect(i, p).ok, false, 'image 没有输出')
  assert.equal(canConnect(p, p).ok, false, '不能自连')
  assert.equal(canConnect(p, c).ok, false, 'config 不是终点')
  assert.equal(canConnect(undefined, i).ok, false)

  const r1 = addEdge([], p, i)
  assert.equal(r1.ok, true)
  assert.equal(r1.edges.length, 1)
  assert.equal(r1.edge.kind, 'prompt')
  const r2 = addEdge(r1.edges, p, i)
  assert.equal(r2.ok, false)
  assert.match(r2.reason, /已连接/)
  assert.equal(r2.edges.length, 1, '被拒的连线不能改坏 edges')
  assert.equal(removeEdge(r1.edges, r1.edge.id).length, 0)
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
  assert.equal(cfg.model, 'm-x')
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

test('RenderGuard：超过上限就踢最早的，同屏只保最近激活的 4 个', () => {
  assert.equal(CANVAS_LIMITS.render, 4)
  const g = new RenderGuard(4)
  assert.deepEqual(g.touch('a'), ['a'])
  assert.deepEqual(g.touch('b'), ['a', 'b'])
  g.touch('c'); g.touch('d')
  assert.deepEqual(g.ids, ['a', 'b', 'c', 'd'])
  g.touch('a')
  assert.deepEqual(g.ids, ['b', 'c', 'd', 'a'], '再次激活要移到队尾')
  assert.deepEqual(g.touch('e'), ['b', 'c', 'd', 'a', 'e'], '原始顺序留给界面决定踢谁')
  assert.deepEqual(g.evict(), ['b'], 'evict 返回被踢掉的那个')
  assert.equal(g.size, 4)
  assert.equal(g.has('b'), false)
  assert.equal(g.has('e'), true)
})

test('selectRenderable：超限的降级成静态图，不降级的不受影响', () => {
  const g = new RenderGuard(4)
  for (const id of ['n1', 'n2', 'n3', 'n4']) g.touch(id)
  g.touch('n1') // n1 最近激活，n2 变成最旧
  const r = selectRenderable(['n1', 'n2', 'n5'], g)
  assert.deepEqual(r.render, ['n1', 'n5'])
  assert.deepEqual(r.degraded, ['n2'], '最久没激活的降级')
})

test('缩放：夹在 0.2~3，且缩放锚在指针处', () => {
  assert.equal(clampZoom(99), 3)
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

test('nextPosition：按已有节点数量错开摆放，不重叠', () => {
  const a = nextPosition([], 'prompt')
  const b = nextPosition([createNode('prompt', { x: a.x, y: a.y })], 'prompt')
  assert.notEqual(b.y, a.y)
  assert.ok(b.y > a.y)
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
