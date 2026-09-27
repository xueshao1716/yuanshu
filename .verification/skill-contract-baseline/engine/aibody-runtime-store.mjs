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
      if (runs.length > maxRuns) runs = runs.slice(-maxRuns)
      persist()
    },
    continuity: () => ({ restored, recoveredRuns, ...(error ? { error } : {}) }),
  }
}
