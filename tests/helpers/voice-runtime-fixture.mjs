import fs from 'node:fs'
import path from 'node:path'
import { originFixture } from './session-origin-fixture.mjs'
import { canAccessSessionOrigin, withIdleSession } from '../../engine/session-manager.mjs'
import { invalidateSessionCache } from '../../engine/session-files.mjs'
import { createRunStore } from '../../engine/run-store.mjs'
import { createRunEventLog } from '../../engine/run-event-log.mjs'
import { createRunManager } from '../../engine/run-manager.mjs'
import { createTaskEvidence } from '../../engine/task-evidence.mjs'
export const advance = () => new Promise(resolve => setImmediate(resolve))
export function voiceRuntimeFixture(t, createRuntime) {
  const f = originFixture(t), rootDir = path.join(f.root, 'runs')
  const store = createRunStore({ rootDir }), eventLog = createRunEventLog({ rootDir })
  const pending = new Map(), executions = [], runtimes = [], notices = []
  const manager = createRunManager({ store, eventLog, instanceId: 'isolated-test', executeChat: async (req, res, body) => {
    executions.push({ body, req })
    await new Promise(resolve => { pending.set(body.sessionId, resolve); req.on('close', resolve) })
    if (!req.destroyed) {
      const relative = '生成物/' + body.sessionId + '.json'
      fs.mkdirSync(path.join(f.cwd, '生成物'), { recursive: true })
      fs.writeFileSync(path.join(f.cwd, relative), JSON.stringify({ instruction: body.message }))
      res.write('event: delta\ndata: ' + JSON.stringify({ text: '隔离执行器已生成结果。' }) + '\n\n')
      res.write('event: artifact_created\ndata: ' + JSON.stringify({ path: relative }) + '\n\n')
    }
    res.end()
  } })
  const taskEvidence = createTaskEvidence({ wsRoot: f.cwd, rootDir })
  const options = { rootDir, manager, sessionsDir: f.sessionsDir, cwd: f.cwd, canAccess: canAccessSessionOrigin,
    withSession: withIdleSession, taskEvidence, getModel: () => 'server-owned-model', invalidate: invalidateSessionCache,
    notify: id => notices.push(id), intervalMs: 20 }
  const make = extra => { const runtime = createRuntime({ ...options, ...extra }); runtimes.push(runtime); return runtime }
  t.after(async () => { for (const runtime of runtimes) runtime.close(); for (const resolve of pending.values()) resolve(); await advance(); manager.dispose(); eventLog.close() })
  return { ...f, rootDir, store, manager, eventLog, taskEvidence, options, make, executions, notices,
    finish: async task => { pending.get(task.sessionId)?.(); await advance() },
    rows: () => fs.readFileSync(f.file, 'utf8').trim().split('\n').map(JSON.parse),
  }
}
