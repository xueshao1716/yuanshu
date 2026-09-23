import test from 'node:test'
import assert from 'node:assert/strict'

import { StreamAssembler } from '../../frontend/src/lib/stream-assembler.ts'

// 工厂：flushDelayMs 调大以避免测试期间定时器触发，手动 flushNow 保证确定性
function make() {
  const flushes = []
  const asm = new StreamAssembler(snap => flushes.push(snap), { flushDelayMs: 60_000 })
  return { asm, flushes }
}

test('已刷新思考后，结束事件仍立即发布完成状态', () => {
  const { asm, flushes } = make()
  try {
    asm.addThink('思考')
    asm.flushNow()
    asm.endThink()
    assert.equal(flushes.length, 2)
    assert.equal(flushes[1].thinkDone, true)
    asm.flushNow()
    assert.equal(flushes.length, 2)
  } finally { asm.dispose() }
})

test('纯问答：delta 全部进过程文字，不产生结论区', () => {
  const { asm, flushes } = make()
  asm.addDelta('你好')
  asm.addDelta('，世界')
  asm.flushNow()

  assert.equal(flushes.length, 1)
  assert.equal(flushes[0].preToolText, '你好，世界')
  assert.equal(flushes[0].conclusion, '')
  assert.equal(flushes[0].text, '你好，世界')
  assert.equal(flushes[0].tools.length, 0)
  asm.dispose()
})

test('工具开始后 delta 归入结论区；text 仍为完整逻辑文本', () => {
  const { asm } = make()
  asm.addDelta('我先看一下目录')
  asm.toolStart({ id: 'call-1', name: 'bash', args: { command: 'ls' } })
  asm.addDelta('目录里是 pi-web')
  asm.toolEnd('call-1', false, 'package.json')
  asm.addDelta('这是项目根目录。')
  asm.flushNow()

  const snap = asm.snapshot()
  assert.equal(snap.preToolText, '我先看一下目录')
  assert.equal(snap.conclusion, '目录里是 pi-web这是项目根目录。')
  assert.equal(snap.text, '我先看一下目录目录里是 pi-web这是项目根目录。')
  assert.equal(snap.tools.length, 1)
  assert.equal(snap.tools[0].status, 'completed')
  asm.dispose()
})

test('16ms 合帧：多次 addDelta 只触发一次计划 flush', async () => {
  const flushes = []
  const asm = new StreamAssembler(snap => flushes.push(snap), { flushDelayMs: 16 })
  asm.addDelta('a')
  asm.addDelta('b')
  asm.addDelta('c')
  // flushDelayMs=16 → 定时器生效，短暂等待后应恰好合并为 1 次 flush
  await new Promise(r => setTimeout(r, 40))
  assert.equal(flushes.length, 1)
  assert.equal(flushes[0].text, 'abc')
  asm.dispose()
})

test('同一 toolCallId 重复 toolStart 幂等且不清空输出', () => {
  const { asm } = make()
  asm.toolStart({ id: 'call-1', name: 'bash', args: { command: 'ls' } })
  asm.toolOutput('call-1', 'file-a\n')
  asm.toolStart({ id: 'call-1', name: 'bash', args: { command: 'ls' } })
  asm.toolEnd('call-1', false, 'file-a\nfile-b')
  asm.flushNow()

  const tools = asm.snapshot().tools
  assert.equal(tools.length, 1)
  assert.equal(tools[0].output, 'file-a\nfile-b')
  assert.equal(tools[0].status, 'completed')
  asm.dispose()
})

test('思考流：addThink 累积，endThink 置完成并强制 flush', () => {
  const { asm, flushes } = make()
  asm.addThink('思考中…')
  assert.equal(flushes.length, 0) // 缓冲中，未 flush
  asm.endThink()
  assert.equal(flushes.length, 1)
  assert.equal(flushes[0].think, '思考中…')
  assert.equal(flushes[0].thinkDone, true)
  asm.dispose()
})

test('断线恢复：从快照恢复 + 只喀游标后的事件，结果与实时一致', () => {
  // 防重复的真正防线在 advanceRunCursor（seq 游标）：已消费事件不会再次到达 applyRunEvent。
  // assembler 契约：同一事件只喀一次；tools 层另持 toolCallId 幂等双保险。
  const events = [
    { type: 'delta', data: { text: '第一段' } },
    { type: 'tool', data: { id: 'call-1', name: 'bash', args: { command: 'pwd' } } },
    { type: 'tool_output', data: { id: 'call-1', text: '/pi-web' } },
    { type: 'tool_end', data: { id: 'call-1', isError: false, output: '/pi-web' } },
    { type: 'delta', data: { text: '结论：当前在 pi-web' } },
  ]
  const feed = (asm, list) => {
    for (const ev of list) {
      const d = ev.data || {}
      if (ev.type === 'delta') asm.addDelta(d.text || '')
      else if (ev.type === 'tool') asm.toolStart(d)
      else if (ev.type === 'tool_output') asm.toolOutput(d.id, d.text)
      else if (ev.type === 'tool_end') asm.toolEnd(d.id, d.isError, d.output)
    }
  }
  // 实时链路
  const live = make()
  feed(live.asm, events)
  live.asm.flushNow()
  // 断线恢复：游标停在 tool_output（seq 3），只重放之后的事件，起点从快照恢复
  const recovered = make()
  recovered.asm.addDelta('第一段')
  recovered.asm.toolStart({ id: 'call-1', name: 'bash', args: { command: 'pwd' } })
  recovered.asm.toolOutput('call-1', '/pi-web')
  feed(recovered.asm, events.slice(3))
  recovered.asm.flushNow()
  const a = live.asm.snapshot()
  const b = recovered.asm.snapshot()
  assert.equal(b.text, a.text)
  assert.equal(b.conclusion, '结论：当前在 pi-web')
  assert.equal(b.tools.length, 1)
  assert.equal(b.tools[0].status, 'completed')
  live.asm.dispose(); recovered.asm.dispose()
})

test('flushNow 后缓冲清空，无新事件时不再触发 flush', () => {
  const { asm, flushes } = make()
  asm.addDelta('x')
  asm.flushNow()
  asm.flushNow()
  assert.equal(flushes.length, 1)
  asm.dispose()
})
