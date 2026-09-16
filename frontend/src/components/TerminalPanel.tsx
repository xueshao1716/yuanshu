import { useEffect, useRef, useState } from 'react'
import { Play, AlertTriangle, Square } from 'lucide-react'
import useSWR from 'swr'
import { CodeApi } from '../api'
import type { CodeBinding } from '../api'

// ── 终端面板：Code Mode REPL（Phase 3）──
// 写一段 TypeScript 程序调用宿主工具绑定（bash/read/write/edit/web_search），
// 在服务端 worker 线程隔离执行，返回 { value, logs, error }

interface LogLine { kind: 'log' | 'value' | 'error'; text: string }

const SAMPLE = `// 调用绑定工具，例如列出工作空间根目录（Windows cmd）：
const r = await $tools.bash({ command: "dir" })
console.log(r.text)
return r`

export default function TerminalPanel() {
  // 工具绑定清单（引擎初始化后才可用）
  const { data: tools, error: toolsErr, mutate: mutateTools } = useSWR('code-tools', () => CodeApi.tools(), {
    revalidateOnFocus: true,
    onErrorRetry: (retry) => setTimeout(retry, 15000), // 引擎冷启动时静默重试
  })
  const [program, setProgram] = useState(SAMPLE)
  const [running, setRunning] = useState(false)
  const [lines, setLines] = useState<LogLine[]>([])
  const [elapsed, setElapsed] = useState(0)
  const consoleRef = useRef<HTMLDivElement>(null)
  const bindings: CodeBinding[] = tools?.bindings || []

  useEffect(() => { if (consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight }, [lines])
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setElapsed(e => e + 1), 1000)
    return () => clearInterval(t)
  }, [running])

  const run = async () => {
    if (running || !program.trim()) return
    setRunning(true); setElapsed(0)
    setLines(prev => [...prev, { kind: 'log', text: `▶ 运行（${new Date().toLocaleTimeString('zh-CN', { hour12: false })}）` }])
    try {
      const r = await CodeApi.run(program)
      const out: LogLine[] = []
      for (const l of r.logs || []) out.push({ kind: 'log', text: String(l) })
      if (r.error) out.push({ kind: 'error', text: `✗ [${r.error.kind}] ${r.error.message}` })
      else if (r.value !== undefined && r.value !== null) out.push({ kind: 'value', text: '⇒ ' + (typeof r.value === 'string' ? r.value : JSON.stringify(r.value, null, 1)) })
      else out.push({ kind: 'value', text: '⇒ (完成，无返回值)' })
      setLines(prev => [...prev, ...out])
    } catch (e: any) {
      setLines(prev => [...prev, { kind: 'error', text: '✗ ' + (e?.message || e) }])
    } finally { setRunning(false) }
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* 可用绑定 */}
      <div className="px-3 py-2 border-b border-pi-border-soft flex-shrink-0">
        <div className="text-[10px] text-pi-dim2 mb-1.5">可用绑定（程序内直接 await 调用）</div>
        <div className="flex flex-wrap gap-1.5">
          {toolsErr && (
            <button className="text-[11px] px-2 py-1 rounded-pi-pill bg-amber-500/10 border border-amber-500/25 text-amber-400"
              onClick={() => mutateTools()} title={String(toolsErr).slice(0, 120)}>
              <AlertTriangle className="w-3 h-3 inline align-middle mr-1" />引擎未就绪，点此重试
            </button>
          )}
          {bindings.map(b => (
            <span key={b.name} className="text-[11px] px-2 py-1 rounded-pi-pill bg-pi-accent/10 border border-pi-accent/20 text-pi-accent font-mono cursor-help" title={b.description}>
              await {b.name}()
            </span>
          ))}
        </div>
      </div>

      {/* 编辑区 */}
      <textarea value={program} onChange={e => setProgram(e.target.value)} spellCheck={false}
        onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run() } }}
        className="flex-shrink-0 h-40 w-full bg-pi-bg2/70 border-b border-pi-border-soft px-3 py-2.5 font-mono text-[12px] text-pi-text resize-none outline-none focus:bg-pi-bg2 transition-colors"
        placeholder="// 写一段程序，Ctrl+Enter 运行" />

      {/* 运行条 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-pi-border-soft flex-shrink-0">
        <button onClick={run} disabled={running}
          className={`h-7 px-4 rounded-pi-md text-xs font-medium inline-flex items-center gap-1.5 transition-colors ${running ? 'bg-red-500/90 text-white animate-pulse' : 'bg-pi-accent text-pi-on-accent hover:bg-pi-accent2'}`}>
          {running ? (<><Square className="w-3 h-3 fill-current" /> 运行中 {elapsed}s</>) : (<><Play className="w-3.5 h-3.5 fill-current" /> 运行</>)}
        </button>
        <button className="btn-ghost text-xs whitespace-nowrap px-2.5" onClick={() => setProgram(SAMPLE)} disabled={running}>示例</button>
        <button className="btn-ghost text-xs whitespace-nowrap px-2.5 ml-auto" onClick={() => setLines([])} disabled={!lines.length}>清空输出</button>
      </div>

      {/* 控制台输出 */}
      <div ref={consoleRef} className="flex-1 overflow-y-auto px-3 py-2.5 bg-pi-bg2/50 font-mono text-[12px] leading-relaxed min-h-0">
        {!lines.length && <div className="text-pi-dim2">输出会显示在这里。绑定调用在服务端 worker 线程隔离执行。</div>}
        {lines.map((l, i) => (
          <pre key={i} className={`whitespace-pre-wrap break-all ${
            l.kind === 'error' ? 'text-red-400' : l.kind === 'value' ? 'text-emerald-300' : 'text-pi-dim'}`}>{l.text}</pre>
        ))}
      </div>
    </div>
  )
}
