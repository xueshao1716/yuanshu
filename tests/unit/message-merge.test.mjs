import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeMessages as loadableMerge } from '../../frontend/src/lib/local-db.ts'
const loadMerge = () => loadableMerge

const fullText = '横版出货！1312×736，精确 16:9，像素验证通过。这是破案说明：我自带工具和创意工坊走的是两条链，宿主 media 层不传 size 参数，agnes 默认输出方图；而创意工坊走 /api/image 直接透传尺寸参数，agnes 认这个参数所以出的是横版。以后出横版竖版直接走创意工坊同款参数，不再撞方图墙。'
const partialText = fullText.slice(0, 120)

test('流式半截本地副本 + 服务端全文：三层失配时按前缀关系归并为一条，text 取全文', () => {
  const mergeMessages = loadMerge()
  const local = [{
    id: 'a_local_1758360000000', sessionId: 's1', role: 'assistant',
    text: partialText, ts: '2026-09-20T10:00:00.000Z', synced: false, draft: false, streaming: false,
  }]
  const server = [
    { id: 'srv_aa01', role: 'user', text: '画这个，横版', ts: '2026-09-20T09:59:00.000Z' },
    // 服务端 ts = 回合完成时刻，与本地流式开始差 5 分钟（超过旧版 2 分钟窗口）
    { id: 'srv_aa02', role: 'assistant', text: fullText, ts: '2026-09-20T10:05:00.000Z' },
  ]
  const out = mergeMessages(local, server)
  const assistants = out.filter(m => m.role === 'assistant')
  assert.equal(assistants.length, 1, `assistant 应归并为 1 条，实际 ${assistants.length}`)
  assert.equal(assistants[0].text, fullText, '合并后 text 应为服务端全文（取更长版本）')
})

test('真实重复的短消息不被前缀逻辑误合并', () => {
  const mergeMessages = loadMerge()
  const local = [{ id: 'u_local_1', sessionId: 's1', role: 'user', text: '你是谁', ts: '2026-09-20T09:00:00.000Z', synced: true }]
  const server = [{ id: 'srv_b01', role: 'user', text: '你是谁？请详细介绍你自己', ts: '2026-09-20T09:01:00.000Z' }]
  const out = mergeMessages(local, server)
  assert.equal(out.length, 2, '短消息（<80字）即便构成前缀也不得自动归并')
})

test('既有行为回归：相同 id 仍归并为一条', () => {
  const mergeMessages = loadMerge()
  const local = [{ id: 'same_id', sessionId: 's1', role: 'assistant', text: '本地版本', ts: '2026-09-20T10:00:00.000Z', synced: true }]
  const server = [{ id: 'same_id', role: 'assistant', text: '本地版本', ts: '2026-09-20T10:00:00.000Z' }]
  const out = mergeMessages(local, server)
  assert.equal(out.length, 1)
  assert.equal(out[0].text, '本地版本')
})
