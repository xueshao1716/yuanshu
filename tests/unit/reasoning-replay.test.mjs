// DeepSeek 思考模式 400 回归（2026-10-17 真机）：
// 带 tool_calls 的 assistant 消息若不回传 reasoning_content，整轮请求被拒：
// {"error":{"message":"The `reasoning_content` in the thinking mode must be passed back to the API."}}
// 复现：单轮内存内正常（adapter 保留了字段），一旦从会话存储重建历史就丢——
// 因为 formatSessionHistory 只搬 anthropic_content，没把 item.think 接回 reasoning_content。
import test from 'node:test'
import assert from 'node:assert/strict'
import { formatSessionHistory } from '../../engine/unified-chat.mjs'
import { restorePendingToolPlan } from '../../engine/resume-tool-plan.mjs'

const HIST = [
  {
    role: 'assistant',
    text: '我先读一下文件',
    think: '用户要读文件，先调用 read 工具。',
    tools: [{ id: 'c1', name: 'read', args: '{"path":"a.txt"}', output: 'hello' }],
  },
]

test('DeepSeek：重建历史时把 think 接回 reasoning_content', () => {
  const out = formatSessionHistory(HIST, { carryReasoning: true })
  const assistant = out.find(m => m.role === 'assistant' && m.tool_calls?.length)
  assert.ok(assistant, '应当重建出带 tool_calls 的 assistant 消息')
  assert.equal(assistant.tool_calls[0].id, 'c1')
  assert.equal(assistant.reasoning_content, '用户要读文件，先调用 read 工具。')
})

test('非 DeepSeek 目标模型：不得注入 reasoning_content（避免未知字段被上游拒）', () => {
  const out = formatSessionHistory(HIST, { carryReasoning: false })
  const assistant = out.find(m => m.role === 'assistant' && m.tool_calls?.length)
  assert.equal(assistant.reasoning_content, undefined)
  // 其余结构不受影响
  assert.equal(assistant.tool_calls[0].function.name, 'read')
})

test('缺省调用（未显式声明能力）也不注入', () => {
  const out = formatSessionHistory(HIST)
  assert.equal(out.find(m => m.tool_calls)?.reasoning_content, undefined)
})

test('没有 think 的历史不产生空 reasoning_content 字段', () => {
  const out = formatSessionHistory(
    [{ role: 'assistant', text: 'x', tools: [{ id: 'c2', name: 'read', args: '{}', output: '' }] }],
    { carryReasoning: true },
  )
  const assistant = out.find(m => m.tool_calls)
  assert.equal('reasoning_content' in assistant, false)
})

test('续跑重建：单条原响应保留 reasoning_content', () => {
  const history = [
    { role: 'user', content: '读文件' },
    {
      role: 'assistant',
      content: null,
      reasoning_content: 'need read first',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }],
    },
  ]
  restorePendingToolPlan(history, [{ id: 'c1', name: 'read', args: {} }])
  const assistant = history.find(m => m.role === 'assistant')
  assert.equal(assistant.reasoning_content, 'need read first')
})
