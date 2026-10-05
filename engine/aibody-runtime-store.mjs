import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteJson } from './atomic-io.mjs'

export function createAIBodyStore({ rootDir, now, maxRuns, maxEvents }) {
  if (!rootDir) throw new Error('aibody_rootDir_required')
  const file = path.join(rootDir, 'aibody-runtime.json')
  let runs = [], restored = false, recoveredRuns = 0, error = null
  try {
    if (fs.statSync(file).size > 8 * 1024 * 1024) throw new Error('too_large')
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (data.version !== 1 || !Array.isArray(data.runs)) throw new Error('invalid_state')
    runs = data.runs.filter(run => run && typeof run.runId === 'string' && typeof run.sessionId === 'string').slice(-maxRuns)
    restored = true
  } catch (e) { if (e.code !== 'ENOENT') error = '运行记录无法恢复' }
  const persist = () => {
    try { atomicWriteJson(file, { version: 1, runs }); error = null }
    catch { error = '运行记录暂未写入磁盘' }
  }
  // 超出保留上限的运行不再直接丢弃：按月追加到 archive/YYYY-MM.jsonl（已脱敏的同一份记录），
  // 首页仍只读最近 maxRuns 条；归档失败不影响主流程。（2026-10-05）
  const archive = (evicted) => {
    if (!evicted.length) return
    try {
      const dir = path.join(rootDir, 'archive')
      fs.mkdirSync(dir, { recursive: true })
      const byMonth = new Map()
      for (const run of evicted) {
        const { _seen, ...clean } = run
        const month = String(run.startedAt || run.updatedAt || now()).slice(0, 7).replace(/[^0-9-]/g, '') || 'unknown'
        byMonth.set(month, (byMonth.get(month) || '') + JSON.stringify(clean) + '\n')
      }
      for (const [month, lines] of byMonth) fs.appendFileSync(path.join(dir, `${month}.jsonl`), lines, 'utf8')
    } catch { /* archive is best effort */ }
  }
  for (const run of runs) {
    run.events = Array.isArray(run.events) ? run.events.slice(-maxEvents) : []
    if (run.status !== 'running') continue
    recoveredRuns++
    Object.assign(run, { status: 'interrupted', phase: 'interrupted', error: '服务重启，执行结果尚未核实', updatedAt: now(), finishedAt: now() })
  }
  if (recoveredRuns) persist()
  return {
    list: () => runs,
    get: id => runs.find(run => run.runId === id),
    save(run) {
      const index = runs.findIndex(item => item.runId === run.runId)
      if (index < 0) runs.push(run); else runs[index] = run
      if (runs.length > maxRuns) {
        archive(runs.slice(0, runs.length - maxRuns))
        runs = runs.slice(-maxRuns)
      }
      persist()
    },
    continuity: () => ({ restored, recoveredRuns, ...(error ? { error } : {}) }),
  }
}
