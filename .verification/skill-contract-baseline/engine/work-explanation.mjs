import { classifyFailure } from './run-observability.mjs'
import { clean, collectWorkEvents, modelName } from './work-explanation-events.mjs'

const ACTIVE = new Set(['queued', 'running', 'stopping'])
const STATUS = { queued: '排队中', running: '正在执行', stopping: '正在停止', completed: '本轮已结束', failed: '执行失败', stopped: '已停止', interrupted: '运行已中断' }
const ENGINES = { yuanshu: '元枢自建引擎', pi: '兼容引擎', dsh: '外部执行引擎' }
const MODES = { builder: '构建与交付', analysis: '分析与核查', answer: '解释与回答', conversation: '交流' }
const NEXT = { timeout: '请求超时，可稍后重试或切换模型。', provider: '请检查模型通道的额度、连接与登录状态。', transport: '请检查网络连接，再重试当前任务。', approval: '请查看已有的权限提示，确认受阻操作的范围。', tool: '请查看失败的工具记录，修正输入或环境后重试。', model: '请查看模型返回的错误，必要时切换模型重试。' }

/** A projection of observable facts, never an inference of hidden model reasoning. */
export function buildWorkExplanation(run = {}, events = [], context = {}) {
  const body = context.bodyRun?.runId === run.id && context.bodyRun?.sessionId === run.sessionId ? context.bodyRun : null
  const raw = Array.isArray(events) ? events : []
  const category = type => /subagent/.test(type) ? 'subagent' : /^tool/.test(type) ? 'tool' : ['media', 'file', 'image', 'artifact_created'].includes(type) ? 'artifact_created' : type
  const rawKeys = new Set(raw.map(e => `${category(e.type)}:${e.data?.id || e.data?.toolCallId || e.data?.runId || e.data?.path || ''}`))
  const supplement = (body?.events || []).filter(e => !rawKeys.has(`${category(e.type)}:${e.data?.id || e.data?.path || ''}`)
    && (!['artifact_created', 'memory_written', 'plan', 'verification'].includes(e.type) || !raw.some(r => category(r.type) === e.type)))
  const list = [...raw, ...supplement].sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0) || (a.seq || 0) - (b.seq || 0))
  for (const child of context.subagents || []) {
    if (child.parentRunId !== run.id || child.sessionId !== run.sessionId) continue
    list.push({ type: 'subagent', ts: child.endedAt || child.startedAt, data: child })
  }
  const facts = collectWorkEvents(list, !ACTIVE.has(run.status))
  const requested = modelName(run.input?.model)
  const basis = []
  if (facts.reason) basis.push(facts.reason)
  if (requested && requested !== 'auto/auto') basis.push(`本轮请求的模型：${requested}；实际使用以执行记录为准。`)
  else basis.push('请求未指定固定模型；具体选择依据以运行记录为准。')
  if (body?.mode && MODES[body.mode]) basis.push(`AIBody 协调模式：${MODES[body.mode]}。`)
  if (body?.continuity?.inheritedFrom) basis.push('本轮承接同一会话上次任务的主题和协调模式。')
  const errorEvent = [...raw].reverse().find(e => ['failed', 'error'].includes(e.type))
  const paused = run.status === 'interrupted' && !!run.pauseReason
  const failure = ['failed', 'interrupted', 'stopped'].includes(run.status) && !paused
  const error = clean(run.error || (failure ? errorEvent?.data?.message || errorEvent?.data?.error : ''))
  const problem = error === 'server_restarted' ? '服务重启使本轮中断，已保留运行记录。' : error || (run.status === 'failed' ? '运行失败，但没有记录具体原因。' : '')
  const nextStep = ACTIVE.has(run.status) ? run.status === 'stopping' ? '等待当前操作停止，已产生的结果会保留在会话中。' : '等待本轮返回；可展开查看记录，或使用停止按钮中止任务。'
    : run.resumeAvailable ? '可点击“继续任务”，从已保存的进度恢复。'
      : failure ? NEXT[classifyFailure(error, run.status)] || '请查看已有结果；需要继续时可在会话中补充要求或重试。'
        : facts.verification.state === 'failed' ? '有检查未通过，请先处理检查发现的问题。'
          : facts.verification.state === 'passed' ? '已记录的检查通过，请结合目标核对结果；人工验收尚未记录。'
            : facts.artifacts.count ? '请在会话或资产库预览产物，确认内容和可用性；本轮尚无真实检查通过记录。'
              : body?.mode === 'builder' ? '请查看会话回复，并确认要求的文件是否实际生成。' : '请查看会话回复，对照你的要求核对结论。'
  return { version: 1, runId: clean(run.id, 120), sessionId: clean(run.sessionId, 120),
    goal: clean(run.input?.messagePreview || body?.topic, 500) || '未记录任务目标',
    status: { code: run.status || 'unknown', label: paused ? '已暂停，可继续' : STATUS[run.status] || '状态未记录', detail: paused ? clean(run.pauseMessage) || '已保留进度，可继续任务。' : ACTIVE.has(run.status) ? facts.current || '等待执行记录' : '执行状态与检查结果分别记录' },
    updatedAt: clean(run.updatedAt || run.createdAt || body?.updatedAt, 40),
    executor: { engine: ENGINES[facts.engine] || facts.engine || '实际引擎未记录', model: facts.actualModel || '实际模型未记录', mediaModels: facts.mediaModels },
    basis, tools: facts.tools, subagents: facts.subagents, artifacts: facts.artifacts, memory: facts.memory, verification: facts.verification,
    notes: facts.notes, problem, nextStep, coverage: context.unavailable ? '协作记录暂不可用，以下仅为可读取的运行事件。' : '仅说明已记录的事实；历史缺失信息不会补造。' }
}
