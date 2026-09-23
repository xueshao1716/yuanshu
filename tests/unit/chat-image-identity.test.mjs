import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeMessages } from '../../frontend/src/lib/local-db.ts'
import { StreamAssembler } from '../../frontend/src/lib/stream-assembler.ts'
import { reconcileImageMessages } from '../../frontend/src/lib/image-identity.ts'

const remote = 'https://images.example.com/generated/image.png'
const target = 'D:/pi-workspace/生成物/图片/安睡 图.png'
const local = '/api/ws/file?path=' + encodeURIComponent('生成物/图片/安睡 图.png')
const copy = { id: 'download', name: 'bash', running: false, isError: false,
  args: { command: `mkdir -p "D:/pi-workspace/生成物/图片" && curl -sL -o "${target}" "${remote}" && file "${target}"` },
  output: `${target}: PNG image data` }
const message = (overrides = {}) => ({ id: 'a1', sessionId: 's1', role: 'assistant', text: '完成',
  ts: '2026-09-21T13:01:00Z', synced: true, draft: false, ...overrides })
const images = result => result.flatMap(m => m.images || [])

test('真实流式工具参数与完成状态立即用于图片关联，无需等待下一段文字', () => {
  let stream = { images: [remote, local], tools: [] }
  const asm = new StreamAssembler(snap => {
    stream = reconcileImageMessages([{ ...stream, tools: snap.tools }])[0]
  })
  try {
    asm.toolStart({ id: copy.id, name: copy.name, args: copy.args })
    assert.equal(stream.tools[0]?.running, true, '工具开始立即发布')
    asm.toolEnd(copy.id, false, copy.output)
    assert.equal(stream.tools[0]?.running, false, '完成后没有文字也必须更新')
    assert.deepEqual(stream.images, [local])
  } finally { asm.dispose() }
})

test('下载同一生图后，本地缓存的在线预览被本地图片替换', () => {
  const cached = message({ images: [remote, local], tools: [copy] })
  assert.deepEqual(images(mergeMessages([cached], [])), [local])
  assert.deepEqual(cached.images, [remote, local], '不修改原始记录')
})

test('分段历史中的下载工具和文件交付共同确认本地副本', () => {
  const history = [message({ images: [remote] }), message({ id: 'a2', tools: [copy] }),
    message({ id: 'a3', files: [{ path: target }] })]
  assert.deepEqual(images(mergeMessages([], history)), [local])
})

test('旧快照已合并正文后仍需清理重复图片，刷新保持一张', () => {
  const cached = message({ text: '生成。保存。', images: [remote, local], tools: [copy] })
  const history = [message({ id: 's1', text: '生成。', images: [remote], tools: [copy] }),
    message({ id: 's2', text: '保存。', files: [{ path: target }] })]
  const first = mergeMessages([cached], history)
  assert.deepEqual(images(first), [local])
  assert.deepEqual(images(mergeMessages(first, history)), [local])
})

test('同路径不同签名去重，不合并不同图片或不同轮次', () => {
  const other = '/api/ws/file?path=' + encodeURIComponent('生成物/其他/安睡 图.png')
  const user = message({ id: 'u2', role: 'user', text: '再看一次' })
  const result = mergeMessages([], [message({ images: [local, local + '&token=old', other] }), user,
    message({ id: 'a2', text: '再次展示', images: [local] })])
  assert.deepEqual(images(result), [local, other, local])
})

test('下载失败、仍在运行或只有含糊路径不得隐藏在线图片', () => {
  for (const tool of [{ ...copy, isError: true }, { ...copy, running: true },
    { ...copy, status: 'canceled' }, { ...copy, args: { command: `echo "${remote}" "${target}"` } }]) {
    assert.deepEqual(images(mergeMessages([message({ images: [remote, local], tools: [tool] })], [])), [remote, local])
  }
})

test('相同文件名不同网址不得合并；没有本地交付证据时保留原图', () => {
  const other = 'https://other.example.com/generated/image.png'
  assert.deepEqual(images(mergeMessages([message({ images: [remote, other], tools: [copy] })], [])), [remote, other])
})
