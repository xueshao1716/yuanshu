import { text } from './aibody-runtime-policy.mjs'
import { createHash } from 'node:crypto'

export const clean = (value, limit = 300) => text(typeof value === 'string'
  ? value.replace(/https?:\/\/[^\s<>"']+/gi, url => url.split(/[?#]/)[0]).replace(/bearer\s+\S+/gi, 'Bearer [已脱敏]')
  : value, limit)
export const modelName = value => typeof value === 'string' ? clean(value, 160)
  : value && typeof value === 'object' ? [clean(value.provider, 60), clean(value.id || value.model, 100)].filter(Boolean).join('/') : ''
export const group = items => ({ count: items.length, items: items.slice(-12) })
const status = (value, fallback) => ['completed', 'failed', 'cancelled', 'interrupted', 'running', 'error', 'started', 'not_observed'].includes(value) ? value : fallback

function artifactLocation(data) {
  if (data.path) return clean(data.path, 400)
  try {
    const url = new URL(data.url, 'http://local')
    if (/^\/api\/(?:ws|files)\//.test(url.pathname) && url.searchParams.has('path')) return clean(url.searchParams.get('path'), 400)
  } catch { /* Older records may contain an ordinary filesystem path. */ }
  return clean(data.url, 400)
}

export function collectWorkEvents(events, terminal) {
  const tools = new Map(), subagents = new Map(), artifacts = new Map()
  const checks = [], notes = []
  let writes = 0, memorySummary = '', actualModel = '', childModel = '', engine = '', reason = '', current = ''
  const mediaModels = []
  const mediaModelKeys = new Set()
  events.forEach((event, index) => {
    const type = String(event?.type || '').replace(/^pi\//, '')
    const d = event?.data && typeof event.data === 'object' ? event.data : {}
    const rawId = d.id || d.toolCallId || d.childId || d.runId
    const id = rawId ? createHash('sha256').update(String(rawId)).digest('hex').slice(0, 24) : ''
    const at = clean(event?.ts || d.endedAt || d.startedAt, 40)
    if (['tool', 'tool_start', 'tool_started', 'tool_end', 'tool_finished'].includes(type)) {
      const key = id || `tool-record-${index}`
      const previous = tools.get(key) || {}
      const ended = ['tool_end', 'tool_finished'].includes(type) || ['completed', 'error', 'failed'].includes(d.status)
      const name = clean(d.name || d.toolName || previous.name, 100) || '未命名工具'
      tools.set(key, { id: key, name, at, status: ended ? (d.isError || ['error', 'failed'].includes(d.status) ? 'error' : d.uncertain ? 'not_observed' : 'completed') : terminal ? 'not_observed' : 'running' })
      current = ended ? `已收到「${name}」的执行结果` : `正在调用「${name}」`
    }
    if (['subagent', 'subagent_started', 'subagent_start', 'subagent_finished', 'subagent_end'].includes(type)) {
      const key = id || `child-record-${index}`
      const previous = subagents.get(key) || {}
      const state = status(d.status, type.includes('finish') || type.includes('end') ? 'completed' : 'running')
      const role = clean(d.role || d.agent || previous.role, 80) || '子智能体'
      childModel = modelName(d.model) || childModel
      current = ['failed', 'error'].includes(state) ? `角色「${role}」执行失败`
        : ['running', 'started'].includes(state) ? `角色「${role}」正在协作` : `已收到角色「${role}」的执行结果`
      subagents.set(key, { id: key, at, role: clean(d.role || d.agent || previous.role, 80) || '子智能体',
        task: clean(d.task || previous.task), model: modelName(d.model) || previous.model || '',
        status: terminal && ['running', 'started'].includes(state) ? 'not_observed' : state,
        summary: clean(d.result || d.summary || previous.summary, 500), error: clean(d.error || previous.error),
        evidence: Array.isArray(d.evidence) ? d.evidence.filter(x => typeof x === 'string').slice(0, 6).map(x => clean(x)) : previous.evidence || [],
        confidence: typeof d.confidence === 'number' && Number.isFinite(d.confidence) ? Math.max(0, Math.min(1, d.confidence)) : previous.confidence ?? null })
    }
    if (['artifact_created', 'media', 'file', 'image'].includes(type)) {
      // Locators are descriptive only: do not expose signed URL credentials or claim existence.
      const locator = artifactLocation(d)
      const key = locator || id || `artifact-record-${index}`
      artifacts.set(key, { id: key, at, name: clean(d.name || d.title, 160) || locator.split(/[\\/]/).at(-1) || '已记录产物', path: locator,
        kind: clean(d.kind || d.type || d.mime, 60) || '文件' })
      current = '已记录产物，等待核实交付结果'
      const mediaModel = modelName(d.model || d.media?.model)
      if (mediaModel && !mediaModelKeys.has(mediaModel)) { mediaModelKeys.add(mediaModel); mediaModels.push(mediaModel) }
    }
    if (type === 'memory_written') {
      writes += Number.isFinite(d.count) && d.count >= 0 ? Math.floor(d.count) : 1
      memorySummary = clean(d.preview || d.summary || d.text) || memorySummary
      current = '正在保存本轮记忆'
    }
    if (type === 'verification') {
      const runtime = [d.source, d.origin, d.producer].includes('runtime') || d.real === true
      const passed = typeof d.passed === 'boolean' ? d.passed : d.verified === true ? true : null
      checks.push({ at, name: clean(d.name || d.summary) || '未命名检查', state: runtime && passed !== null ? passed ? 'passed' : 'failed' : 'reported' })
      current = '正在核对检查结果'
    }
    if (type === 'engine_selected') { engine = clean(d.engine, 80); reason = clean(d.reason) }
    if (['done', 'model_used', 'model_switched'].includes(type)) actualModel = modelName(d.model || d.usedModel || (d.id ? d : null)) || actualModel
    if (type === 'note' && d.text) {
      const note = clean(d.text)
      if (!notes.includes(note)) notes.push(note)
      if (!engine) {
        const lead = /^本轮主引擎\s*·\s*(元枢|兼容适配器|pi|dsh)(?:[（\s]|$)/.exec(note)?.[1]
        if (lead) { engine = ({ 元枢: 'yuanshu', 兼容适配器: 'pi' })[lead] || lead; reason = note }
      }
    }
    if (['think', 'reasoning'].includes(type)) current = '模型正在处理当前任务'
    if (type === 'delta') current = '正在整理回复'
    if (type === 'checkpoint' || type === 'plan') current = '已保存执行进度'
  })
  const state = checks.some(c => c.state === 'failed') ? 'failed' : checks.some(c => c.state === 'passed') ? 'passed' : checks.length ? 'reported' : 'not_observed'
  return { tools: group([...tools.values()]), subagents: group([...subagents.values()]), artifacts: group([...artifacts.values()]),
    verification: { state, ...group(checks) }, memory: { writes, summary: memorySummary }, notes: notes.slice(-4), actualModel: actualModel || childModel, mediaModels, engine, reason, current }
}
