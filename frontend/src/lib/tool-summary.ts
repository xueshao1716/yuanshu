// ===== tool-summary.ts —— 工具运行时摘要（2026-11-08）=====
//
// 问题：工具在执行中只显示「运行中」，用户不知道它到底在跑哪条命令、读哪个文件。
// 这里是一个纯函数：把 name + args 压成一行可展示摘要（≤80 字、单行、脱敏）。
// 放在 lib 里是为了能直接被 Node 单测 import，也方便别的面板复用。
//
// 映射：命令首行 / 文件路径（有 cwd 就相对化）/ URL / 查询词 / problem / 任务标题 / 模式；
// 其它工具取参数里第一个字符串值；都没有就返回空串（UI 保持「运行中」）。

const MAX_LEN = 80

const COMMAND_TOOLS = new Set(['bash', 'pwsh', 'shell', 'powershell', 'cmd', 'run_command', 'exec'])
const FILE_TOOLS = new Set(['read', 'write', 'edit', 'apply_patch', 'multiedit', 'notebook_edit'])
const URL_TOOLS = new Set(['web_fetch', 'read_url', 'fetch_url', 'fetch'])
const SEARCH_TOOLS = new Set(['web_search', 'search'])
const FIX_TOOLS = new Set(['fix_problem'])
const DELEGATE_TOOLS = new Set(['delegate_task', 'delegate_fork', 'delegate_team', 'subagent'])
const FIND_TOOLS = new Set(['search_files', 'grep', 'glob', 'find_files'])

// 字段名命中这些就算凭据：整段跳过，不把密钥打进界面。
const SECRET_KEY = /(?:^|[_-])(token|key|secret|password|passwd|credential|authorization)$/i
const BEARER_TEXT = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi
const SECRET_ASSIGN = /((?:token|key|secret|password|passwd|credential|authorization)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;"']+/gi
const SECRET_FLAG = /(--?(?:token|key|secret|password|passwd|authorization)\s+)[^\s,;"']+/gi

/** 单行化 + 截断。先压空白再截，保证摘要一定是一行。 */
function clip(value: string, max = MAX_LEN): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 命令只留首行（多行脚本摘要里没必要全带）。 */
function firstLine(value: string): string {
  const lines = String(value ?? '').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return ''
}

/** 脱敏：命令行/URL 里出现的凭据一律打码。 */
function redact(value: string): string {
  return String(value ?? '')
    .replace(BEARER_TEXT, '$1***')
    .replace(SECRET_ASSIGN, '$1***')
    .replace(SECRET_FLAG, '$1***')
}

/** 绝对路径能对上前缀就相对化（Windows 反斜杠统一成正斜杠展示）。 */
function relativize(file: string, cwd = ''): string {
  const path = String(file ?? '').replace(/\\/g, '/')
  const base = String(cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (!base) return path
  if (path.toLowerCase() === base.toLowerCase()) return '.'
  if (path.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return path.slice(base.length + 1)
  return path
}

type ArgsRecord = Record<string, unknown>

/** args 可能是对象、JSON 字符串（历史消息 argsText）或裸字符串（流式 argsText）。 */
function asRecord(args: unknown): { values: ArgsRecord | null; raw: string } {
  if (args && typeof args === 'object' && !Array.isArray(args)) return { values: args as ArgsRecord, raw: '' }
  const text = String(args ?? '').trim()
  if (!text) return { values: null, raw: '' }
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { values: parsed as ArgsRecord, raw: '' }
      if (typeof parsed === 'string') return { values: null, raw: parsed }
    } catch { /* 流式参数可能还没闭合——宁可不显示，也不显示半截 JSON */ }
    return { values: null, raw: '' }
  }
  return { values: null, raw: text }
}

function pickString(values: ArgsRecord | null, keys: string[]): string {
  if (!values) return ''
  for (const key of keys) {
    const value = values[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

/**
 * 工具执行中的一行摘要。没有可展示的参数时返回空串（UI 保持「运行中」）。
 * @param name 工具名（bash/read/web_search/...）
 * @param args 参数对象、JSON 字符串或已经拍平的 argsText
 * @param options cwd 用于把文件路径相对化（拿不到就不相对化）
 */
export function toolRunningSummary(name: string, args?: unknown, options: { cwd?: string } = {}): string {
  const tool = String(name ?? '').trim().toLowerCase()
  const { values, raw } = asRecord(args)
  const text = (keys: string[]): string => pickString(values, keys) || raw

  let summary = ''
  if (COMMAND_TOOLS.has(tool)) {
    summary = firstLine(text(['command', 'cmd', 'script', 'line']))
  } else if (FILE_TOOLS.has(tool)) {
    summary = relativize(text(['path', 'file', 'filename', 'target']), options.cwd || '')
  } else if (URL_TOOLS.has(tool)) {
    summary = text(['url', 'href', 'link'])
  } else if (SEARCH_TOOLS.has(tool)) {
    summary = text(['query', 'q', 'keyword', 'keywords'])
  } else if (FIX_TOOLS.has(tool)) {
    summary = text(['problem', 'issue', 'description'])
  } else if (DELEGATE_TOOLS.has(tool)) {
    summary = text(['title', 'name', 'task', 'prompt', 'description'])
  } else if (FIND_TOOLS.has(tool)) {
    summary = text(['pattern', 'query', 'regex', 'keyword'])
  } else if (values) {
    // 其它工具：参数里第一个字符串值；凭据字段直接跳过。
    for (const [key, value] of Object.entries(values)) {
      if (SECRET_KEY.test(key)) continue
      if (typeof value === 'string' && value.trim()) { summary = value; break }
    }
  } else {
    summary = raw
  }

  return clip(redact(summary))
}
