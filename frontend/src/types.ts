// 共享类型：元枢 API 契约（与 server.mjs 对齐）
export interface Model {
  provider: string
  id: string
  name: string
  contextWindow?: number
  vision?: boolean
  reasoning?: boolean
  capabilities?: Record<string, any>
  free?: boolean
  note?: string
}

export interface Session {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  preview: string
  messageCount: number
  file?: string
  cwd?: string
  group?: string
}

export interface ToolCall {
  id: string
  name: string
  args?: string
  argsText?: string // 流式态用（与 RunningTool 兼容）
  output?: string
  isError?: boolean
  running?: boolean
  status?: ToolStatus
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  files?: { path: string; name?: string }[]
  images?: string[]   // dataURI 或 URL
  audios?: string[]   // URL
  videos?: string[]   // URL
  notes?: string[]    // 系统提示条（SSE note 事件）
  tools?: ToolCall[]
  think?: string
  conclusion?: string // 流式阶段分区：工具开始后的结论文字（text 仍为完整逻辑文本；仅流式中传，历史消息不存）
  ts?: string
  model?: { provider: string; id: string } // provenance：实际使用的模型（Auto 路由时前端可见）
  streaming?: boolean // 是否正在流式生成中
  isDraft?: boolean   // 是否是本地未同步的草稿（刷新/卡住恢复用）
}

// 生成物（资产库）条目
export interface Artifact {
  name: string
  type: string
  date: string
  path: string
  size: number
  url: string
  prompt?: string
  mtimeMs?: number
}

export interface StoryAssetRef { id: string; role?: string; weight?: number; type?: string; url?: string; text?: string; prompt?: string; name?: string }
// 台词时间轴：锚点是**语义位置**、秒数由文本估出来（estimated），所以改一句台词只会让它与它之后
// 的时间变，前面的不动。语速常量只有引擎那一份（story-craft 的 SPEECH），前端不重算。
export interface StoryLine { id: string; anchor: number; speaker: string; text: string; chars: number; seconds: number; start: number; end: number }
export interface StoryLineTimeline { total: number; rate: number; estimated: boolean; lines: StoryLine[] }
export interface StoryCharacterLook { id?: string; name?: string; refImage?: string }
export interface StoryCharacter { id: string; name: string; refImage?: string; appearance?: string; wardrobe?: string; looks?: StoryCharacterLook[]; [key: string]: unknown }
export interface StoryLocation { id: string; name: string; [key: string]: unknown }
export interface StoryBible {
  characters: StoryCharacter[]
  locations: StoryLocation[]
  props: Record<string, unknown>[]
  wardrobe: Record<string, unknown>[]
  style: Record<string, unknown>
  rules: Record<string, unknown>[]
}
export interface StoryGenerationRun {
  id: string
  projectId: string
  sceneId: string
  beatId: string
  kind: 'novel' | 'image' | 'video'
  model: { provider: string; id: string }
  capabilities: { reference: boolean; keyframe: boolean; seed: boolean }
  params: Record<string, unknown>
  seed?: number
  inputAssets: StoryAssetRef[]
  outputAssets: StoryAssetRef[]
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'degraded'
  degradation?: string[]
  parentRunId?: string
  // 段号/场景名在**生成时刻**定下来，跟着产物一起存；重排分镜也不会改写历史产物上的编号。
  // 旧数据没有这两个字段，界面回退到"按当前分镜顺序现算"。
  beatNo?: number
  sceneTitle?: string
  // 这一趟实际用了哪些原始引用（定妆照 / 挂载素材）。记的是原始地址，不是内联后的 base64。
  referenceImages?: string[]
  // 负向提示词（这一趟实际用的那份）。以前没有这个概念。
  negative?: string
  // 这一趟用的参考图策略（几张、谁优先、实际用了几张）——事后要能回答"为什么这张图没带定妆照"
  reference?: { images: number; prefer: string; used: number }
  // 异步生成的凭据：视频是"创建 + 收尾"两段式，靠任务号回来问一次；
  // queuedAt 用来算"已经等了多久"（超窗不算失败，只是不再自动等）。
  taskId?: string
  queuedAt?: string
  promptText?: string
  createdAt: string
  finishedAt?: string
}
// 「这次到底会做什么」的一步。预览与实跑共用同一个 plan，界面照它显示。
export interface StoryPlanStep { label: string; detail: string }
// 生成配方：把"调好的生成设置"变成一份可存/可套用/可导出导入的资产（对标 ComfyUI 的工作流）。
// 刻意**只存工艺、不存故事**：提示词/台词/素材属于故事，配方只管类型、模型、尺寸、负向、seed、变体数。
export interface StoryRecipe {
  id: string
  name: string
  kind: 'novel' | 'image' | 'video'
  model: { provider: string; id: string }
  params: Record<string, string>
  negative: string
  // 参考图策略：用几张、谁优先（画面默认 1 张素材优先；视频默认 4 张定妆照优先）
  reference: { images: number; prefer: 'material' | 'portrait' }
  seed: number | null
  variants: number
  note?: string
  createdAt: string
  updatedAt: string
}
// 挂在某一段上的素材：别的工作台（AI 绘画 / 视频工坊 / 小说工坊）的产出。
// 与 `references`（指向 bible 实体的 id）刻意分开：这类素材是**已经存在的成品文件**，自带地址。
export interface StoryBeatInput { id: string; type: 'image' | 'video' | 'text'; name?: string; url?: string; text?: string; path?: string }
// 剧本要素（Laper 的地基）：场景标题由 slug 三要素生成，动作与生成指令分开——
// `prompt` 是发给图像/视频模型的「动作、构图、镜头、光线」，把它整段当剧本动作，
// 会把"镜头怎么推"写进剧本，那不是剧作该写的东西。
export interface StorySceneSlug { interior?: 'interior' | 'exterior' | 'mixed'; location?: string; timeOfDay?: string }
export interface StoryPlaygroundTurn { role: 'writer' | 'character'; text: string; at?: string }
// 镜头规格（照同行那份有效提示词学来的八件事）：景别/机位/运镜/光线/色调/质感/落幅/承接。
// 它们不是剧本内容，是**发给视频模型的镜头语言**——由 story-shot-prompt.mjs 编译成提示词最前面那几句。
// 落幅尤其关键：一镜"最后定格在哪"不写，剪起来就是跳的。
export interface StoryShot {
  size?: string; angle?: string; move?: string; light?: string
  tone?: string; texture?: string; ending?: string; carry?: string
}
export interface StoryBeat { id: string; kind: 'novel' | 'image' | 'video'; prompt: string; references: StoryAssetRef[]; inheritFromBeatId?: string; activeRunId?: string; dialogue?: string; inputs?: StoryBeatInput[]; negative?: string; reference?: { images: number; prefer: string }; action?: string; transition?: string; playground?: StoryPlaygroundTurn[]; shot?: StoryShot; params?: Record<string, unknown>; chosenRunId?: string }
// 分集：短剧/系列内容的组织单位。场用 episodeId 归属；没归属的场进"未分集"，不会被强行塞进某一集。
export interface StoryEpisode { id: string; no: number; title: string; summary: string; targetSeconds?: number; createdAt?: string; stats?: { scenes: number; beats: number; withOutput: number; pending: number; failed: number; running: number } }
export interface StoryEpisodeGroup { episode: StoryEpisode | null; scenes: { id: string; title: string; beats: number }[] }
export interface StoryScene { id: string; index: number; title: string; summary: string; beats: StoryBeat[]; outputs: StoryGenerationRun[]; activeRunId?: string; slug?: StorySceneSlug; episodeId?: string }
export interface StoryFilm { id: string; url: string; clipCount: number; method: string; beatIds: string[]; picks?: { beatId: string; runId: string }[]; createdAt: string }
// 合成前的候选清单：同一段可能生成过好几版镜头，用户要能挑哪一版、要哪几段、什么顺序。
export interface StoryFilmCandidate { runId: string; status: string; seed: number | null; createdAt?: string; url: string; exists: boolean; external?: boolean; downloadable?: boolean; localable?: boolean; degradation?: string[]; chosen?: boolean;
  // 第几版：按这一段的**全部**版本（含失败的）从旧到新数，最新的号最大。
  // 编号由引擎给，前端不自己数——否则时间轴和「本段结果」会给同一个镜头两个号。
  versionNo?: number
  // 时长（秒）。只有带 durations=1 拉清单、且这一版已经落到本地时才探得到；
  // 外链没下载、ffprobe 也没有的，一律 null——界面据此如实写"时长未知"，不猜。
  durationSec?: number | null }
export interface StoryFilmBeat {
  beatId: string; sceneId: string; sceneTitle: string; beatNo: number
  kind: string; title: string
  candidates: StoryFilmCandidate[]
  usableCount: number
  externalCount?: number
  recommendedRunId: string
  chosenRunId?: string
  // 默认会进片子的那一版（recommendedRunId）多长；没有可用版本或探不到就是 null
  durationSec?: number | null
}
export interface StoryFilmPlan { beats: StoryFilmBeat[]; usable: number; total: number }
// 时间轴用的清单：filmPlan + 时长合计。合计算的是**默认成片**（每段用 recommendedRunId）；
// 用户换版本之后，界面按每一版自己的 durationSec 现算，不拿这个数当"当前成片时长"糊弄人。
export interface StoryTimelinePlan extends StoryFilmPlan {
  totalDurationSec?: number | null
  durationKnownBeats?: number
  durationUnknownBeats?: number
}
export interface StoryRunDeleteResult {
  project: StoryProject
  deletedRunId: string; kind: string; status: string
  files: { url: string; deleted: boolean; reason?: string }[]
  fileDeleted: number; fileKept: number; remaining: number
}
// 原著改编：一次「小说原文 → 分集大纲（集+场+段）」的留档。
// 存在的意义是刷新之后仍能回答两个问题：这个项目是从哪本小说、哪几章改出来的；上次改出了哪几集。
export interface StoryAdaptChapter { file: string; title: string; chars: number }
export interface StoryAdaptSource { kind: 'text' | 'novel' | 'empty'; bookId?: string; title?: string; chapters: StoryAdaptChapter[]; chars: number; usedChars?: number; truncated?: boolean }
export interface StoryAdaptRelation { from: string; to: string; note?: string }
export interface StoryAdaptation {
  id: string; at: string; source: StoryAdaptSource
  episodeIds: string[]; sceneIds: string[]
  episodeCount: number; sceneCount: number; beatCount: number
  logline?: string; relationships?: StoryAdaptRelation[]
  model?: { provider: string; id: string }
}
export interface StoryAdaptResult {
  preview?: boolean
  source: StoryAdaptSource
  episodeWish?: number
  secondsPerEpisode?: number
  note?: string
  project?: StoryProject
  episodeCount?: number; sceneCount?: number; beatCount?: number
  episodesCreated?: { id: string; no: number; title: string; summary?: string; sceneCount: number }[]
  episodeIds?: string[]
  overview?: { logline?: string; relationships?: StoryAdaptRelation[] }
  adaptations?: StoryAdaptation[]
  model?: { provider: string; id: string }
  requested?: number; attempts?: number; retried?: boolean
  firstEpisodeCount?: number
  incomplete?: string[]
  short?: boolean
  characters?: number
  characterNames?: string[]
}
// 创作方法包（Skill：程序性知识）。照 Lovart 的做法：封装的是"完成一个创作任务的整套方法"，
// 而不是一种视觉效果——配方管工艺参数，方法包管"该怎么拍"。
export interface StoryMethodStep { title?: string; detail?: string; text?: string }
export interface StoryMethod {
  id: string
  name: string
  goal: string
  source: 'builtin' | 'project' | 'user'
  targetSeconds: number
  scenesPerEpisode: number
  beatsPerScene: number
  reasoning: 'fast' | 'thinking'
  styleHint?: string
  reference?: { images: number; prefer: 'material' | 'portrait' }
  steps: StoryMethodStep[]
  rules: (string | StoryMethodStep)[]
  checklist: (string | StoryMethodStep)[]
  deliverables: (string | StoryMethodStep)[]
  createdAt?: string
}
// ── 台词与深度构思（用户："人物场景搭上了，对话和构思还是不行"）──
// 台词体检是**机检**（语速 3.5~5 字/秒、单句 >24 字要拆镜），不花模型钱；
// 台词诊断与深度构思是模型出的**草稿**，人在界面上逐条/整体确认后才写进项目。
export interface StorySpeechLine { text: string; chars: number; minSec: number; maxSec: number; pauses: number }
export interface StorySpeechIssue { code?: string; dim?: string; level: 'warn' | 'info'; text?: string; message: string; speaker?: string; chars?: number; budgetSec?: number }
export interface StorySpeechCheck { chars: number; lines: StorySpeechLine[]; minSec: number; maxSec: number; pauses: number; longest: StorySpeechLine | null; issues: StorySpeechIssue[]; level: string }
export interface StoryDialogueAudit {
  rows: { speaker: string; paren: string; text: string; chars: number }[]
  speakers: { speaker: string; lines: number; chars: number; longest: number }[]
  speech: StorySpeechCheck
  issues: StorySpeechIssue[]
  dims: string[]
  hitDims: string[]
  humanDims: string[]
  level: string
}
export interface StoryDialogueAuditResult {
  scenes: { sceneId: string; title: string; beats: { beatId: string; beatKind: string; budgetSec: number | null; audit: StoryDialogueAudit }[] }[]
  totals: { beats: number; chars: number; warn: number; info: number }
  notes: Record<string, string>
}
export interface StoryDialogueDoctorLine { speaker: string; original: string; rewritten: string; reasons: string[]; shots: { shot: string; text: string; chars: number }[]; thin: boolean }
export interface StoryDialogueDoctorResult {
  project?: StoryProject
  sceneId: string; sceneTitle: string
  audit: StoryDialogueAudit
  doctor: { summary: string; lines: StoryDialogueDoctorLine[]; keep: string[]; changed: number }
  model: { provider: string; id: string }
  retried?: boolean
}
export interface StoryCraftCharacter { name: string; slot: string; desire: string; secret: string; arc: string; voicePrint: string }
export interface StoryCraftUnit { no: number; spine: string; episodes: string; rounds: string; cap: number | null; seam: { ember: string; opponent: string; arc: string } }
export interface StoryCraftEngine {
  emotionContract: { line: string; neverDo: string[] }
  characters: StoryCraftCharacter[]
  units: StoryCraftUnit[]
  episodeMap: { no: number; goal: string; coldOpen: string; hook: string }[]
  beats: { no: number; event: string; link: string; changes: string[] }[]
  ledger: {
    setups: { text: string; setupAt: number | null; payoffAt: number | null; note: string }[]
    characters: { text: string; at: number | null }[]
    props: { text: string; at: number | null }[]
    rules: { text: string }[]
  }
}
export interface StoryCraftAudit { issues: { code: string; level: 'warn' | 'info'; message: string; name?: string; episode?: number; unit?: number; text?: string }[]; level: string }
// 流水线状态机（服务端下发）：界面不自己猜"哪些按钮该亮、为什么灰着"——
// 照 allowed/blocked 渲染，blocked 还带 reason_code + 人话。见 engine/story-flow.mjs。
export interface StoryFlowStep { id: string; label: string; hint: string; done: boolean }
export interface StoryFlowAction { action: string; label: string; panel: string; reason_code?: string; message?: string }
export interface StoryFlowProgress {
  beats: { total: number; done: number; failed: number; running: number }
  assets: { characters: number; portraits: number; locations: number; props: number; missingRefs: number }
  clips: { usable: number }
  films: number
  external: number
}
export interface StoryFlow {
  current_step: string
  steps: StoryFlowStep[]
  progress: StoryFlowProgress
  allowed_actions: StoryFlowAction[]
  blocked_actions: StoryFlowAction[]
  recommended_actions: string[]
  failed_recovery_actions: string[] | null
  headline: string
}
export interface StoryProject { id: string; title: string; logline?: string; bible: StoryBible; scenes: StoryScene[]; films?: StoryFilm[]; episodes?: StoryEpisode[]; adaptations?: StoryAdaptation[]; methodId?: string; craft?: StoryCraftEngine; activeSceneId?: string; defaultRecipeId?: string; createdAt: string; updatedAt: string; flow?: StoryFlow }

// 交付物（/api/ws/deliveries）条目
export interface AssetDelivery {
  name: string
  type: 'file' | 'dir'
  size: number
  url: string
  wsPath: string
  date?: string
  mtime?: string
  mtimeMs?: number
  openPath?: string
}

export type AssetKind = 'image' | 'video' | 'audio' | 'text' | 'presentation' | 'other'
export type AssetTimeRange = 'all' | 'today' | '7d' | '30d'

export interface AssetItem {
  id: string
  name: string
  path: string
  url: string
  size: number
  date: string
  mtimeMs: number
  kind: AssetKind
  source: 'artifact' | 'delivery'
  project: string
  isDirectory?: boolean
  openPath?: string
}

export interface AssetFilterQuery {
  kind?: AssetKind | 'all'
  source?: AssetItem['source'] | 'all'
  project?: string | 'all'
  timeRange?: AssetTimeRange
  search?: string
  now?: number
}

// 工具调用 5 态归一（AionUi normalizeToolCall 路线）——前端统一状态，不直接消费上游原始态
export type ToolStatus = 'pending' | 'running' | 'completed' | 'error' | 'canceled'

// 流式进行中的工具卡状态
export interface RunningTool {
  id: string
  name: string
  argsText: string
  output: string
  isError?: boolean
  running: boolean
  status?: ToolStatus
}

export interface SessionMessages {
  messages: ChatMessage[]
  leafId?: string | null
  truncated?: boolean
  total?: number
}

/** 技能库摘要：来源和用途由服务端根据安装位置及说明推导，前端只负责展示与筛选。 */
export interface SkillSummary {
  name: string
  description: string
  location: string
  path?: string
  source?: 'local' | 'online' | 'builtin'
  sourceLabel?: string
  category?: string
  categoryLabel?: string
  tags?: string[]
}

// SSE 事件（/api/sessions/:id/stream）
export interface SseEvent {
  type: string
  seq: number
  data: any
  ts: number
}
