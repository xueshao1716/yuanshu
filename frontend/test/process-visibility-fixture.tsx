import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import Message from '../src/components/Message'
import WorkExplanation from '../src/components/WorkExplanation'
import type { RunSummary } from '../src/api'
import '../src/styles.css'
import 'virtual:uno.css'

const run: RunSummary = {
  id: 'fixture', sessionId: 'fixture', status: 'running', phase: 'executing' as RunSummary['phase'], messagePreview: '', toolCount: 2, memoryCount: 0, memoryPreview: null, error: null,
  explanation: {
    version: 1, runId: 'fixture', sessionId: 'fixture', goal: '整理页面并验证交付', updatedAt: '2026-09-26T10:00:00Z',
    status: { code: 'running', label: '正在执行', detail: '已读取文件，正在检查' }, executor: { engine: '元枢', model: '测试模型' }, basis: ['用户指定的测试文件'],
    tools: { count: 2, items: [{ id: 'a', name: 'read', status: 'completed', at: '' }, { id: 'b', name: 'bash', status: 'running', at: '' }] },
    subagents: { count: 0, items: [] }, artifacts: { count: 0, items: [] }, memory: { writes: 0, summary: '' },
    verification: { count: 0, items: [], state: 'not_observed' }, notes: [], problem: '测试告警仍需显示', nextStep: '继续验证交付', coverage: '隔离测试数据，不是真实任务记录',
  },
}
function Fixture() {
  const [count, setCount] = useState(0)
  return <main className="mx-auto max-w-3xl p-4">
    <h1 className="text-lg text-pi-text">执行详情验收</h1>
    <WorkExplanation run={run} />
    {[0, 1].map(index => <Message key={index} msg={{
      id: String(index), role: 'assistant', engine: 'yuanshu', streaming: index === 0,
      text: `交付结果 ${index + 1} · 已更新 ${count} 次`, error: index ? '测试失败仍然可见' : undefined,
      tools: [{ id: 'bash', name: 'bash', argsText: '{"command":"node verify-page.mjs"}', output: `检查输出 ${count}`, status: 'running' },
        { id: 'read', name: 'read', argsText: '{"path":"测试/页面.html"}', status: 'error', output: '测试工具错误' }],
    }} onRetry={() => setCount(value => value + 1)} />)}
    <button className="min-h-11 text-pi-accent" onClick={() => setCount(value => value + 1)}>模拟下一条执行事件</button>
    <WorkExplanation run={{ ...run, id: 'fixture-two' }} />
  </main>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
