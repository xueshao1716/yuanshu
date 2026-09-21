import { randomUUID } from 'node:crypto'
import { createAIBodyStore } from './aibody-runtime-store.mjs'
import { EVIDENCE, ROLES, text, chooseMode, directiveFor, eventData, providerState } from './aibody-runtime-policy.mjs'

const clone = value => JSON.parse(JSON.stringify(value))
const bounds = (value, fallback, ceiling) => Number.isFinite(Number(value)) ? Math.max(1, Math.min(ceiling, Math.floor(Number(value)))) : fallback
const counts = () => ({ tools: 0, subagents: 0, memoryWrites: 0, artifacts: 0, verifications: 0 })
const publicRun = run => { if (!run) return null; const { _seen, ...value } = run; return clone(value) }

// 土壤五项的显示名。此前台前拿到的 module.label 就是内部 id（identity/genes/…），
// 而且只带一个 available 布尔——真实读数已经算出来了，却在渲染层被丢掉。
const SOIL_LABELS = { identity: '身份', genes: '基因', emotion: '情绪', memory: '记忆', governance: '治理' }
const SOIL_STATUS_LABELS = { observed: '已观测', not_observed: '未观测', unavailable: '读取失败' }

/** Host independent coordination: it observes work, never executes tools or approves evolution. */
export function createAIBodyRuntime({ rootDir, readState, now = () => new Date().toISOString(), maxRuns = 100, maxEvents = 40 } = {}) {
  const clock = () => new Date(now()).toISOString()
  maxRuns = bounds(maxRuns, 100, 100); maxEvents = bounds(maxEvents, 40, 40)
  const store = createAIBodyStore({ rootDir, now: clock, maxRuns, maxEvents })
  function beginTurn(input = {}) {
    const runId = text(input.runId || randomUUID(), 96), sessionId = text(input.sessionId, 96)
    if (!sessionId) throw new Error('aibody_sessionId_required')
    const existing = store.get(runId)
    if (existing) {
      if (existing.sessionId !== sessionId) throw new Error('aibody_runId_conflict')
      if (input.resume === true && ['interrupted', 'failed', 'cancelled'].includes(existing.status)) {
        Object.assign(existing, { status: 'running', phase: 'executing', finishedAt: null, error: null, updatedAt: clock() })
        store.save(existing)
      }
      return { ...publicRun(existing), directive: directiveFor(existing, null, providerState(readState, { sessionId, runId })) }
    }
    const previous = store.list().filter(run => run.sessionId === sessionId).at(-1)
    const message = text(input.message, 2048)
    const choice = chooseMode(message, input.signals, previous)
    const startedAt = clock()
    const run = { runId, sessionId, engine: text(input.engine, 80), source: text(input.source || 'chat', 40),
      mode: choice.mode, status: 'running', phase: 'planning', topic: choice.inherited ? previous.topic : text(message, 180),
      startedAt, updatedAt: startedAt, finishedAt: null, summary: '', error: null,
      continuity: { inheritedFrom: choice.inherited ? previous.runId : null, recentRunId: previous?.runId || null },
      evidence: counts(), events: [], _seen: [],
    }
    store.save(run)
    return { ...publicRun(run), directive: directiveFor(run, previous, providerState(readState, { sessionId, runId }), input.signals) }
  }
  function observe(runId, type, data = {}) {
    const run = store.get(text(runId, 96))
    if (!run || run.status !== 'running') return null
    const clean = eventData(type, data)
    if (!clean) return null
    const key = `${type}:${clean.id || clean.path || `${run.events.at(-1)?.seq || 0}`}`
    const seen = run._seen || (run._seen = [])
    if (EVIDENCE[type] && !seen.includes(key)) {
      run.evidence[EVIDENCE[type]]++
      seen.push(key)
      if (seen.length > 256) seen.shift()
    }
    run.phase = type === 'plan' ? 'planning' : type === 'verification' ? 'checking' : 'executing'
    run.updatedAt = clock()
    run.events.push({ seq: (run.events.at(-1)?.seq || 0) + 1, type, ts: run.updatedAt, data: clean })
    run.events = run.events.slice(-maxEvents)
    store.save(run)
    return publicRun(run)
  }
  function finishTurn(runId, { status = 'completed', summary = '', error = null } = {}) {
    const run = store.get(text(runId, 96))
    if (!run) return null
    if (run.status !== 'running') return publicRun(run)
    if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(status)) throw new Error('aibody_invalid_status')
    Object.assign(run, { status, phase: status === 'completed' ? 'reporting' : status, summary: text(summary, 600), error: error ? text(error, 300) : null, finishedAt: clock() })
    run.updatedAt = run.finishedAt
    store.save(run)
    return publicRun(run)
  }
  function overview({ sessionId, runId, limit = 20 } = {}) {
    const selected = store.list().filter(run => (!sessionId || run.sessionId === text(sessionId, 96)) && (!runId || run.runId === text(runId, 96))).slice().reverse()
    const runs = selected.slice(0, bounds(limit, 20, 100)).map(publicRun)
    const currentRun = publicRun(selected.find(run => run.status === 'running') || selected[0])
    const context = { sessionId: sessionId || currentRun?.sessionId, runId: runId || currentRun?.runId }
    const totals = { scope: 'retained_runs', runs: selected.length, running: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0, ...counts() }
    for (const run of selected) { totals[run.status]++; for (const key of Object.values(EVIDENCE)) totals[key] += run.evidence[key] || 0 }
    const roles = ROLES.map(role => {
      const observedRun = selected.find(run => ['mother', 'sovereign'].includes(role.id) || run.events.some(event => event.type === 'subagent' && event.data.role === role.id))
      return { ...role, presence: observedRun ? 'observed' : 'not_observed', lastRunId: observedRun?.runId || null, lastObservedAt: observedRun?.updatedAt || null }
    })
    const engines = [...new Set(selected.map(run => run.engine).filter(Boolean))].map(id => {
      const engineRuns = selected.filter(run => run.engine === id)
      return { id, name: id, presence: 'observed', runs: engineRuns.length, lastRunId: engineRuns[0].runId, lastObservedAt: engineRuns[0].updatedAt }
    })
    const state = providerState(readState, context)
    const layers = [
      { id: 'host', label: '宿主 / 运行层', summary: '保留记录中出现过的运行引擎，不代表当前在线。', modules: engines.map(engine => ({ label: engine.name, path: engine.id, available: true })) },
      { id: 'organism', label: '母体 / 进化层', summary: '身份、基因、记忆、情绪与治理形成连续性。', modules: Object.entries(state).map(([id, value]) => ({ key: id, label: SOIL_LABELS[id] || id, path: `aibody:${id}`, available: value.status === 'observed', status: value.status, statusLabel: SOIL_STATUS_LABELS[value.status] || value.status, summary: value.summary, details: value.details })) },
      { id: 'expression', label: '表现 / 具身层', summary: '对话、任务与交付把系统状态呈现出来。', modules: [{ label: '主任务协调', path: 'aibody-runtime', available: runs.length > 0 }] },
    ]
    return { version: 1, observedAt: clock(), observationContext: { ...context, scope: sessionId ? 'selected_session' : 'latest_recorded_session' }, continuity: store.continuity(), state, currentRun, runs, roles, engines, totals,
      principle: 'AIBody 贯穿人格、任务、记忆、角色协作与治理；验收页只是观察入口。',
      companionship: {
        continuity: '同一会话承接已记录主题与状态',
        memory: '记忆可查看、可纠正、可由用户控制',
        boundary: '不模拟情感依赖，不替用户做价值判断',
      },
      evolution: {
        mode: '提案制迭代（设计约束，非验收结果）', status: 'policy_only', humanApproval: null, rollback: null,
        scope: ['技能', '经验', '记忆', '工作方式'], protected: ['人格', '身份', '高风险权限'],
      },
      theory: [
        { id: 'continuity', label: '连续性', detail: '同会话可参考已记录主题；重启后恢复记录并将未完成项标为中断，不会自动续跑。', evidence: ['aibody-runtime', 'memory', 'emotion'] },
        { id: 'orchestration', label: '母体统筹', detail: '主角色负责规划与交付，子角色按需协作并受边界约束。', evidence: ['aibody-runtime', 'subagent-traces'] },
        { id: 'governance', label: '可治理', detail: '真实事件可追踪；人格与提案仍需原有人工审批。', evidence: ['gene', 'approval'] },
      ], layers }
  }
  return { beginTurn, observe, finishTurn, overview, getRun: runId => publicRun(store.get(text(runId, 96))) }
}
