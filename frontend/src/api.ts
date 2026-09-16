import type { Model, Session, ChatMessage, SessionMessages, Artifact, AssetDelivery, SkillSummary, StoryProject, StoryGenerationRun, StoryFilm, StoryPlanStep, StoryRecipe, StoryEpisode, StoryEpisodeGroup, StoryAdaptResult, StoryMethod, StoryFilmPlan, StoryTimelinePlan, StoryRunDeleteResult, StoryDialogueAuditResult, StoryDialogueDoctorResult, StoryCraftEngine, StoryCraftAudit, StoryLineTimeline } from './types'
import { parseSseBlocks, type RunEvent, type RunStatus } from './lib/run-events'
import { rememberDownload } from './lib/downloads'
import { saveNativeDownload } from './lib/native-download'
import { fileAccess } from './lib/file-access'
import type { WorkExplanationData } from './lib/work-explanation'

// ── 本地鉴权 ──
// 元枢只把访问令牌留在当前设备的浏览器存储中；旧 key 只用于一次性迁移，避免升级后掉线。
const LOCAL_TOKEN_KEY = 'yuanshu_access_token'
const LOCAL_API_BASE_KEY = 'yuanshu_api_base'
const LEGACY_TOKEN_KEY = 'pi_web_token'
const LEGACY_API_BASE_KEY = 'pi_api_base'

function readLocal(key: string, legacyKey?: string) {
  try {
    const current = localStorage.getItem(key) || ''
    if (current || !legacyKey) return current
    const legacy = localStorage.getItem(legacyKey) || ''
    if (legacy) {
      localStorage.setItem(key, legacy)
      localStorage.removeItem(legacyKey)
    }
    return legacy
  } catch { return '' }
}

let _token = readLocal(LOCAL_TOKEN_KEY, LEGACY_TOKEN_KEY)
let _apiBase = readLocal(LOCAL_API_BASE_KEY, LEGACY_API_BASE_KEY)

export function setToken(t: string) { _token = t; try { localStorage.setItem(LOCAL_TOKEN_KEY, t); localStorage.removeItem(LEGACY_TOKEN_KEY) } catch {} }
export function getToken() { return _token }
export function setApiBase(b: string) { _apiBase = b.replace(/\/+$/, ''); try { localStorage.setItem(LOCAL_API_BASE_KEY, _apiBase); localStorage.removeItem(LEGACY_API_BASE_KEY) } catch {} }
export function getApiBase() { return _apiBase.replace(/\/+$/, '') }

export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  const base = getApiBase()
  if (!base) return path
  return `${base}/${path.replace(/^\/+/, '')}`
}

export function webSocketUrl(path: string): string {
  const base = getApiBase()
  if (/^wss?:\/\//i.test(path)) return path
  if (base) {
    const httpBase = base.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:')
    return `${httpBase}/${path.replace(/^\/+/, '')}`
  }
  const protocol = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = typeof location !== 'undefined' ? location.host : ''
  return `${protocol}//${host}/${path.replace(/^\/+/, '')}`
}

// 文件 URL 补 token（<img>/<audio>/<video> 标签带不了 Authorization 头，服务端 checkAuth 接受 ?token=）
export function withFileToken(url: string): string {
  if (!url || !url.includes('/api/ws/file')) return url
  return fileAccess(url, getApiBase(), _token).url
}

/** Download a non-JSON API/file response with the current local token. */
export async function downloadApiFile(path: string, filename?: string, onProgress?: (message: string) => void): Promise<string> {
  onProgress?.('正在获取文件…')
  const access = fileAccess(path, getApiBase(), _token, true)
  let response: Response
  try {
    response = await fetch(access.url, { headers: access.headers, signal: AbortSignal.timeout(180000) })
  } catch (error) {
    // 远程生成物通常不开放 CORS，fetch 会在浏览器侧直接失败。此时仍把
    // 原文件交给浏览器/客户端打开，并记录“已发起”，否则用户既拿不到文件也看不到下载中心记录。
    const external = /^https?:\/\//i.test(access.url) && (typeof location === 'undefined' || new URL(access.url, location.href).origin !== location.origin)
    if (!external || typeof document === 'undefined') throw error
    const resolvedName = filename || 'download'
    const link = document.createElement('a')
    link.href = access.url
    link.download = resolvedName
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.style.display = 'none'
    document.body.appendChild(link)
    link.click()
    link.remove()
    const recordDownload = rememberDownload
    recordDownload({ name: resolvedName, url: path, size: 0, sourcePath: path, createdAt: new Date().toISOString(), status: 'started', error: String((error as any)?.message || '远程文件由浏览器打开保存') })
    onProgress?.('已发起浏览器下载；若未自动保存，请在打开的原文件页面选择保存')
    return '已发起下载；若未自动保存，请在打开的原文件页面选择保存'
  }
  if (!response.ok) {
    if (response.status === 401) { try { window.dispatchEvent(new Event('pi-unauthorized')) } catch {} }
    const data = await response.json().catch(() => null)
    throw new Error(data?.error || (response.status === 404 ? '原文件已不存在，请重新生成或从资产库查找' : `下载失败（HTTP ${response.status}）`))
  }
  const blob = await response.blob()
  const disposition = response.headers.get('content-disposition') || ''
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  const plain = disposition.match(/filename="?([^";]+)"?/i)?.[1]
  const resolvedName = filename || (encoded ? decodeURIComponent(encoded) : plain) || 'download'
  if (!blob.size) throw new Error('文件为空，请重新生成')
  onProgress?.('文件已就绪，正在打开保存位置…')
  const nativeSave = await saveNativeDownload(blob, resolvedName)
  if (nativeSave) {
    rememberDownload({ name: resolvedName, url: path, size: blob.size, sourcePath: path, createdAt: new Date().toISOString(), status: 'saved', ...nativeSave })
    return `已保存到${nativeSave.location}`
  }
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = resolvedName
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60000)
  rememberDownload({ name: resolvedName, url: path, size: blob.size, sourcePath: path, createdAt: new Date().toISOString(), status: 'saved' })
  return '已交给浏览器下载；若未弹出，请点击“打开原文件保存”'
}

const TIMEOUT = 30000

export async function api<T = any>(path: string, opts: any = {}): Promise<T> {
  const headers: any = { ...(opts.headers || {}), Authorization: `Bearer ${_token}` }
  if (opts.body && typeof opts.body === 'object') {
    headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(opts.body)
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('请求超时')), opts.timeoutMs || TIMEOUT)
  try {
    const r = await fetch(apiUrl(path), { ...opts, headers, signal: opts.signal || ctrl.signal })
    const ct = r.headers.get('content-type') || ''
    const data = ct.includes('json') ? await r.json() : null
    if (!r.ok) {
      // 401 = 令牌失效/无效：广播全局事件，store 踢回登录页（消除“幽灵登录态”）
      if (r.status === 401) { try { window.dispatchEvent(new Event('pi-unauthorized')) } catch {} }
      // error 可能是字符串或对象（如 code/run 的 {kind, message}）——统一转成可读字符串
      let emsg: string
      if (data && typeof data.error === 'string') emsg = data.error
      else if (data && data.error && typeof data.error === 'object') emsg = (data.error.message ? `[${data.error.kind || 'error'}] ` : '') + (data.error.message || JSON.stringify(data.error))
      else if (r.status === 524) emsg = '网关等不及出片（524）。请短轮询任务，不要一条请求干等。'
      else emsg = `HTTP ${r.status}`
      const err = new Error(emsg); (err as any).status = r.status; throw err
    }
    return data as T
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error('请求超时')
    throw e
  } finally { clearTimeout(timer) }
}

// ── 端点封装 ──
export const ModelsApi = {
  list: () => api<{ models: Model[]; current: { provider: string; id: string } | null; autoDefault?: boolean; cwd: string; tools: string[] }>('/api/models'),
}
export const SessionsApi = {
  list: () => api<{ sessions: Session[] }>('/api/sessions'),
  create: (name?: string) => api<{ id: string; name: string }>('/api/sessions', { method: 'POST', body: { name } }),
  messages: (sid: string, opts?: { leafId?: string | null; tail?: number }) => {
    const q = new URLSearchParams()
    if (opts?.leafId) q.set('leafId', opts.leafId)
    if (opts?.tail != null) q.set('tail', String(opts.tail))
    const qs = q.toString()
    return api<SessionMessages>(`/api/sessions/${encodeURIComponent(sid)}/messages${qs ? `?${qs}` : ''}`)
  },
  rename: (sid: string, name: string) => api<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(sid)}/rename`, { method: 'POST', body: { name } }),
  remove: (sid: string) => api<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' }),
  stats: (sid: string) => api<any>(`/api/sessions/${encodeURIComponent(sid)}/stats`),
  export: (sid: string, format = 'html') => `/api/sessions/${encodeURIComponent(sid)}/export?format=${encodeURIComponent(format)}`,
}

export const StoryApi = {
  listProjects: () => api<{ projects: StoryProject[] }>('/api/story/projects'),
  createProject: (body: { title: string; logline?: string }) => api<{ project: StoryProject }>('/api/story/projects', { method: 'POST', body }),
  getProject: (id: string) => api<{ project: StoryProject }>(`/api/story/projects/${encodeURIComponent(id)}`),
  patchProject: (id: string, body: Partial<StoryProject>) => api<{ project: StoryProject }>(`/api/story/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  // 删项目：服务端会先留一份副本到 story-projects/.trash/；产物文件默认不动，
  // deleteFiles=true 时才清，且只清"没有被别的项目引用"的
  deleteProject: (id: string, body: { deleteFiles?: boolean } = {}) => api<{ deletedProjectId: string; title: string; trashCopy: string; files: { url: string; deleted: boolean; reason?: string }[]; fileDeleted: number; fileKept: number; note: string }>(`/api/story/projects/${encodeURIComponent(id)}`, { method: 'DELETE', body, timeoutMs: 300000 }),
  previewRun: (id: string, body: { sceneId: string; beatId: string; kind: StoryGenerationRun['kind']; model: StoryGenerationRun['model']; params?: Record<string, unknown>; seed?: number; variants?: number; negative?: string; inputAssets?: StoryGenerationRun['inputAssets'] }) => api<{ project: StoryProject; run: StoryGenerationRun; context: { prompt: string; referenceIds: string[] }; timeline?: StoryLineTimeline; plan?: StoryPlanStep[] }>(`/api/story/projects/${encodeURIComponent(id)}/run-preview`, { method: 'POST', body }),
  run: (id: string, body: { sceneId: string; beatId: string; kind: StoryGenerationRun['kind']; model?: StoryGenerationRun['model']; params?: Record<string, unknown>; seed?: number; variants?: number; negative?: string; reference?: { images: number; prefer: string }; inputAssets?: StoryGenerationRun['inputAssets'] }) => api<{ project: StoryProject; run: StoryGenerationRun; runs?: StoryGenerationRun[]; context: { prompt: string; referenceIds: string[] }; plan?: StoryPlanStep[]; pollWindowMs?: number }>(`/api/story/projects/${encodeURIComponent(id)}/run`, { method: 'POST', body, timeoutMs: 240000 }),
  // 收尾一次：查上游任务号（视频是异步的，创建与收尾必须分开）
  checkRun: (id: string, body: { sceneId: string; runId: string }) => api<{ project: StoryProject; run: StoryGenerationRun; status: string; settled: boolean; upstream?: string; waitedMs?: number }>(`/api/story/projects/${encodeURIComponent(id)}/run-check`, { method: 'POST', body, timeoutMs: 60000 }),
  // 一次收尾多个运行：批量生成挂着 N 个视频任务号，逐个查就是 N 个请求 + N 轮上游问答。
  // 合并成一次（一次读盘、一次写盘），也不容易撞限流。
  checkRuns: (id: string, body: { runIds: string[] }) => api<{ project: StoryProject; results: { runId: string; sceneId: string; kind?: string; status: string; settled: boolean; upstream?: string; waitedMs?: number; degradation?: string[] }[]; pending: string[]; missing: string[] }>(`/api/story/projects/${encodeURIComponent(id)}/run-check-many`, { method: 'POST', body, timeoutMs: 120000 }),
  assist: (id: string, idea: string, model?: { provider: string; id: string }) => api<{ assist: any; model: { provider: string; id: string } }>(`/api/story/projects/${encodeURIComponent(id)}/assist`, { method: 'POST', body: { idea, model }, timeoutMs: 100000 }),
  // 角色定妆照：生成后写回 bible.characters[].refImage，后续画面/视频会把它当作真实参考图注入
  portrait: (id: string, body: { characterId?: string; lookId?: string; lookName?: string; model?: { provider: string; id: string }; size?: string }) => api<{ project: StoryProject; character?: { id: string; name?: string; refImage?: string; looks?: { id?: string; name?: string; refImage?: string }[] }; look?: { id?: string; name?: string; refImage?: string }; image?: string; status?: string; error?: string }>(`/api/story/projects/${encodeURIComponent(id)}/portrait`, { method: 'POST', body, timeoutMs: 200000 }),
  // 参考图资产（角色定妆照 / 场景参考图 / 道具参考图）共用一条通路——对手都在解决"场景漂移"，
  // 我们此前只有角色有参考图。
  assetRef: (id: string, body: { assetType: 'character' | 'location' | 'prop'; assetId?: string; model?: { provider: string; id: string }; size?: string }) => api<{ project: StoryProject; asset?: { id: string; name?: string; refImage?: string }; assetType?: string; image?: string; status?: string; error?: string }>(`/api/story/projects/${encodeURIComponent(id)}/asset-ref`, { method: 'POST', body, timeoutMs: 200000 }),
  // 连续性体检：只读，把"这次生成能不能保住人物一致性"的条件提前摊开
  lint: (id: string, body: { kind?: StoryGenerationRun['kind']; capabilities?: Record<string, unknown> | null } = {}) => api<{ issues: { level: 'warn' | 'info'; code: string; message: string }[]; summary: { characters: number; portraits: number; scenes: number; beats: number; level: 'ok' | 'info' | 'warn' } }>(`/api/story/projects/${encodeURIComponent(id)}/lint`, { method: 'POST', body }),
  // 一键分镜：从梗概一次生成整场分镜表并追加进项目（自动串继承链）
  storyboard: (id: string, body: { idea?: string; count?: number; model?: { provider: string; id: string } }) => api<{ project: StoryProject; beatCount: number; sceneCount: number; characters?: number; characterNames?: string[] }>(`/api/story/projects/${encodeURIComponent(id)}/storyboard`, { method: 'POST', body, timeoutMs: 120000 }),
  // 成片合成：按分镜顺序把成功的视频片段拼成长片，并把这一版写回 project.films。
  // 传 clips 就按你挑的版本与顺序拼（同一段生成过好几版镜头时用得上）；不传就退回"每段取最新成功"。
  film: (id: string, body: { clips?: { beatId: string; runId: string }[] } = {}) => api<{ project: StoryProject; film: StoryFilm; url: string; clipCount: number; method: string; beatIds: string[]; skipped?: { beatId: string; runId: string; reason: string }[]; localized?: { beatId: string; runId: string; from: string; url: string }[] }>(`/api/story/projects/${encodeURIComponent(id)}/film`, { method: 'POST', body, timeoutMs: 900000 }),
  // 合成前的候选清单（只读）：哪几段能进片子、各自有哪些版本
  // 合成前的候选清单（只读）：哪几段能进片子、各自有哪些版本。durations=true 时顺带探每一版时长
  // （服务端要 spawn ffprobe，所以只在时间轴要报"总时长"时才带上）。
  filmPlan: (id: string, opts: { durations?: boolean } = {}) => api<StoryTimelinePlan>(`/api/story/projects/${encodeURIComponent(id)}/film-plan${opts.durations ? '?durations=1' : ''}`),
  // 删掉某一版产出：记录必删，文件只在没有别处引用时才删
  deleteRun: (id: string, body: { sceneId: string; runId: string; force?: boolean; keepFiles?: boolean }) => api<StoryRunDeleteResult>(`/api/story/projects/${encodeURIComponent(id)}/run-delete`, { method: 'POST', body }),
  // 把某一版还挂在外站的产物下载到本地（只补下载，不重新生成——省钱也保住同一个产物）
  localizeRun: (id: string, body: { sceneId: string; runId: string }) => api<{ project: StoryProject; run: StoryGenerationRun; results: { url: string; ok: boolean; alreadyLocal?: boolean; saved?: string; reason?: string }[]; localized: number; failed: number }>(`/api/story/projects/${encodeURIComponent(id)}/run-localize`, { method: 'POST', body, timeoutMs: 180000 }),
  // 全项目补下载：参考图（定妆照/场景/道具）与每一次生成的产出，一次把外站的东西拉到本地
  localize: (id: string, body: { scope?: 'refs' | 'runs' | 'all' } = {}) => api<{ project: StoryProject; scope: string; localized: number; failed: number; items: { kind: 'ref' | 'run'; label?: string; assetType?: string; itemId?: string; runId?: string; assetId?: string; from: string; ok: boolean; url?: string; alreadyLocal?: boolean; reason?: string }[]; skipped: { what: string; reason: string }[] }>(`/api/story/projects/${encodeURIComponent(id)}/localize`, { method: 'POST', body, timeoutMs: 600000 }),
  // 生成配方：调好的生成设置，可存/套用/导出/导入（跨项目共用）
  recipes: () => api<{ recipes: StoryRecipe[] }>('/api/story/recipes'),
  // 分集：短剧/系列内容的组织单位（场用 episodeId 归属；删集只解绑不删场）
  episodes: (id: string) => api<{ episodes: StoryEpisode[]; groups: StoryEpisodeGroup[]; unassigned: number }>(`/api/story/projects/${encodeURIComponent(id)}/episodes`),
  addEpisode: (id: string, body: { title?: string; summary?: string; targetSeconds?: number }) => api<{ project: StoryProject; episode: StoryEpisode }>(`/api/story/projects/${encodeURIComponent(id)}/episodes`, { method: 'POST', body }),
  updateEpisode: (id: string, body: { episodeId: string; title?: string; summary?: string; no?: number; targetSeconds?: number }) => api<{ project: StoryProject; episodes: StoryEpisode[] }>(`/api/story/projects/${encodeURIComponent(id)}/episodes`, { method: 'PATCH', body }),
  removeEpisode: (id: string, body: { episodeId: string }) => api<{ project: StoryProject; unassigned: number }>(`/api/story/projects/${encodeURIComponent(id)}/episodes/remove`, { method: 'POST', body }),
  assignScene: (id: string, body: { sceneId: string; episodeId?: string }) => api<{ project: StoryProject }>(`/api/story/projects/${encodeURIComponent(id)}/scene-assign`, { method: 'POST', body }),
  // 原著改编：小说原文（粘贴）或小说工坊的章节 → 分集大纲（集+场+段）一次落进项目。
  // preview=true 只读书、只报字数，不调模型：先看清要花多少钱再决定。
  adapt: (id: string, body: { sourceText?: string; bookId?: string; chapterFiles?: string[]; episodes?: number; secondsPerEpisode?: number; idea?: string; preview?: boolean; model?: { provider: string; id: string } }) => api<StoryAdaptResult>(`/api/story/projects/${encodeURIComponent(id)}/adapt`, { method: 'POST', body, timeoutMs: 300000 }),
  // 创作方法包（Skill）：跨项目共用的"怎么做"，与配方（工艺参数）刻意分开
  methods: () => api<{ methods: StoryMethod[] }>('/api/story/methods'),
  saveMethod: (body: Partial<StoryMethod> & { name: string }) => api<{ method: StoryMethod; methods: StoryMethod[] }>('/api/story/methods', { method: 'POST', body }),
  deleteMethod: (id: string) => api<{ ok: boolean; methods: StoryMethod[] }>(`/api/story/methods/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  captureMethod: (id: string, body: { name?: string }) => api<{ method: StoryMethod; methods: StoryMethod[]; capturedFrom: { id: string; title: string } }>(`/api/story/projects/${encodeURIComponent(id)}/method-capture`, { method: 'POST', body }),
  applyMethod: (id: string, body: { methodId: string }) => api<{ project: StoryProject; method: StoryMethod | null; applied: { episodes: number; style: boolean } }>(`/api/story/projects/${encodeURIComponent(id)}/method`, { method: 'POST', body }),
  // ── 台词与深度构思 ──
  // 台词体检：纯机检（语速/时长/拆镜），不花模型钱
  dialogueAudit: (id: string, body: { sceneId?: string } = {}) => api<StoryDialogueAuditResult>(`/api/story/projects/${encodeURIComponent(id)}/dialogue-audit`, { method: 'POST', body }),
  // 台词诊断与重构：出草稿不落盘（每条改写要给 ≥3 条维度依据）
  dialogueDoctor: (id: string, body: { sceneId?: string; model?: { provider: string; id: string } }) => api<StoryDialogueDoctorResult>(`/api/story/projects/${encodeURIComponent(id)}/dialogue-doctor`, { method: 'POST', body, timeoutMs: 180000 }),
  // 深度构思：情绪契约 / 人物四件套 / 矛盾单元 / 分集地图 / 因果节拍 / 四账台账（草稿）
  storyEngine: (id: string, body: { idea?: string; episodes?: number; episodesPerUnit?: number; model?: { provider: string; id: string } }) => api<{ project: StoryProject; engine: StoryCraftEngine; audit: StoryCraftAudit; model: { provider: string; id: string }; retried?: boolean }>(`/api/story/projects/${encodeURIComponent(id)}/story-engine`, { method: 'POST', body, timeoutMs: 240000 }),
  saveCraft: (id: string, body: { craft: StoryCraftEngine }) => api<{ project: StoryProject; audit: StoryCraftAudit }>(`/api/story/projects/${encodeURIComponent(id)}/craft`, { method: 'POST', body, timeoutMs: 60000 }),
  // 构思体检（只读）：已保存的构思也要能随时体检
  craftAudit: (id: string, body: { plannedEpisodes?: number } = {}) => api<{ audit: StoryCraftAudit; plannedEpisodes: number; hasCraft: boolean }>(`/api/story/projects/${encodeURIComponent(id)}/craft-audit`, { method: 'POST', body, timeoutMs: 30000 }),
  applyEpisodeMap: (id: string, body: { episodeMap?: StoryCraftEngine['episodeMap'] } = {}) => api<{ project: StoryProject; created: StoryEpisode[]; skipped: number }>(`/api/story/projects/${encodeURIComponent(id)}/episode-map`, { method: 'POST', body, timeoutMs: 60000 }),
  // 剧本要素与导出（Laper 的地基：能出图出片，还要能拿出一个能给人看的剧本文件）
  scriptStats: (id: string) => api<{ scenes: number; actions: number; dialogueLines: number; transitions: number; speakers: string[] }>(`/api/story/projects/${encodeURIComponent(id)}/script-stats`),
  exportScript: (id: string, body: { format: string }) => api<{ format: string; ext: string; mime: string; body: string; filename: string; stats: { scenes: number; dialogueLines: number; speakers: string[] } }>(`/api/story/projects/${encodeURIComponent(id)}/script-export`, { method: 'POST', body }),
  // 与角色对台词（Playground）：检验台词像不像这个人
  playground: (id: string, body: { sceneId: string; beatId: string; characterId?: string; message: string }) => api<{ project: StoryProject; reply: string; character: { id: string; name: string }; turns: { role: string; text: string }[] }>(`/api/story/projects/${encodeURIComponent(id)}/playground`, { method: 'POST', body, timeoutMs: 90000 }),
  playgroundClear: (id: string, body: { sceneId: string; beatId: string }) => api<{ project: StoryProject }>(`/api/story/projects/${encodeURIComponent(id)}/playground-clear`, { method: 'POST', body }),
  saveRecipe: (body: Partial<StoryRecipe> & { name: string }) => api<{ recipe: StoryRecipe; recipes: StoryRecipe[] }>('/api/story/recipes', { method: 'POST', body }),
  deleteRecipe: (id: string) => api<{ ok: boolean; recipes: StoryRecipe[] }>(`/api/story/recipes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  exportRecipes: () => api<{ format: string; version: number; exportedAt: string; recipes: StoryRecipe[] }>('/api/story/recipes/export'),
  importRecipes: (payload: unknown) => api<{ added: number; updated: number; skipped: { name: string; reason: string }[]; recipes: StoryRecipe[] }>('/api/story/recipes/import', { method: 'POST', body: payload }),
}
export const MessagesApi = {
  add: (sid: string, text: string) => api<{ ok: boolean; id: string }>(`/api/sessions/${encodeURIComponent(sid)}/messages`, { method: 'POST', body: { text } }),
}
export interface RunInfo {
  id: string
  sessionId: string
  status: RunStatus
  lastSeq: number
  [key: string]: any
}

export const RunsApi = {
  create: (body: any) => api<{ runId: string; sessionId: string; status: RunStatus; lastSeq: number }>('/api/runs', {
    method: 'POST', body: { ...body, stream: true }, timeoutMs: 30_000,
  }),
  get: (runId: string) => api<RunInfo>(`/api/runs/${encodeURIComponent(runId)}`),
  resume: (runId: string) => api<RunInfo>(`/api/runs/${encodeURIComponent(runId)}/resume`, { method: 'POST' }),
  stop: (runId: string) => api<RunInfo>(`/api/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' }),
  stream: (
    runId: string,
    after: number,
    onEvent: (event: RunEvent) => void,
    onError?: (error: Error) => void,
    onEnd?: () => void,
  ) => {
    let closed = false
    let cursor = after
    let ctrl: AbortController | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const connect = async () => {
      if (closed) return
      ctrl = new AbortController()
      try {
        const response = await fetch(apiUrl(`/api/runs/${encodeURIComponent(runId)}/events?after=${cursor}`), {
          headers: { Authorization: `Bearer ${_token}`, 'Last-Event-ID': String(cursor) },
          signal: ctrl.signal,
        })
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (!closed) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const parsed = parseSseBlocks(buffer)
          buffer = parsed.rest
          for (const event of parsed.events) {
            if (event.seq <= cursor) continue
            cursor = event.seq
            onEvent(event)
          }
        }
        if (!closed) onEnd?.()
      } catch (error: any) {
        if (closed || error?.name === 'AbortError') return
        onError?.(error instanceof Error ? error : new Error(String(error)))
      }
      if (!closed && !retryTimer) {
        retryTimer = setTimeout(() => { retryTimer = null; connect() }, 1500)
      }
    }

    connect()
    return () => {
      closed = true
      if (retryTimer) clearTimeout(retryTimer)
      ctrl?.abort()
    }
  },
}

// 会话实时订阅（SSE，多端同步）。使用 fetch 是因为 EventSource 不能设置 Authorization 头。
export function streamSession(sid: string, after = 0, onEvent: (ev: any) => void, onError?: () => void): () => void {
  let closed = false
  let cursor = after
  let ctrl: AbortController | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  const connect = async () => {
    if (closed) return
    ctrl = new AbortController()
    try {
      const response = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(sid)}/stream?after=${cursor}`), {
        headers: { Authorization: `Bearer ${_token}`, 'Last-Event-ID': String(cursor) },
        signal: ctrl.signal,
      })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (!closed) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const blocks = buffer.replace(/\r\n/g, '\n').split('\n\n')
        buffer = blocks.pop() || ''
        for (const block of blocks) {
          if (!block || block.startsWith(':')) continue
          let eventType = 'message'
          const dataLines: string[] = []
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) eventType = line.slice(6).trim()
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
          }
          if (!dataLines.length || !['message', 'subscribed', 'session_updated'].includes(eventType)) continue
          try {
            const event = JSON.parse(dataLines.join('\n'))
            if (event && typeof event === 'object') {
              if (Number.isInteger(event.seq)) cursor = Math.max(cursor, event.seq)
              if (eventType === 'subscribed' && Number.isInteger(event.lastSeq)) cursor = Math.max(cursor, event.lastSeq)
              onEvent(event)
            }
          } catch {}
        }
      }
    } catch (error: any) {
      if (closed || error?.name === 'AbortError') return
      onError?.()
    }
    if (!closed && !retryTimer) {
      retryTimer = setTimeout(() => { retryTimer = null; connect() }, 5000)
    }
  }
  connect()
  return () => { closed = true; if (retryTimer) clearTimeout(retryTimer); ctrl?.abort() }
}

// ── 语音转文字（录音 → 文本，后端走 mimo-v2.5-asr 免费通道）──
export const AsrApi = {
  transcribe: (data: string, format: string) =>
    api<{ text: string; model: string }>("/api/asr", { method: "POST", body: { data, format }, timeoutMs: 130000 }),
}
// 情绪快照（服务端 VAD 情绪引擎；返回裸快照，SSE emotion 事件则包在 {state} 里）
export const EmotionApi = {
  get: (sid?: string) => api<any>(`/api/emotion${sid ? `?session=${encodeURIComponent(sid)}` : ''}`),
  tide: () => api<{ tide: any[] }>('/api/emotion/tide'),
  feelings: () => api<{ feelings: any[] }>('/api/emotion/feelings'),
}
// 全局执行状态：哪些会话的 agent 正在跑（状态灯轮询，含后台/他端发起）
export const AgentStatusApi = {
  get: () => api<{ busy: { id: string; since: number | null }[]; anyBusy: boolean }>('/api/agent-status'),
}

// 小语活动事件流（对标 vanilla 活动面板）
export interface AgentEvent { type: string; ts: string | number; data?: { tool?: string; text?: string; [k: string]: unknown } }
export const AgentEventsApi = {
  get: () => api<{ events: AgentEvent[] }>('/api/agent/events'),
}

// ── 危险操作确认（dsh user-approval seam）：后端弹确认事件 → 前端回传结果 ──
export const ConfirmApi = {
  answer: (sessionId: string, id: string, ok: boolean) =>
    api<{ ok: boolean; outcome: string }>('/api/agent/confirm', { method: 'POST', body: { sessionId, id, ok }, timeoutMs: 8000 }),
}

// ── 灵犀：双向灵感池（user/xiaoyu 分源记录）──
export interface LingXiEntry {
  id: string
  source: LingXiSource
  text: string
  status: 'new' | 'adopted' | 'converted' | 'archived'
  target?: 'skill' | 'capability' | 'project' | 'memory'
  artifact?: string
  note: string
  ts: string
}
export type LingXiSource = 'user' | 'xiaoyu'
export const LingXiApi = {
  list: (filter?: { source?: LingXiSource; status?: string }) => {
    const q = new URLSearchParams()
    if (filter?.source) q.set('source', filter.source)
    if (filter?.status) q.set('status', filter.status)
    const qs = q.toString()
    return api<{ entries: LingXiEntry[] }>('/api/lingxi' + (qs ? '?' + qs : ''))
  },
  add: (body: { text: string; source: LingXiSource }) =>
    api<{ ok: boolean; entry: LingXiEntry }>('/api/lingxi', { method: 'POST', body }),
  setStatus: (id: string, status: 'new' | 'adopted' | 'converted' | 'archived', patch?: { note?: string; target?: 'skill' | 'capability' | 'project' | 'memory'; artifact?: string }) =>
    api<{ ok: boolean; entry: LingXiEntry }>(`/api/lingxi/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status, ...patch } }),
  remove: (id: string) => api<{ ok: boolean }>(`/api/lingxi/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}

// ── 主题偏好跨端同步（08-26：一端更新，各端打开拉取一致）──
export const ThemeApi = {
  get: () => api<{ theme: string; accent: string; wallpaper: string }>('/api/theme-prefs', { timeoutMs: 2500 }),
  save: (theme: string, accent: string, wallpaper?: string) => {
    const body: { theme: string; accent: string; wallpaper?: string } = { theme, accent }
    if (wallpaper !== undefined) body.wallpaper = wallpaper
    return api<{ theme: string; accent: string; wallpaper: string }>('/api/theme-prefs', { method: 'POST', body })
  },
}

// ── 全局创作配色卡（2026-09-16）：选一套，所有出图/出片入口都按它写「色调」──
// 与主题偏好分开：主题管界面，这张卡管画面。项目要单独覆盖走 story 的 colorCardId。
export const ColorApi = {
  get: () => api<{ colorCardId: string }>('/api/color-prefs', { timeoutMs: 2500 }),
  save: (colorCardId: string) => api<{ colorCardId: string }>('/api/color-prefs', { method: 'POST', body: { colorCardId } }),
}

// ── 出图（自动落盘生成物/图片/日期，资产库联动）──
export const MediaApi = {
  image: (body: { provider: string; modelId: string; prompt: string; size?: string }) =>
    api<{ image?: string; error?: string }>('/api/image', { method: 'POST', body, timeoutMs: 190000 }),
  video: (body: { provider: string; modelId: string; prompt?: string; seconds?: string; size?: string; aspect_ratio?: string; mode?: string; task_id?: string }) =>
    api<{ video?: string; error?: string; task_id?: string; status?: string }>('/api/media', { method: 'POST', body, timeoutMs: 70000 }),
}

// ── 专项工作台（SSE 长任务：PPT/小说生成，事件 note/delta/file/done/error）──
export const WorkshopApi = {
  // 作品集（扫描式：workshop-out 落盘即收录）
  galleryList: () => api<{ items: { id: string; kind: 'deck' | 'pptx'; dir: string; title: string; pages: number; themeKey: string; ts: number; cover: string }[] }>('/api/gallery'),
  galleryDeckUrl: (dir: string, file: string) => `/api/gallery/page?dir=${encodeURIComponent(dir)}&file=${encodeURIComponent(file)}`,
  galleryDeck: (dir: string) => api<{ dir: string; pages: { file: string; title: string; layout: string; html: string }[] }>(`/api/gallery/deck?dir=${encodeURIComponent(dir)}`),
  pptThemes: () => api<{ themes: { key: string; label: string; builtin: boolean }[] }>('/api/workshop/ppt/themes'),
  distillTheme: (body: { url?: string; htmlPath?: string; name?: string }) =>
    api<{ ok: boolean; key: string; label: string; tokens: { bg: string; fg: string; muted: string; accent: string; accent2: string; bgIsDark: boolean } }>('/api/workshop/ppt/distill', { method: 'POST', body, timeoutMs: 30000 }),
  // PPT 大纲编辑后本地重建 .pptx（2026-09-03 设计干预）
  rebuildPptx: (body: { jsonPath: string; slides: { layout: string; title: string; content: string[] }[] }, opts?: any) =>
    api<{ ok: boolean; file: { name: string; path: string; size: number }; slides: unknown[] }>('/api/workshop/pptx/rebuild', { method: 'POST', body, ...opts }),
  pptHistory: () => api<{ entries: { id: string; ts: string; theme: string; pages: number; style: string; file?: { name: string; path: string; size: number }; json?: string }[] }>('/api/workshop/ppt/history'),
  expandPrompt: (body: { kind: 'image' | 'video' | 'html'; idea: string; draft?: string; model?: string }) =>
    api<{ ok?: boolean; prompt?: string; fields?: Record<string, string>; source?: string; error?: string; model?: string; modelName?: string; skills?: string[] }>('/api/workshop/expand-prompt', { method: 'POST', body, timeoutMs: 30000 }),
  // PPT 设计稿模式（HTML 路线，2026-09-03）：SSE 逐页推 HTML，前端 iframe 真渲染
  runHtml: (body: { theme: string; pages: number; themeKey: string; audience?: string; verb?: string }, onEvent: (ev: { type: string; data: any }) => void) =>
    WorkshopApi.runLike('/api/workshop/ppt/html', body, onEvent),
  refinePage: (body: { dir: string; file: string; instruction: string; model?: string }, onEvent: (ev: { type: string; data: any }) => void) =>
    WorkshopApi.runLike('/api/workshop/ppt-html/refine', body, onEvent),
  saveHtmlPage: (body: { file: string; html: string; title?: string }) =>
    api<{ ok: boolean }>('/api/workshop/ppt-html/save', { method: 'POST', body, timeoutMs: 30000 }),
  runLike: (path: string, body: any, onEvent: (ev: { type: string; data: any }) => void) => {
    const ctrl = new AbortController()
    ;(async () => {
      try {
        const r = await fetch(apiUrl(path), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${_token}` },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        })
        if (!r.ok || !r.body) {
          let msg = `HTTP ${r.status}`
          try { const j = JSON.parse(await r.text()); if (j?.error) msg = String(j.error) } catch {}
          onEvent({ type: 'error', data: { message: msg } }); return
        }
        const reader = r.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let idx
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, idx); buffer = buffer.slice(idx + 2)
            let evType = 'message'; const dataLines: string[] = []
            for (const line of chunk.split('\n')) {
              if (line.startsWith('event:')) evType = line.slice(6).trim()
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
            }
            const evData = dataLines.join('\n')
            if (!evData) continue
            try { onEvent({ type: evType, data: JSON.parse(evData) }) } catch {}
          }
        }
        onEvent({ type: 'done', data: {} })
      } catch (e: any) {
        if (e?.name !== 'AbortError') onEvent({ type: 'error', data: { message: e.message } })
      }
    })()
    return () => ctrl.abort()
  },
  run: (kind: 'ppt' | 'novel', body: any, onEvent: (ev: { type: string; data: any }) => void) => {
    return WorkshopApi.runLike(`/api/workshop/${kind}`, body, onEvent)
  },
}

// ── 小说工坊（书架式：作品沉淀/真相文件/第N章递进）──
export interface NovelBook {
  id: string; title: string; genre: string; protagonist?: string; status?: string; narrator?: string
  chapters: number; createdAt?: string; pipelineReady?: number; pipelineTotal?: number
}
export interface NovelChapter { file: string; no: number; size: number; mtimeMs: number; title?: string; chars?: number }
export interface NovelPipelineNode {
  id: string; phase: string; label: string; kind: string; generate?: boolean; ready: boolean; chars: number
}
function novelSse(path: string, body: object, onEvent: (ev: { type: string; data: any }) => void) {
  const ctrl = new AbortController()
  ;(async () => {
    try {
      const r = await fetch(apiUrl(path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${_token}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
      if (!r.ok || !r.body) {
        let msg = `HTTP ${r.status}`
        try { const j = JSON.parse(await r.text()); if (j?.error) msg = String(j.error) } catch {}
        onEvent({ type: 'error', data: { message: msg } }); return
      }
      const reader = r.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const chunks = buffer.split('\n\n')
        buffer = chunks.pop() || ''
        for (const chunk of chunks) {
          let ev = '', data = ''
          for (const line of chunk.split('\n')) {
            if (line.startsWith('event:')) ev = line.slice(6).trim()
            else if (line.startsWith('data:')) data += line.slice(5).trim()
          }
          if (ev && data) { try { onEvent({ type: ev, data: JSON.parse(data) }) } catch {} }
        }
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') onEvent({ type: 'error', data: { message: String(e?.message || e) } })
    }
  })()
  return () => ctrl.abort()
}
export const NovelApi = {
  books: () => api<{ books: NovelBook[] }>('/api/novel/books'),
  create: (body: { title: string; genre: string; protagonist?: string; setting?: string; narrator?: string }) =>
    api<{ ok?: boolean; id?: string; error?: string }>('/api/novel/books', { method: 'POST', body }),
  update: (body: { id: string; title?: string; status?: string; genre?: string; protagonist?: string; setting?: string }) =>
    api<{ ok?: boolean; error?: string }>('/api/novel/books', { method: 'PATCH', body }),
  remove: (id: string) =>
    api<{ ok?: boolean; error?: string }>(`/api/novel/books?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),
  detail: (id: string) =>
    api<{ id: string; meta?: any; chapters: NovelChapter[]; truth?: any; nextCh: number; pipeline?: NovelPipelineNode[]; notes?: string; error?: string }>(`/api/novel/detail?id=${encodeURIComponent(id)}`),
  chapter: (id: string, file: string) =>
    api<{ ok?: boolean; file: string; content: string; error?: string }>(`/api/novel/chapter?id=${encodeURIComponent(id)}&file=${encodeURIComponent(file)}`),
  saveChapter: (body: { id: string; file: string; content: string }) =>
    api<{ ok?: boolean; error?: string }>('/api/novel/chapter', { method: 'POST', body }),
  node: (id: string, node: string) =>
    api<{ ok?: boolean; content: string; error?: string }>(`/api/novel/node?id=${encodeURIComponent(id)}&node=${encodeURIComponent(node)}`),
  saveNode: (body: { id: string; node: string; content: string }) =>
    api<{ ok?: boolean; error?: string }>('/api/novel/node', { method: 'POST', body }),
  export: (id: string) =>
    api<{ ok?: boolean; content: string; chapters?: number; error?: string }>(`/api/novel/export?id=${encodeURIComponent(id)}`),
  write: (body: { id: string; outline?: string; note?: string; model?: string }, onEvent: (ev: { type: string; data: any }) => void) =>
    novelSse('/api/novel/write', body, onEvent),
  advance: (body: { id: string; node: string; note?: string; model?: string }, onEvent: (ev: { type: string; data: any }) => void) =>
    novelSse('/api/novel/advance', body, onEvent),
  revise: (body: { id: string; note?: string; model?: string }, onEvent: (ev: { type: string; data: any }) => void) =>
    novelSse('/api/novel/revise', body, onEvent),
  studio: (body: { id: string; note?: string; model?: string }, onEvent: (ev: { type: string; data: any }) => void) =>
    novelSse('/api/novel/studio', body, onEvent),
  saveNotes: (body: { id: string; notes: string }) =>
    api<{ ok?: boolean; error?: string }>('/api/novel/notes', { method: 'POST', body }),
}

// ── 代码模式（终端面板）──
export interface CodeBinding { name: string; args?: any; description: string }
export const CodeApi = {
  tools: () => api<{ bindings: CodeBinding[]; sdk: string }>('/api/code/tools'),
  run: (program: string, timeoutMs?: number) =>
    api<{ value?: any; logs?: string[]; error?: { kind: string; message: string } }>('/api/code/run', { method: 'POST', body: { program, timeoutMs }, timeoutMs: 130000 }),
}

// ── 应用中心 ──
export const RefineApi = {
  list: () => api<{ pending: any[]; applied: any[]; rejected: any[] }>('/api/refine/list'),
  status: () => api<{ counts: { pending: number; applied: number; rejected: number }; lastLog?: string | null }>('/api/refine/status'),
  plan: () => api<any>('/api/refine/plan', { method: 'POST', body: {}, timeoutMs: 190000 }),
  approve: (id: string) => api<any>('/api/refine/approve', { method: 'POST', body: { id }, timeoutMs: 60000 }),
  reject: (id: string) => api<any>('/api/refine/reject', { method: 'POST', body: { id } }),
}
export const SkillsApi = {
  list: () => api<{ skills: SkillSummary[]; sources?: Record<string, number>; categories?: Record<string, number>; diagnostics?: string[] }>('/api/skills'),
}
export const PromptsApi = {
  list: () => api<{ prompts: { name: string; description: string; content: string }[] }>('/api/prompts'),
}
export const ImprovementsApi = {
  list: () => api<{ improvements: any[]; diagnostics?: { total: number; open: number; openImprovements: number; openEvolution: number; openSkillNudge: number; openMemoryNudge: number } }>('/api/improvements'),
  analyze: () => api<{ improvements: any[]; diagnostics?: { total: number; open: number; openImprovements: number; openEvolution: number; openSkillNudge: number; openMemoryNudge: number } }>('/api/improvements/analyze', { method: 'POST' }),
  setStatus: (id: string, status: string) => api<any>(`/api/improvements/${encodeURIComponent(id)}/status`, { method: 'POST', body: { status } }),
}

// 进化引擎（09-03，Hermes GEPA 思想）：反思式提示词进化 + 人工审批红线
export const EvolutionApi = {
  list: () => api<{ proposals: any[] }>('/api/evolution/proposals'),
  propose: (name: string) => api<{ ok?: boolean; id?: string; variants?: number; traces?: number; analysis?: string; error?: string }>('/api/evolution/propose', { method: 'POST', body: { name }, timeoutMs: 180000 }),
  apply: (id: string, variantIndex = 0) => api<{ ok?: boolean; backup?: string; error?: string }>('/api/evolution/apply', { method: 'POST', body: { id, variantIndex } }),
  dismiss: (id: string) => api<{ ok?: boolean }>('/api/evolution/dismiss', { method: 'POST', body: { id } }),
  evaluate: (id: string) => api<{ ok?: boolean; evaluation?: any; error?: string }>('/api/evolution/evaluate', { method: 'POST', body: { id }, timeoutMs: 300000 }),
}

// 技能自主沉淀（Hermes 闭环）：任务完成后自动评估是否值得沉淀为 SKILL.md
export const SkillNudgeApi = {
  list: () => api<{ nudges: any[] }>('/api/skillnudge/list'),
  apply: (id: string) => api<{ ok?: boolean; path?: string; error?: string }>('/api/skillnudge/apply', { method: 'POST', body: { id } }),
  dismiss: (id: string) => api<{ ok?: boolean }>('/api/skillnudge/dismiss', { method: 'POST', body: { id } }),
}

// 记忆 nudge（情绪→记忆联动）：residue 跨阈值自动提案记忆写入
export const MemoryNudgeApi = {
  list: () => api<{ nudges: any[] }>('/api/memorynudge/list'),
  apply: (id: string) => api<{ ok?: boolean; file?: string; error?: string }>('/api/memorynudge/apply', { method: 'POST', body: { id } }),
  dismiss: (id: string) => api<{ ok?: boolean }>('/api/memorynudge/dismiss', { method: 'POST', body: { id } }),
}

// 跨会话回忆（Hermes FTS5 思想零依赖落地）：bigram 倒排检索 + LLM 综合回答
export const RecallApi = {
  ask: (q: string) => api<{ answer?: string; hits: any[]; error?: string }>('/api/recall/ask', { method: 'POST', body: { q }, timeoutMs: 120000 }),
  search: (q: string) => api<{ q: string; total: number; hits: any[] }>(`/api/recall?q=${encodeURIComponent(q)}`),
  rebuild: () => api<{ ok?: boolean; total: number; rebuilt: number; snippets: number; grams: number }>('/api/recall/rebuild', { method: 'POST', body: {}, timeoutMs: 120000 }),
  stats: () => api<{ sessions: number; snippets: number; grams: number; summaries: number; lastRebuild: string | null }>('/api/recall/stats'),
  summaries: () => api<{ summaries: Record<string, string>; generatedAt: string | null }>('/api/recall/summaries'),
  summarize: () => api<{ ok?: boolean; generated: number; totalKnown: number; error?: string }>('/api/recall/summarize', { method: 'POST', body: {}, timeoutMs: 300000 }),
}
export const MemCompressApi = {
  analyze: () => api<{ total?: number; fresh?: number; old?: number; oldest?: string; worthIt?: boolean; error?: string }>('/api/memcompress/analyze'),
  propose: () => api<{ ok?: boolean; id?: string; beforeCount?: number; archiveCount?: number; error?: string }>('/api/memcompress/propose', { method: 'POST', body: {}, timeoutMs: 180000 }),
  list: () => api<{ proposals: any[] }>('/api/memcompress/list'),
  apply: (id: string) => api<{ ok?: boolean; backup?: string; archiveFile?: string; error?: string }>('/api/memcompress/apply', { method: 'POST', body: { id } }),
  dismiss: (id: string) => api<{ ok?: boolean }>('/api/memcompress/dismiss', { method: 'POST', body: { id } }),
}
// ── 记忆园丁：只报告记忆健康（重复/过时状态/膨胀），不自动写 ──
export const MemoryApi = {
  gardener: () => api<any>('/api/memory-gardener'),
  report: () => api<any>('/api/memory-gardener'),
  markReviewed: (kind: string, key: string, unmark = false) =>
    api<{ ok: boolean }>('/api/memory-gardener/reviewed', { method: 'POST', body: { kind, key, unmark } }),
  dedupe: () => api<{ ok: boolean; removed: number; backup: string | null }>('/api/memory-gardener/dedupe', { method: 'POST' }),
  // 记忆快照：此前只有写入方、没有读取方（98.7MB 攒着却一份都回退不了）
  snapshots: () => api<{ ok: boolean; total: number; items: { id: string; reason: string; timestamp: string; bytes: number }[] }>('/api/memory/snapshots'),
  restoreSnapshot: (id: string) => api<{ ok: boolean; id?: string; reason?: string; error?: string }>('/api/memory/snapshot/restore', { method: 'POST', body: { id } }),
}

// ── 承诺兑现：模型自己许下但没结清的事。结清只能人工给结论，没有自动判定 ──
export interface PromisePending { id: string; text: string; at: string; due: string | null; sessionId: string; agePhrase: string; overdue: boolean }
export interface PromiseClosed { id: string; text: string; at: string; status: 'kept' | 'dropped' | string; evidence: string | null; closedAt: string | null }
export const PromiseApi = {
  list: () => api<{ ok: boolean; pending: PromisePending[]; closed: PromiseClosed[] }>('/api/promises'),
  close: (id: string, status: 'kept' | 'dropped' = 'kept', evidence?: string) =>
    api<{ ok: boolean; id?: string; status?: string; reason?: string }>('/api/promises/close', { method: 'POST', body: { id, status, evidence } }),
}

// ── 跨轮目标：引擎侧有三重闸门（回合上限 / 单轮预约 / 错误即解除）。
// 台前只做"人类给结论"这一侧：武装与结清都只可能来自这里的点击。 ──
export interface GoalItem {
  id: string; objective: string; status: 'paused' | 'active' | 'complete' | 'blocked' | string
  round: number; maxRounds: number; autoAdvance: boolean
  evidence: string | null; blockedReason: string | null; updatedAt: string
}
export const GoalApi = {
  list: () => api<{ ok: boolean; active: GoalItem | null; goals: GoalItem[] }>('/api/goals'),
  create: (objective: string, maxRounds?: number, autoAdvance?: boolean) =>
    api<{ ok: boolean; goal?: GoalItem; reason?: string }>('/api/goals/create', { method: 'POST', body: { objective, maxRounds, autoAdvance } }),
  action: (id: string, action: 'arm' | 'pause' | 'complete' | 'block', extra: { evidence?: string; reason?: string; autoAdvance?: boolean } = {}) =>
    api<{ ok: boolean; goal?: GoalItem; reason?: string }>('/api/goals/action', { method: 'POST', body: { id, action, ...extra } }),
}

// ── 会话级沙箱模式：引擎侧是 append-only 日志 + fold（收紧随时可以、放宽必须给理由）──
export interface SandboxPreset { id: string; mode: string; label: string; desc: string }
export interface SandboxView {
  ok: boolean; sessionId: string
  preset: string; mode: string; label: string; desc: string; defaultPreset: string
  presets: SandboxPreset[]
  history: { at: string; preset: string; mode: string; from: string; widening: boolean; origin: string; reason: string | null }[]
}
export const SandboxApi = {
  get: () => api<SandboxView>('/api/sandbox/mode'),
  set: (preset: string, reason?: string) =>
    api<{ ok: boolean; reason?: string; sessionId?: string; view?: SandboxView }>('/api/sandbox/mode', { method: 'POST', body: { preset, reason } }),
}

// ── 系统面板：说明 / 检测更新 ──
export const SystemApi = {
  info: () => api<any>('/api/system/info'),
  checkUpdate: () => api<any>('/api/system/check-update'),
  saveNetwork: (body: { domains: { domain: string; desc: string }[] }) =>
    api<{ ok: boolean; domains: { domain: string; desc: string }[] }>('/api/system/network', { method: 'POST', body }),
}

// ── 引擎面板（旧版引入：组件实现 / 插件注册表 / 动态注册 / /api/engine/chat）──
export const EngineApi = {
  status: () => api<any>('/api/engine/status'),
  tools: () => api<{ tools: { name: string; description: string }[]; count: number; dsh: boolean; skill: boolean }>('/api/engine/tools'),
  pair: () => api<{ primary: string; secondary: string; catalog: { id: string; label: string; canLead: boolean; desc: string; intro?: string; can?: string[]; cannot?: string[] }[]; lead: string; deferred: string | null; eval?: { passed: number; total: number; score: number; byTag?: Record<string, { passed: number; total: number }> } }>('/api/engine/pair'),
  savePair: (body: { primary?: string; secondary?: string; swap?: boolean }) =>
    api<{ primary: string; secondary: string; lead: string; deferred: string | null; error?: string }>('/api/engine/pair', { method: 'POST', body }),
  registerPlugin: (def: any) => api<any>('/api/engine/plugins/register', { method: 'POST', body: def }),
  unregisterPlugin: (id: string) => api<any>('/api/engine/plugins/unregister', { method: 'POST', body: { id } }),
}

export type RunPhase = 'queued' | 'thinking' | 'executing' | 'remembering' | 'delivering' | 'completed' | 'failed' | 'stopped' | 'interrupted'
export interface RunSummary {
  explanation?: WorkExplanationData
  id: string; sessionId: string; status: string; phase: RunPhase; messagePreview: string; toolCount: number; memoryCount: number; memoryPreview: string | null; error: string | null; resumeAvailable?: boolean; durationMs?: number | null; failureCategory?: string | null
}
export interface RunOverview { active: RunSummary[]; recent: RunSummary[]; health: { status: 'idle' | 'busy' | 'degraded'; activeCount: number; failedCount: number } }
export const RunApi = {
  overview: (sessionId?: string) => api<RunOverview>(`/api/run/overview${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`),
  get: (id: string) => api<RunSummary & { lastSeq: number }>(`/api/runs/${encodeURIComponent(id)}`),
  resume: (id: string) => api<RunSummary & { lastSeq: number }>(`/api/runs/${encodeURIComponent(id)}/resume`, { method: 'POST' }),
}

// ── 用量统计（按 provider/模型聚合）──
export interface ProviderStat { provider: string; input: number; output: number; cacheRead?: number; cost: number; messages: number }
export const StatsApi = {
  providers: () => api<{ providers: ProviderStat[] }>('/api/stats/providers'),
  global: () => api<any>('/api/stats/global'),
  // 工作台 7 天用量分桶（09-03）
  daily: () => api<{ days: { day: string; label: string; input: number; output: number; cost: number; messages: number; sessions: number }[] }>('/api/stats/daily'),
}

// 工作台：subagent 异步运行（best-effort 扫描，无落盘时返回空）
export interface SubagentRun { id: string; agent: string; state: string; task: string; startedAt?: string | null; updatedAt?: string | null }

// ── 改动与验收工作台：只读 Git 快照 ──
export interface GitReviewFile {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
  code: string
  additions: number | null
  deletions: number | null
}
export interface GitReview {
  isRepo: boolean
  error?: string
  branch: string | null
  /** Git root used by the review workbench (the application repository, not the content workspace). */
  root?: string
  files: GitReviewFile[]
  diff: string
  diffTruncated: boolean
  verification: { state: 'unknown' | 'running' | 'passed' | 'failed'; checks: { name?: string; state?: string }[] }
}
export const GitReviewApi = {
  review: () => api<GitReview>('/api/git/review'),
}

export interface AIBodyModule {
  label: string; path: string; available: boolean
  /** 土壤五项才有：内部 key 与真实读数（服务端已算出，台前此前只用了 available） */
  key?: string
  status?: 'observed' | 'not_observed' | 'unavailable' | string
  statusLabel?: string
  summary?: string
  details?: Record<string, unknown> | null
}
export interface AIBodyLayer { id: 'host' | 'organism' | 'expression' | string; label: string; summary: string; modules: AIBodyModule[] }
export interface AIBodyTheory { id: string; label: string; detail: string; evidence: string[] }
export interface AIBodyOverview {
  updatedAt?: string; principle: string; theory: AIBodyTheory[]; layers: AIBodyLayer[]
  companionship?: { continuity: string; memory: string; boundary: string }
  evolution?: { mode: string; humanApproval: boolean; rollback: boolean; scope: string[]; protected: string[] }
}
export const AIBodyApi = {
  overview: () => api<AIBodyOverview>('/api/aibody'),
}

export interface SubagentHistoryRun {
  id: string
  runId: string
  source: 'mission' | 'async' | string
  missionId?: string
  agent: string
  state: string
  status: string
  task: string
  startedAt?: string | null
  updatedAt?: string | null
  completedAt?: string | null
  durationMs?: number | null
  model?: string
  toolCount?: number
  eventCount?: number
  error?: string
  acceptanceStatus?: string
  reviewFindings?: string[]
  residualRisks?: string[]
}
export interface SubagentMission {
  id: string
  title: string
  objective?: string
  status: string
  createdAt?: string | null
  updatedAt?: string | null
  cwd?: string
  summary?: string
  acceptanceStatus?: string
  runs: SubagentHistoryRun[]
  artifacts: { kind: string; name: string; path: string; description?: string }[]
}
export interface SubagentHistory {
  updatedAt?: string
  counts: { missions: number; runs: number; failed: number }
  missions: SubagentMission[]
  runs: SubagentHistoryRun[]
}
export const SubagentApi = {
  runs: () => api<{ runs: SubagentRun[] }>('/api/subagent/runs'),
  history: () => api<SubagentHistory>('/api/subagent/history'),
}

// ── 定时任务（时间引擎）──
export interface TimeTask { id: string; type: 'daily' | 'weekly' | 'once'; at: string; day?: number | null; date?: string | null; prompt: string; label: string; created: string; lastRun?: string | null; runs?: number; state?: string; running?: boolean; history?: { queueId: string; startedAt: string; durationMs: number; status: string; result: string }[] }
export const TasksApi = {
  list: () => api<{ tasks: TimeTask[] }>('/api/time/tasks'),
  create: (body: { type: string; at: string; day?: number; date?: string; prompt: string; label?: string }) =>
    api<{ id?: string; error?: string }>('/api/time/tasks', { method: 'POST', body }),
  remove: (id: string) => api<{ removed: boolean }>(`/api/time/tasks?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // 任务中心 v2：状态机 / 手动执行 / 运行历史
  setState: (id: string, action: 'pause' | 'resume' | 'archive') =>
    api<{ ok?: boolean; state?: string; error?: string }>('/api/time/tasks', { method: 'PATCH', body: { id, action } }),
  runNow: (id: string) => api<{ ok?: boolean; queueId?: string; error?: string }>('/api/time/tasks/run', { method: 'POST', body: { id } }),
  stopRun: (id: string) => api<{ stopped?: boolean; error?: string }>('/api/time/tasks/stop', { method: 'POST', body: { id } }),
  history: (id: string) => api<{ history: { queueId: string; startedAt: string; durationMs: number; status: string; result: string }[] }>(`/api/time/tasks/history?id=${encodeURIComponent(id)}`),
}

// ── 工作空间 ──
export const WsApi = {
  tree: (p = '') => api<{ items: { name: string; type: string; path: string }[]; current: string }>(`/api/ws/tree?path=${encodeURIComponent(p)}`),
  read: (p: string) => api<{ content: string; name: string; path: string }>(`/api/ws/read?path=${encodeURIComponent(p)}`),
  write: (path: string, content: string) => api<{ ok: boolean }>('/api/ws/write', { method: 'POST', body: { path, content } }),
  search: (q: string) => api<{ results?: any[] }>(`/api/ws/search?q=${encodeURIComponent(q)}`),
  artifacts: () => api<{ artifacts: Artifact[] }>('/api/ws/artifacts'),
  deliveries: () => api<{ deliveries?: AssetDelivery[] }>('/api/ws/deliveries'),
  preview: (path: string) => api<{ kind: 'presentation'; name: string; slides: { index: number; title: string; lines: string[] }[]; note?: string }>('/api/ws/preview', { method: 'POST', body: { path }, timeoutMs: 30000 }),
  // 交付：把工作空间文件复制到 交付/ 目录（版本化）
  deliver: (sourcePath: string, name?: string) => api<{ ok: boolean; path: string; version: number }>('/api/ws/deliver', { method: 'POST', body: { sourcePath, name } }),
  rename: (oldPath: string, newName: string) => api<{ ok: boolean; path: string }>('/api/ws/rename', { method: 'POST', body: { oldPath, newName } }),
  delete: (path: string) => api<{ ok: boolean }>('/api/ws/delete', { method: 'POST', body: { path, confirmed: true } }),
  // 上传：base64 写入工作空间并推送到会话（sessionId 可空）
  upload: (name: string, data: string, sessionId?: string) => api<{ ok?: boolean; path?: string }>('/api/files/upload', { method: 'POST', body: { name, data, sessionId: sessionId || '' }, timeoutMs: 120000 }),
}

// ── 模型管理 ──
export const KeysApi = {
  manage: () => api<any>('/api/models/manage'),
  presets: () => api<any>('/api/keys/presets'),
  status: () => api<any>('/api/keys/status'),
  apply: (body: any) => api<any>('/api/keys/apply', { method: 'POST', body }),
  add: (body: any) => api<any>('/api/models/add', { method: 'POST', body }),
  remove: (provider: string) => api<any>('/api/models/remove', { method: 'POST', body: { provider } }),
  switchModel: (body: any) => api<any>('/api/model', { method: 'POST', body }),
}
