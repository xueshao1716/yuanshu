import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { mergeMessages } from '../../frontend/src/lib/local-db.ts'

const localMessage = (overrides = {}) => ({
  id: 'local-message',
  sessionId: 'session-1',
  role: 'assistant',
  text: '',
  ts: '2026-08-31T10:00:00.000Z',
  synced: false,
  draft: true,
  ...overrides,
})

const serverMessage = (overrides = {}) => ({
  id: 'server-message',
  sessionId: 'session-1',
  role: 'assistant',
  text: '',
  ts: '2026-08-31T10:00:01.000Z',
  ...overrides,
})

const toolIds = messages => messages.flatMap(message => (message.tools || []).map(tool => tool.id))

test('复杂任务整轮缓存与分段历史合并：无工具的最终结论只显示一次', () => {
  const parts = ['先检查。', '已找到原因，继续验证。', '验证完成，这是最终结论。']
  const local = localMessage({
    text: parts.join(''), draft: false, synced: true,
    tools: [{ id: 'a' }, { id: 'b' }], engine: 'pi',
    ts: '2026-08-31T10:05:00.000Z',
  })
  const history = [
    serverMessage({ id: 'user', role: 'user', text: '检查一下' }),
    ...parts.map((text, i) => serverMessage({ id: `s${i}`, text,
      tools: i < 2 ? [{ id: i === 0 ? 'a' : 'b', output: '完成' }] : [],
      ts: `2026-08-31T10:0${i + 2}:00.000Z`,
    })),
    serverMessage({ id: 'attachment', text: '', files: [{ path: '/result.png' }] }),
  ]
  const result = mergeMessages([local], history)
  const assistants = result.filter(m => m.role === 'assistant')
  assert.equal(assistants.map(m => m.text).join(''), parts.join(''))
  assert.deepEqual(toolIds(assistants), ['a', 'b'])
  assert.equal(assistants[0].engine, 'pi')
  assert.deepEqual(assistants.flatMap(m => m.files || []), [{ path: '/result.png' }])
  assert.equal(local.text, parts.join(''), '不能修改传入的缓存')
})

test('整轮草稿是分段历史的前缀时补齐后续结论，保留草稿生命周期', () => {
  const result = mergeMessages([localMessage({ text: '检查。', tools: [{ id: 'a' }] })], [
    serverMessage({ id: 's1', text: '检查。', tools: [{ id: 'a', output: '完成' }] }),
    serverMessage({ id: 's2', text: '最终结论。' }),
  ])
  assert.equal(result.length, 1)
  assert.equal(result[0].text, '检查。最终结论。')
  assert.equal(result[0].draft, true)
})

test('相同结论属于另一个用户轮次时必须保留，不按全局子串去重', () => {
  const result = mergeMessages([localMessage({ text: '检查。结论。', tools: [{ id: 'a' }] })], [
    serverMessage({ id: 's1', text: '检查。', tools: [{ id: 'a' }] }),
    serverMessage({ id: 's2', text: '结论。' }),
    serverMessage({ id: 'u2', role: 'user', text: '再说一次' }),
    serverMessage({ id: 's3', text: '结论。' }),
  ])
  assert.equal(result.filter(m => m.role === 'assistant').map(m => m.text).join(''), '检查。结论。结论。')
})

test('工具相同但正文不构成整轮前缀时不吞掉服务端新增结论', () => {
  const result = mergeMessages([localMessage({ text: '本地尚未提交的内容', tools: [{ id: 'a' }] })], [
    serverMessage({ id: 's1', text: '服务端修订后的过程', tools: [{ id: 'a' }] }),
    serverMessage({ id: 's2', text: '服务端新增结论' }),
  ])
  assert.ok(result.some(m => m.text === '服务端新增结论'))
  assert.ok(result.some(m => m.text === '本地尚未提交的内容'))
})

test('历史刷新遇到正在流式的整轮快照时，不在实时消息旁再显示已提交的分段', () => {
  const live = localMessage({ text: '检查。正在汇总', streaming: true, tools: [{ id: 'a' }] })
  const history = [serverMessage({ id: 's1', text: '检查。', tools: [{ id: 'a', output: '完成' }] }),
    serverMessage({ id: 's2', text: '正在汇总' })]
  const visibleHistory = mergeMessages([live], history).filter(m => !m.draft)
  assert.equal(visibleHistory.length, 0, '整轮由独立的实时消息展示')
})

test('ChatArea 合并历史时使用最新实时快照，而非等待三秒一次的本地落盘', () => {
  const src = readFileSync(new URL('../../frontend/src/components/ChatArea.tsx', import.meta.url), 'utf8')
  assert.ok(src.includes('const liveSnapshot: LocalMessage | null = stream ?'), '实时快照须参与历史合并')
  assert.ok(src.includes('.concat(liveSnapshot ? [liveSnapshot] : [])'), '将实时快照传入 mergeMessages')
})

test('本地空文本工具消息与不同 message id 的服务端消息按 toolCallId 合并', () => {
  const merged = mergeMessages(
    [localMessage({ tools: [{ id: 'call-a', name: 'bash', argsText: 'pwd', output: '', running: true }] })],
    [serverMessage({ tools: [{ id: 'call-a', name: 'bash', args: { command: 'pwd' }, output: '/workspace', isError: false }] })],
  )

  assert.equal(merged.length, 1)
  assert.deepEqual(toolIds(merged), ['call-a'])
  assert.equal(merged[0].tools[0].output, '/workspace')
  assert.equal(merged[0].draft, true)
})

test('本地聚合工具与服务端分段消息归并后每个 toolCallId 仅一份且最终结果不丢', () => {
  const merged = mergeMessages(
    [localMessage({
      tools: [
        { id: 'call-a', name: 'bash', argsText: 'echo same', output: '', running: true },
        { id: 'call-b', name: 'bash', argsText: 'echo same', output: '', running: true },
      ],
    })],
    [
      serverMessage({ id: 'server-a', tools: [{ id: 'call-a', name: 'bash', args: { command: 'echo same' }, output: 'A done', isError: false }] }),
      serverMessage({ id: 'server-b', ts: '2026-08-31T10:00:02.000Z', tools: [{ id: 'call-b', name: 'bash', args: { command: 'echo same' }, output: 'B failed', isError: true }] }),
    ],
  )

  assert.equal(merged.length, 1)
  assert.deepEqual(toolIds(merged).sort(), ['call-a', 'call-b'])
  assert.equal(merged[0].tools.find(tool => tool.id === 'call-a').output, 'A done')
  assert.equal(merged[0].tools.find(tool => tool.id === 'call-b').output, 'B failed')
  assert.equal(merged[0].tools.find(tool => tool.id === 'call-b').isError, true)
  assert.equal(merged[0].draft, true)
})

test('同 id 的多条消息按 id 索引合并，不丢条也不复制', () => {
  const locals = Array.from({ length: 40 }, (_, i) => localMessage({
    id: 'm' + i,
    text: 'local-' + i,
    ts: `2026-08-31T10:00:${String(i).padStart(2, '0')}.000Z`,
    draft: false,
  }))
  const servers = Array.from({ length: 40 }, (_, i) => serverMessage({
    id: 'm' + i,
    text: 'server-' + i,
    ts: `2026-08-31T10:00:${String(i).padStart(2, '0')}.000Z`,
  }))
  const merged = mergeMessages(locals, servers)
  assert.equal(merged.length, 40)
  assert.equal(merged[0].id, 'm0')
  assert.equal(merged[39].id, 'm39')
  assert.equal(merged[7].text, 'local-7')
})

test('mergeMessages 用 Map 按 id / toolCallId 索引，禁止 O(n²) findIndex 扫全表', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'frontend', 'src', 'lib', 'local-db.ts'), 'utf8')
  const fn = src.split('export function mergeMessages')[1]?.split('export function')[0] || ''
  assert.ok(fn.includes('new Map'), '必须用 Map 索引')
  assert.doesNotMatch(fn, /merged\.findIndex/, '不得对整表 findIndex')
})
