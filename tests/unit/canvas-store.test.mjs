// 画布服务端存储 + 模型工具（2026-10-18）。
// 背景：画布原先只存在浏览器 localStorage，模型完全碰不到；
// 现在落盘到 记忆/运行时/画布.json，模型用 canvas 工具读写，前端与服务端共用同一份。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  normalizeCanvasDoc, readCanvasDoc, writeCanvasDoc, canvasSummary,
  canvasExtraExecutors, emptyCanvas, CANVAS_TOOL_SCHEMA,
} from '../../engine/canvas.mjs'

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-canvas-'))

const node = (id, kind, extra = {}) => ({ id, kind, x: 0, y: 0, text: '', ...extra })

test('空画布可直接读，不抛错', () => {
  const root = tmpRoot()
  const doc = readCanvasDoc(root)
  assert.equal(doc.nodes.length, 0)
  assert.equal(doc.revision, 0)
})

test('规范化：未知类型、重复 id、悬空连线、文本节点输出都被丢掉', () => {
  const { doc, errors } = normalizeCanvasDoc({
    nodes: [node('a', 'prompt'), node('a', 'prompt'), node('b', 'wat'), node('c', 'image')],
    edges: [
      { from: 'a', to: 'c' },        // 合法：提示词 → 图片
      { from: 'a', to: 'c' },        // 重复
      { from: 'zzz', to: 'c' },      // 悬空
      { from: 'a', to: 'a' },        // 自连
    ],
  })
  assert.equal(doc.nodes.length, 2, '只留 a/c')
  assert.equal(doc.edges.length, 1)
  assert.ok(errors.length >= 3)
})

test('图片节点可以作为来源（连续参考），且允许多条', () => {
  const { doc } = normalizeCanvasDoc({
    nodes: [node('p1', 'image'), node('p2', 'image'), node('t', 'image')],
    edges: [{ from: 'p1', to: 't' }, { from: 'p2', to: 't' }],
  })
  assert.equal(doc.edges.length, 2)
  assert.ok(doc.edges.every((e) => e.kind === 'image'))
})

test('提示词/配置每个目标只保留一条', () => {
  const { doc } = normalizeCanvasDoc({
    nodes: [node('a', 'prompt'), node('b', 'prompt'), node('t', 'image')],
    edges: [{ from: 'a', to: 't' }, { from: 'b', to: 't' }],
  })
  assert.equal(doc.edges.filter((e) => e.kind === 'prompt').length, 1, '只留一条提示词输入')
})

test('落盘 + revision 递增 + 读回一致', () => {
  const root = tmpRoot()
  const r1 = writeCanvasDoc(root, { nodes: [node('a', 'prompt', { text: '产品主视觉' })], edges: [] })
  assert.equal(r1.doc.revision, 1)
  const r2 = writeCanvasDoc(root, { ...r1.doc, nodes: [...r1.doc.nodes, node('b', 'image')] })
  assert.equal(r2.doc.revision, 2)
  const back = readCanvasDoc(root)
  assert.equal(back.nodes.length, 2)
  assert.equal(back.revision, 2)
  assert.ok(fs.existsSync(path.join(root, '记忆', '运行时', '画布.json')))
})

test('摘要能看出节点、模型与连线', () => {
  const doc = { ...emptyCanvas(), revision: 3, nodes: [
    node('p', 'prompt', { text: '把产品放进森林' }),
    node('i', 'image', { provider: 'prov', modelId: 'm1' }),
  ], edges: [{ id: 'e1', from: 'p', to: 'i', kind: 'prompt' }] }
  const text = canvasSummary(doc)
  assert.match(text, /revision 3/)
  assert.match(text, /把产品放进森林/)
  assert.match(text, /prov\/m1/)
  assert.match(text, /p → i/)
})

test('工具：她能搭出一条提示词→图片的链', () => {
  const root = tmpRoot()
  const exec = canvasExtraExecutors(root).canvas
  const a = exec({ action: 'add_node', kind: 'prompt', text: '产品主视觉' })
  assert.equal(a.isError, false)
  const pId = /节点 (n[0-9a-z]+)/.exec(a.text)[1]
  const b = exec({ action: 'add_node', kind: 'image', provider: 'prov', modelId: 'm1' })
  const iId = /节点 (n[0-9a-z]+)/.exec(b.text)[1]
  const c = exec({ action: 'connect', from: pId, to: iId })
  assert.equal(c.isError, false, c.text)
  const doc = readCanvasDoc(root)
  assert.equal(doc.nodes.length, 2)
  assert.equal(doc.edges.length, 1)
  assert.equal(doc.edges[0].kind, 'prompt')
})

test('工具：非法操作被拒且不改文档', () => {
  const root = tmpRoot()
  const exec = canvasExtraExecutors(root).canvas
  const img = exec({ action: 'add_node', kind: 'image' })
  const iId = /节点 (n[0-9a-z]+)/.exec(img.text)[1]
  assert.equal(exec({ action: 'add_node', kind: 'gif' }).isError, true, '未知类型')
  assert.equal(exec({ action: 'connect', from: iId, to: 'nope' }).isError, true, '悬空 id')
  assert.equal(exec({ action: 'connect', from: iId, to: iId }).isError, true, '自连')
  assert.equal(exec({ action: 'update_node', nodeId: 'nope', text: 'x' }).isError, true)
  assert.equal(readCanvasDoc(root).nodes.length, 1)
  assert.equal(readCanvasDoc(root).edges.length, 0)
})

test('工具：改节点、删节点（连带删线）、清空', () => {
  const root = tmpRoot()
  const exec = canvasExtraExecutors(root).canvas
  const p = exec({ action: 'add_node', kind: 'prompt', text: 'a' })
  const pId = /节点 (n[0-9a-z]+)/.exec(p.text)[1]
  const i = exec({ action: 'add_node', kind: 'image' })
  const iId = /节点 (n[0-9a-z]+)/.exec(i.text)[1]
  exec({ action: 'connect', from: pId, to: iId })

  exec({ action: 'update_node', nodeId: iId, provider: 'p2', modelId: 'm2', size: '1024x1024' })
  const after = readCanvasDoc(root).nodes.find((n) => n.id === iId)
  assert.equal(after.provider, 'p2')
  assert.equal(after.modelId, 'm2')

  exec({ action: 'remove_node', nodeId: pId })
  const doc = readCanvasDoc(root)
  assert.equal(doc.nodes.length, 1)
  assert.equal(doc.edges.length, 0, '删节点要连带删线')

  const cleared = exec({ action: 'clear' })
  assert.equal(cleared.isError, false)
  assert.equal(readCanvasDoc(root).nodes.length, 0)
})

test('schema：action 必填，节点类型六种（含视频/音频）', () => {
  assert.equal(CANVAS_TOOL_SCHEMA.function.name, 'canvas')
  assert.deepEqual(CANVAS_TOOL_SCHEMA.function.parameters.required, ['action'])
  assert.deepEqual(
    CANVAS_TOOL_SCHEMA.function.parameters.properties.kind.enum,
    ['text', 'prompt', 'config', 'image', 'video', 'audio'],
  )
})

test('视频节点能接提示词/配置/参考图，音频只接提示词', () => {
  const root = tmpRoot()
  const exec = canvasExtraExecutors(root).canvas
  const id = (t) => /节点 (n[0-9a-z]+)/.exec(t)[1]
  const p = id(exec({ action: 'add_node', kind: 'prompt', text: '海边的镜头' }).text)
  const img = id(exec({ action: 'add_node', kind: 'image' }).text)
  const v = id(exec({ action: 'add_node', kind: 'video' }).text)
  const a = id(exec({ action: 'add_node', kind: 'audio' }).text)

  assert.equal(exec({ action: 'connect', from: p, to: v }).isError, false, '视频接提示词')
  assert.equal(exec({ action: 'connect', from: img, to: v }).isError, false, '视频接参考图')
  assert.equal(exec({ action: 'connect', from: p, to: a }).isError, false, '音频接提示词')
  assert.equal(exec({ action: 'connect', from: img, to: a }).isError, true, '音频不接参考图')
  assert.equal(exec({ action: 'connect', from: v, to: img }).isError, true, '视频没有输出')
  assert.equal(readCanvasDoc(root).nodes.length, 4)
})
