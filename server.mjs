// 元枢 —— 个人智能系统 Web 服务（Codex 风格多会话）
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { execFile, execFileSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

// ── 输出质量守卫（Output Guard）：模型不可靠是默认假设（借鉴 dsh repeat-tool-reminder）──
import { bindOutputGuardDeps, classifyAnomaly, isRepeatReply, normReply, recordReply, sanitizeUndefined, lastAssistantReply } from "./engine/output-guard.mjs";
import { initOutputInspector, inspectOutput } from "./engine/output-inspector.mjs";
import { initModelProbe, probeModel, pickHealthyModel } from "./engine/model-health.mjs";
import { rateLimit, rateLimitKey } from "./engine/rate-limit.mjs";
import { createMiscApi } from "./engine/misc-api.mjs";
import { createModelKeys } from "./engine/model-keys.mjs";
import { createSessionBus } from "./engine/session-bus.mjs";
import { createModelSessionApi } from "./engine/model-session.mjs";
// ── Reasonix 机制（esengine/DeepSeek-Reasonix 借鉴）：工具结果压缩 / NEEDS_PRO 自报升级 / scavenge 捞回 ──
import { shrinkToolResult, NEEDS_PRO_RE, scavengeToolCalls } from "./engine/reasonix-tools.mjs";
import { initToolResultArchive } from "./engine/tool-result-archive.mjs";
import { initFileLock, usingSharedFileQueue } from "./engine/file-lock.mjs";
import { promptTimeText } from "./engine/yuanshu-seams.mjs";
import { readActivityRhythm } from "./engine/activity-rhythm.mjs";
import { settleTurnMemory } from "./engine/turn-memory.mjs";
// 连续失败计数（2026-09-16）：pi 通道的失败不抛异常，只落一条 stopReason=error 的记录；
// 没有状态码的失败（TypeError、协议不兼容）此前没人管，用户只看到"它不说话"。
import { noteModelFailure, clearModelFailures, modelFailureState } from "./engine/model-failures.mjs";
// 会话里 assistant 消息的落盘统一要"SDK 安全化"：image/audio/video 块会让 pi 通道重放历史时
// 抛 TypeError（estimate.js:42 把它们当工具调用读 block.name.length）。
// 2026-09-16 复查发现：出图兜底交付那条（下面 settledMedia 的 appendMessage）**绕过了**这道闸，
// 于是"这一轮出了图 → 切到 deepseek → 下一句就不回"——这才是残留的第二处来源。
import { sdkSafeAssistantBlocks, sdkSafeUserBlocks } from "./engine/yuanshu-session.mjs";
// @文件引用里的二进制文件不能内联（2026-09-16，外部机器安装检查第 4 个 bug）：见 engine/file-inline.mjs
import { isBinaryReference, binaryReferenceNote } from "./engine/file-inline.mjs";
import { advanceGoalTurn, noteGoalError, goalPrompt, listGoals, createGoal, armGoal, pauseGoal, settleGoal, disarmAllGoals } from "./engine/goals.mjs";
import { sandboxModeView, recordSandboxMode } from "./engine/sandbox-session.mjs";
import { sweepInterruptedRuns } from "./engine/story-store.mjs";
import { extractPromises, recordPromises, loadPromises, pendingPromises, closePromise, pendingPromiseText } from "./engine/promises.mjs";
import { createSoilReader } from "./engine/aibody-soil.mjs";
// ── 会话解析纯函数（拆模块）：消息/文本/图片/文件提取 ──
import { extractMessages, extractText, extractImages, extractFiles, resolveLeafId, windowMessages } from "./engine/session-utils.mjs";
import { initSessionFiles, scanSessionFiles, parseSessionFile, parseSessionFileCached, readEntriesFromFile, getSessionList, findSession, invalidateSessionCache, extractMessageFiles, extractMessageImages } from "./engine/session-files.mjs";
// ── 统一 HTTP 客户端（拆模块）：原生 fetch + 自动系统代理（env → Windows 注册表），替代 python 子进程 ──
import { httpJsonFetch, httpBufferFetch } from "./engine/http.mjs";
// ── 统一工具集（拆模块）：schema + 执行器；安全线（deny/危险命令/受保护路径/路径越权）在 engine/tools/security.mjs ──
import { BASE_TOOL_SCHEMAS, createUnifiedToolExecutorGuarded } from "./engine/tools/unified-tools.mjs";
import { safeJoin } from "./engine/tools/security.mjs";
// ── dsh 执行臂工具（拆模块）：双引擎派单/并发控制/结构化回传解析 ──
import { createDshTool } from "./engine/dsh-tool.mjs";
import { handleDshChat } from "./engine/dsh-chat.mjs";

// ── 模型路由层（拆模块）：429 降级 / 复杂度分类 / Auto 路由 / pro 候选 ──
import { initModelRouter, isOcGoBlocked, isModelBlocked, markModelBlocked, markOcGoBlocked, ocGoCandidate, pickFallbackDefault, pickFallbackExcluding, resetModelHealth, isAutoModel, routeForAuto, routeProCandidate, flashCandidate, markSticky, ROUTER_AUTO, isAuthErrorStatus } from "./engine/model-router.mjs";
// ── 模型能力探测与发现（拆模块）：能力推断 / 真实API探测(24h缓存) / 自定义 provider 发现 ──
import { modelCapabilities, probeModelCapabilities, discoverCustomModels } from "./engine/model-probe.mjs";
import { CONFIG } from "./config.mjs";
// ── Gateway 2.0 插件化引擎 + Code Mode（dsh 设计沉淀）──
import { createGateway } from "./engine/gateway.mjs";
import { sseWrite, createSseWriter, startSseHeartbeat } from "./engine/sse.mjs";
import { json, readBody } from "./engine/http-utils.mjs";
import { createRunStore } from "./engine/run-store.mjs";
import { createRunEventLog } from "./engine/run-event-log.mjs";
import { createRunManager } from "./engine/run-manager.mjs";
import { createRunEffects } from "./engine/run-effects.mjs";
import { createRunApi } from "./engine/run-api.mjs";
import { initThemePrefs, loadThemePrefs, saveThemePrefs } from "./engine/theme-prefs.mjs";
import { initColorPrefs, loadColorPrefs, saveColorPrefs } from "./engine/color-prefs.mjs";
import { initEnginePair, loadEnginePair, saveEnginePair, swapEnginePair, resolveLead, describePair, leadNote } from "./engine/engine-pair.mjs";
import { decorateEngineStatus, pluginFromBody, isCorePlugin } from "./engine/engine-panel.mjs";
import { initWorkspaceApi, WS_ROOT, findWorkspaceFiles, wsSafePath, saveArtifact, saveArtifactFromFile, handleWsTree, handleWsFile, handleWsRead, handleWsPreview, handleWsWrite, handleWsArtifacts, wsNextVersion, wsCopyDir, handleWsDeliver, handleWsPackage, handleWsDeliveries, handleWsRename, handleWsDelete, handleWsSearch, handleWsProjectCreate, handleWsConvert } from "./engine/workspace-api.mjs";
import { initContextLoader, makeLoader, loadExperience, readRulesWithImports, loadContextRules, jitRulesForPath, loadProjectRules, loadSkillIndex, execActivateSkill, ACTIVATE_SKILL_TOOL, WORK_PROTOCOL, loadMemory, loadMemoryIndex, loadExperienceIndex, shouldInjectFullMemory, setLastUserQuery } from "./engine/context-loader.mjs";
import { initMediaApi, findMediaModel, detectMediaIntents, extractMediaPrompt, mediaAwarePrompt, mediaReadyNotice, explainMediaError, generateMediaAsync, generateTTS, generateImage, handleImage, handleImageWithSave, generateVideo, startVideoJob, checkVideoJob, handleMedia, assistantContentWithMedia } from "./engine/media-api.mjs";
import { extractPlayableMedia } from "./engine/media-embed.mjs";
import { formatSkillIndexPrompt, matchSkillsForTask } from "./engine/yuanshu-protocol.mjs";
import { MEDIA_TOOL_SCHEMAS, mediaExtraExecutors, formatSensitiveHint, listHostChannels } from "./engine/media-channels.mjs";
import { TODO_TOOL_SCHEMAS, todoExtraExecutors } from "./engine/yuanshu-todo.mjs";
import { PLAN_FILES_SCHEMA, planFilesExtraExecutors, initYuanshuWorkmem } from "./engine/yuanshu-workmem.mjs";
import { DELEGATE_TASK_TOOL, execDelegateTask, DELEGATE_FORK_TOOL, execDelegateFork } from "./engine/yuanshu-delegate.mjs";
import { initAsrApi, handleAsr } from "./engine/asr-api.mjs";
import { gardenMemory, scanMemoryHealth, markReviewed, unmarkReviewed, dedupeLog, reviewedKeys, pruneLogBackups } from "./engine/memory-gardener.mjs";
import { upsertMemoryFact } from "./engine/memory-facts.mjs";
import { readSubscriptionText } from "./engine/subscription-reminder.mjs";
import { systemInfo as buildSystemInfo, loadNetworkConfig, saveNetworkConfig, checkUpdate } from "./engine/system-panel.mjs";
import { initTuiBridge } from "./engine/tui-bridge.mjs";
import { listLingXi, addLingXi, setLingXi, removeLingXi } from "./engine/lingxi.mjs";
import { initDshKeys, dshResolveBin, handleDshStatus, handleDshWebStart, handleKeysStatus, loadPolicies, toolMatch, policyDecide, handleKeysApply, handleKeysPresets, refreshModelList, handleModelsManage, handleModelsAdd, KNOWN_PROVIDERS, PROVIDER_PRESETS, resolveAuth } from "./engine/dsh-keys.mjs";
import { initStatsApi, handleGlobalStats, handleProviderStats, handleDailyStats, handleSubagentRuns, handleSubagentHistory, safeSessionStats, handleStats, handleCompact, listBuiltinSkills, handleSkills, handleSkillRead, handleParseFile, escHtml, handleExport, resolveFsPath, handleFsList, handleFsRead, handleRename } from "./engine/stats-api.mjs";
import { initModelClient, directChat, handleThink, handleDirectChat, maybeCompactHistory } from "./engine/model-client.mjs";
import { initSelfHeal, createRepairCheckpoint, handleUpdateCheck, handleUpdateApply, handleRepair, handleDesignerGenerate, handleDesignerSave, handleCompare } from "./engine/self-heal.mjs";
import { initImproveApi, analyzeImprovements, openImprovements, getImprovementDiagnostics, setImprovementStatus } from "./engine/improve-api.mjs";
import { initEvolutionApi, proposeEvolution, applyEvolution, listEvolution, dismissEvolution, nudgeSkill, applySkillNudge, dismissSkillNudge, listSkillNudges, evaluateProposal, proposeMemoryNudge, listMemoryNudges, applyMemoryNudge, dismissMemoryNudge, analyzeMemoryCompress, proposeMemoryCompress, listMemoryCompress, applyMemoryCompress, dismissMemoryCompress } from "./engine/evolution-api.mjs";
import { initSessionManager, createSession, evictInactiveSessions, slimSessionImages, compactSession, openSession, initSearchTool, initShareTool, createSessionAgent, ensureAgent, isFirstTurn, deleteSession, setOnTheSpotFixRunner, ensureContextHeadroom } from "./engine/session-manager.mjs";
import { initUnifiedChat, unifiedChat, engineCurrentModel, initEngine, getCodeRuntime, getCodeMode, toolBindingDesc, toolBindingArgs, toolBindingArgsObj, handleNotices, handleUnifiedChat, touchTask, clearTask, taskProgress, handleAgentEventIn, handleAgentEventOut } from "./engine/unified-chat.mjs";
import { createApprovalInterceptor } from "./engine/tools/approval.mjs";
import * as confirmRegistry from "./engine/tools/confirm-registry.mjs";
import { initRefineApi, readRefineJson, runRefineScript, handleRefineStatus, handleRefineList, detectSkillDomain, handleRefineFeedback, handleRefineGenes, handleRefinePlan, handleRefineApprove, handleRefineReject, handleRefineRollback } from "./engine/refine-api.mjs";
import { initMcpServer, handleMcp } from "./engine/mcp-server.mjs";
import { initMcpChat } from "./engine/mcp-chat.mjs";
import { initStoryTrace, handleStoryProjects, handleStoryProject, handleStoryProjectPatch, handleStoryProjectDelete, handleStoryRunPreview, handleStoryRun, handleStoryRunCheck, handleStoryRunCheckMany, handleStoryAssist, handleStoryPortrait, handleStoryAssetRef, handleStoryLint, handleStoryStoryboard, handleStoryAdapt, handleStoryFilm, handleStoryFilmPlan, handleStoryRunDelete, handleStoryRunLocalize, handleStoryLocalizeAll, handleStoryDialogueAudit, handleStoryDialogueDoctor, handleStoryEngine, handleStoryCraftSave, handleStoryCraftAudit, handleStoryEpisodeMapApply, handleStoryEpisodes, handleStoryEpisodeAdd, handleStoryEpisodeUpdate, handleStoryEpisodeRemove, handleStorySceneAssign, handleStoryScriptStats, handleStoryExportScript, handleStoryPlayground, handleStoryPlaygroundClear, handleStoryMethods, handleStoryMethodDelete, handleStoryMethodCapture, handleStoryMethodApply, handleStoryRecipes, handleStoryRecipesExport, handleStoryRecipesImport, handleStoryRecipeDelete } from "./engine/story-orchestrator.mjs";
import { startShare, stopShareSync, handleShare, handleShareStatus, handleShareStop } from "./engine/share-api.mjs";
import { createStaticServer } from "./lib/static.mjs";
import { CodeRuntime } from "./code-mode/code-runtime.mjs";
import { createCodeMode } from "./code-mode/code-mode.mjs";
import { createTimeEngine } from "./engine/time-engine.mjs";
import { composeTimeTaskMessages, timeTaskReadTools, recordReflectionActions, yesterdayYmd } from "./engine/time-task-run.mjs";
import { planReflectionExecution, buildActionExecutionPrompt, parseActionResult, recordActionAttempt, summarizeExecution, runOnTheSpotFix } from "./engine/reflection-exec.mjs";
import { appendEpisodes, loadEpisodes, dream, writeDreamLog, skillEpisodesFromSessions, dreamPaths, currentWeights, promoteWeights, resetWeights, recordSkillChoice } from "./engine/dream.mjs";
import { grant, revoke, loadCharter, autoUsedToday, loadLedger } from "./engine/autonomy.mjs";
import { listTraces, loadTrace, replayAcrossTraces, candidatePolicies, recordDelegation } from "./engine/trace.mjs";
import { heartbeat, liveInstances, portOwner, recordStartup, recentStartups, selfCheck, reconcileInstances } from "./engine/runtime-registry.mjs";
import { currentExplorePolicy, promoteExplorePolicy, resetExplorePolicy, replayExploreAcross } from "./engine/explore-policy.mjs";
import { verifyArtifacts } from "./engine/verifier.mjs";
import { MATCH_WEIGHTS } from "./engine/yuanshu-protocol.mjs";
import { sanitizeSessionFile } from "./engine/session-sanitize.mjs";
import { createCorsPolicy } from "./engine/cors-policy.mjs";
import { initSessionDb, handleDbList, handleDbRebuild, handleDbSanitize, handleDbMeta, handleDbStats, handleDbSweep, sweepSessionsNow, ensureSessionSequence } from "./engine/session-db.mjs";
import { repairSessionFile, repairSessionDir } from "./engine/session-repair.mjs";
import { outputRoomTokens, headroomNote } from "./engine/context-headroom.mjs";
import { loadPersonaDefinition, renderPersonaSection, syncAppendSystemPersona, personaFilePath } from "./engine/persona-def.mjs";
import { isListedGroup } from "./engine/session-groups.mjs";
import { createAIBodyRuntime } from "./engine/aibody-runtime.mjs";
import { createAIBodyHost } from "./engine/aibody-host.mjs";
import { initRecallApi, rebuildIndex, handleRecall, handleRecallAsk, handleSummaries, buildSummaries, recallStats } from "./engine/recall-api.mjs";
const memoryApi = await import("./engine/memory.mjs");
const { initMemorySync } = await import("./engine/memory-sync.mjs");
initMemorySync({ wsRoot: CONFIG.cwd }); // M1 路径外部化：记忆同步的工作空间根随配置注入
const emotion = await import("./engine/emotion.mjs");
emotion.init(CONFIG.cwd); // 基因系统：加载人格基因 + 提案池
emotion.setMemoryNudgeHook((info) => { try { proposeMemoryNudge(info); } catch {} }); // 情绪→记忆联动（09-03）：residue 跨阈值自动提案记忆写入
// 隔离子任务执行器（P2）：注入模型适配依赖（复用系统代理栈）
const subagent = await import("./engine/subagent.mjs");
const workshop = await import("./engine/workshop.mjs");
const { handleWorkshopUiChat } = await import("./engine/workshop-ui-chat.mjs");
const { handleExpandPrompt } = await import("./engine/workshop-prompt-expand.mjs");
const gallery = await import("./engine/gallery.mjs");
const distill = await import("./engine/distill-theme.mjs");
const { WORKSHOP_PAGES } = workshop;
const novelStudio = await import("./engine/workshop-novel.mjs");
const novelRun = await import("./engine/workshop-novel-run.mjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

// 时间引擎实例（启动时初始化；未初始化时相关 API 返回友好错误）
let timeEngine = null;

// ── 加载兼容适配器 SDK ─────────────────────────────────────────────
// piPackage 为空时 pathToFileURL("") 会解析成启动目录，报出
// "Directory import 'D:\pi-web' is not supported" 这种完全不指向真因的错误
// （2026-09-14 事故：NPM_CONFIG_PREFIX 缺失导致全局包探测全 miss，排查耗时很久）。
// 这里显式拦截，并给出可执行指引；错误信息里带 "Cannot find module" 特征串，
// 好让 watchdog 的回滚归因把它判为环境类崩溃而不是 server.mjs 的锅。
if (!CONFIG.piPackage) {
  console.error("[元枢] 未能解析兼容适配器引擎：Cannot find module '@earendil-works/pi-coding-agent'。");
  console.error("[元枢] 修复：npm i -g @earendil-works/pi-coding-agent ；或用 PI_PACKAGE 指定其 dist/index.js，然后重启。");
  process.exit(1);
}
const { createAgentSession, createAgentSessionServices, createAgentSessionFromServices, SettingsManager, ModelRuntime, SessionManager, DefaultResourceLoader, getAgentDir, withFileMutationQueue } = await import(
  pathToFileURL(CONFIG.piPackage).href
);
// ⚠️ initFileLock 必须放到 AGENT_DIR 声明之后（锁目录锚在 AGENT_DIR 上），
// 放在这里会 TDZ 崩：Cannot access 'AGENT_DIR' before initialization（2026-09-14 踩过）。

// ── 会话目录：复用本机 Agent 会话文件（~/.pi/agent/sessions/<encoded-cwd>/）──
function encodeCwdDir(cwd) {
  const r = path.resolve(cwd);
  const safe = r.replace(/^[\\/]/, "").replace(/[\\/:]/g, "-");
  return `--${safe}--`;
}
const SESSIONS_DIR = path.join(getAgentDir(), "sessions", encodeCwdDir(CONFIG.cwd));
initSessionFiles({ sessionsDir: SESSIONS_DIR, workspaceCwd: CONFIG.cwd }); // 会话文件层外部依赖注入
initWorkspaceApi({ wsRoot: path.resolve(CONFIG.cwd) }); // 工作空间根注入
initContextLoader({ cwd: CONFIG.cwd, DefaultResourceLoader }); // 上下文加载层注入
console.log(`[元枢] 会话目录: ${SESSIONS_DIR}`);

console.log("[元枢] 正在初始化模型运行时…");
// OpenCode Go：pi runtime 从环境变量 OPENCODE_API_KEY 读 key——必须在 ModelRuntime.create() 前注入
// （auth.json 在 AGENT_DIR 下，从文件读，不依赖启动 shell 环境）
try {
  if (!process.env.OPENCODE_API_KEY) {
    const authPath0 = require("node:path").join(getAgentDir(), "auth.json");
    const fs0 = require("node:fs");
    if (fs0.existsSync(authPath0)) {
      const auth0 = JSON.parse(fs0.readFileSync(authPath0, "utf8"));
      const ocKey = auth0["opencode-go"]?.key || auth0["opencode"]?.key;
      if (ocKey) process.env.OPENCODE_API_KEY = ocKey;
    }
  }
} catch {}
let modelRuntime = await ModelRuntime.create();
console.log(`[元枢] 模型运行时加载完成`);
// agent 通道扩展入口在 AUTH_PATH/MODELS_PATH 就绪后注册（见下），注册逻辑：engine/sdk-providers.mjs
// 诊断：确认 opencode-go provider 是否被 pi runtime 识别
try {
  const ogCount = modelRuntime.getModels().filter(m => m.provider === "opencode-go").length;
  console.log(`[元枢] opencode-go 模型数: ${ogCount}`);
} catch {}

// ── 模型列表（从 models-store.json 构建：白名单精选 + 用户后添加的 provider 全部显示）──
let modelList = [];
// 精选白名单：只保留真正常用的模型（一眼看完）
const KEEP_MODELS = new Set([
  // deepseek（默认）
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-pro",
  // openai 主流（去旧版/去 pro 高价版）
  "openai/gpt-5",
  "openai/gpt-5-mini",
  "openai/gpt-5.2",
  "openai/gpt-5.4",
  "openai/gpt-5.6-luna",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra",
  "openai/o3",
  "openai/o4-mini",
  // openrouter 各家族旗舰
  "openrouter/anthropic/claude-opus-5",
  "openrouter/anthropic/claude-sonnet-5",
  "openrouter/anthropic/claude-haiku-4.5",
  "openrouter/anthropic/claude-fable-5",
  "openrouter/google/gemini-3.6-flash",
  "openrouter/google/gemini-2.5-pro",
  "openrouter/google/gemma-3-27b-it",
  "openrouter/deepseek/deepseek-v4-pro",
  "openrouter/stealth/ox-alpha",
  "zai-coding-cn/glm-5.3-flash",
  "zai-coding-cn/glm-5.3",
  "zai-coding-cn/glm-4.7",
  "openrouter/deepseek/deepseek-r1",
  "openrouter/qwen/qwen3-max",
  "openrouter/qwen/qwen3.7-max",
  "openrouter/qwen/qwen3-coder-plus",
  "openrouter/x-ai/grok-4.5",
  "openrouter/moonshotai/kimi-k3",
  "openrouter/z-ai/glm-5.2",
  "openrouter/z-ai/glm-4.6",
  "openrouter/mistralai/mistral-large",
  "openrouter/meta-llama/llama-4-maverick",
  "openrouter/nvidia/nemotron-3-super-120b-a12b",
]);

// 兼容适配器原生 provider 表（agent 官方管线能直接跑通的通道）。外部中转/自定义通道
// （bigmodel/claude-relay/sensenova/volces-ark/whatstoken 等）不在表内，agent 路径会静默兑底，
// 必须走 unifiedChat 直连。此集合用于 /api/chat 通道策略判定（见 useAgent）。
const NATIVE_PROVIDERS = new Set([
  "deepseek", "openai", "openrouter", "anthropic", "google", "qwen", "xai", "moonshotai",
  "moonshotai-cn", "together", "mistral", "nvidia", "opencode-go", "opencode", "openai-codex",
  "zai", "zai-coding-cn", "xiaomi", "xiaomi-token-plan-cn", "xiaomi-token-plan-ams",
  "xiaomi-token-plan-sgp", "qwen-token-plan-cn", "qwen-token-plan-individual", "qwen-token-plan",
  "minimax", "minimax-cn", "kimi-coding", "github-copilot", "groq", "fireworks", "cerebras",
  "huggingface", "baseten", "amazon-bedrock", "google-vertex", "azure-openai-responses",
  "vercel-ai-gateway", "cloudflare-ai-gateway", "cloudflare-workers-ai", "cloudflare-auth",
  "cloudflare-stream", "radius", "radius-config", "ant-ling", "faux",
]);

let defaultModel = undefined; // 在启动模型列表构建后初始化（见下）
// ④ 会话级的"上一轮出过什么图、提示词是什么"（续画用；不落盘，重启即忘，够用且不污染会话文件）
const lastMediaBySession = new Map();
// ── 会话管理 ───────────────────────────────────────────────────────
const activeSessions = new Map();   // id -> { agent, sm, busy }
const skillCatalogSent = new Set(); // 已注入过「元枢内置技能库」目录的会话（每会话一次，别每轮灌一遍）
const pushedArtifacts = new Map();  // sessionId -> Set(已推送文件路径)，防止重复推"本轮产物"
let lastUnnamedId = null;           // 最近创建/复用的未命名会话（打断时复用同一会话）
let lastUnnamedEntry = null;

// 带中文偏好系统提示的资源加载器
// 输出质量守卫依赖注入（engine/output-guard.mjs 需要读会话文件做复读基准恢复）
try { bindOutputGuardDeps({ readEntriesFromFile, extractText }); } catch {}

// ── 模型管理（前端手动添加 API + 测试识别）────────────────────────
const AGENT_DIR = getAgentDir();
const AUTH_PATH = path.join(AGENT_DIR, "auth.json");
const MODELS_PATH = path.join(AGENT_DIR, "models-store.json");
// AIBody 是全系统运行协调层：它观察主任务、记忆、角色和子任务的真实事件，
// 不替代既有基因/情绪/记忆实现，也不把文件存在性当作运行证据。
const aibodyRuntime = createAIBodyRuntime({
  rootDir: path.join(AGENT_DIR, "yuanshu-aibody"),
  readState: createSoilReader({ agentDir: AGENT_DIR, cwd: CONFIG.cwd, emotion }),
});
const aibodyHost = createAIBodyHost(aibodyRuntime);
// 启用 agent 通道扩展注册（2026-08-27 补 compat/thinkingLevelMap 后启用）：把 store 里
// 「已配 key + SDK 不认识」的自定义通道（bigmodel/商汤/新雷等）注册进兼容适配器，
// 使 agent 会话（专项工作台/终端/TUI）与聊天同通道同凭据可用。
try {
  const { registerStoreProviders } = await import("./engine/sdk-providers.mjs");
  const reg = registerStoreProviders(modelRuntime, { storePath: MODELS_PATH, authPath: AUTH_PATH });
  if (reg?.length) console.log(`[sdk-providers] agent 通道已注册: ${reg.join(", ")}`);
} catch (e) { console.log(`[sdk-providers] 注册失败: ${String(e?.message || e).slice(0, 150)}`); }
initThemePrefs(path.join(AGENT_DIR, "theme-prefs.json")); // 主题偏好跨端同步
initColorPrefs(path.join(AGENT_DIR, "color-prefs.json")); // 全局创作配色卡：所有出图/出片入口共用一份
initEnginePair(path.join(AGENT_DIR, "engine-pair.json")); // 主次引擎对，下一条消息生效
initYuanshuWorkmem(path.join(AGENT_DIR, "yuanshu-work")); // 每会话 task_plan/findings/progress
initMediaApi({ resolveAuth, readJsonFile, modelsPath: MODELS_PATH, authPath: AUTH_PATH, getModelList: () => modelList }); // 媒体生成层注入
initAsrApi({ resolveAuth, readJsonFile, modelsPath: MODELS_PATH, httpJsonFetch }); // 语音转文字（mimo-v2.5-asr 免费通道）
initDshKeys({ dshWebPort: 3080, readJsonFile, writeJsonFile, authPath: AUTH_PATH, modelsPath: MODELS_PATH, ModelRuntime, refreshModelList, setModelList: (l) => { modelList = l; }, getDefaultModel: () => defaultModel, setDefaultModel: (m) => { defaultModel = m; }, setModelRuntime: (r) => { modelRuntime = r; }, getModelRuntime: () => modelRuntime, keepModels: KEEP_MODELS, resetModelHealth }); // dsh/keys/模型管理注入
initStatsApi({ getAgentDir, cwd: CONFIG.cwd, DefaultResourceLoader, openSession, ensureAgent, getDefaultModel: () => defaultModel, subagentHistoryProvider: (scope) => subagent.getSubagentHistory(scope) }); // 统计/技能/导出注入
initSessionDb({ agentDir: getAgentDir(), cwd: CONFIG.cwd, deleteSession }); // 会话数据库（编号/健康度/标签/空会话清扫）
initRecallApi({ agentDir: getAgentDir(), chat: unifiedChat, getDefaultModel: () => defaultModel }); // 跨会话回忆（09-04，Hermes FTS5 思想）
initModelClient({ readJsonFile, writeJsonFile, authPath: AUTH_PATH, modelsPath: MODELS_PATH, resolveAuth, getModelList: () => modelList, getDefaultModel: () => defaultModel, unifiedChat, detectMediaIntents, generateMediaAsync, extractMediaPrompt, readEntriesFromFile, createSseWriter }); // 直调模型客户端注入
initSelfHeal({ directChat, runGit: (...args) => runGit(...args), cwd: CONFIG.cwd, getModelList: () => modelList, getDefaultModel: () => defaultModel, piPackage: CONFIG.piPackage, SessionManager, sessionsDir: SESSIONS_DIR }); // 自愈/更新/设计器注入（REPAIR_BACKUP_FILES 已随块迁入模块）
initImproveApi({ root: CONFIG.cwd, statsProvider: null, healProvider: null }); // 自我改进提案（2026-08-21）
initEvolutionApi({ root: CONFIG.cwd, prompts: path.join(getAgentDir(), "prompts"), skills: path.join(__dirname, "skills"), chat: unifiedChat, getDefaultModel: () => defaultModel }); // 进化引擎（09-03，Hermes GEPA 思想：反思式进化+人工审批红线）
// 启动时构建模型列表：原生 provider（pi 内置目录）+ store 自定义，只显示配置过 Key 的
{
  const store = readJsonFile(MODELS_PATH);
  const authed = new Set(Object.keys(readJsonFile(AUTH_PATH)));
  const all = [];
  // 原生 provider（pi 内置目录，如 xiaomi-token-plan-cn）——不在 store 的
  try {
    for (const m of (modelRuntime.getModels?.() || [])) {
      if (!authed.has(m.provider) || store[m.provider]) continue;
      all.push({ provider: m.provider, id: m.id, name: m.name || m.id, api: m.api, baseUrl: m.baseUrl, reasoning: !!m.reasoning, contextWindow: m.contextWindow, input: m.input, compat: m.compat, thinkingLevelMap: m.thinkingLevelMap, capabilities: modelCapabilities(m.id) });
    }
  } catch {}
  // store 自定义 / 既有 provider
  for (const [provider, cfg] of Object.entries(store)) {
    if (!authed.has(provider)) continue;
    for (const m of (cfg.models || [])) {
      all.push({ provider, id: m.id, name: m.name || m.id, api: m.api, baseUrl: m.baseUrl, reasoning: !!m.reasoning, contextWindow: m.contextWindow, input: m.input, compat: m.compat, thinkingLevelMap: m.thinkingLevelMap, capabilities: { ...modelCapabilities(m.id), ...(m.capabilities || {}) } });
    }
  }
  modelList = all.filter(m => {
    if (["deepseek", "openai", "openrouter"].includes(m.provider)) return KEEP_MODELS.has(`${m.provider}/${m.id}`);
    return true;
  });
}
// 默认模型：优先 CONFIG.model，其次商汤 flash-lite（2026-08-20 千问下架后主力，免费实测可用），
// 再回退小米/火山等免费通道，最后第一个
if (CONFIG.model) {
  defaultModel = modelList.find(m => `${m.provider}/${m.id}` === CONFIG.model) || undefined;
}
if (!defaultModel) {
  // 用户定（2026-09-04）：Agnes 旗舰 agnes-2.5-pro 作为默认模型（付费套餐要用起来），
  // 降级链保留商汤/火山/智谱免费通道。
  defaultModel = modelList.find(m => m.provider === "agnes" && /2\.5-pro$/i.test(m.id))
    || modelList.find(m => m.provider === "sensenova" && /flash-lite/i.test(m.id))
    || modelList.find(m => m.provider === "volces-ark" && /ark-code/i.test(m.id))
    || modelList.find(m => m.provider === "zai-coding-cn" && /glm-5\.3-flash/i.test(m.id))
    || modelList.find(m => m.provider === "deepseek" && /v4-flash/i.test(m.id))
    || modelList[0];
}
console.log(`[元枢] 默认模型: ${defaultModel?.provider}/${defaultModel?.id}`);
console.log(`[元枢] 可用模型: ${modelList.length} 个（含 ${Object.keys(readJsonFile(MODELS_PATH)).join(", ")}）`);

// 模型路由层依赖注入（engine/model-router.mjs）：getter 动态读取，避免值拷贝 stale
initModelRouter({ getModelList: () => modelList, getDefaultModel: () => defaultModel, configModel: CONFIG.model });
// 2026-08-21 AI 检测员 + 模型通断探测（用户理念：复读引导修正/故障主动探测）
initOutputInspector({
  directChat: (m, msg, hist, opts) => directChat(m, msg, hist, opts),
  getInspectorModel: () => modelList.find((x) => x.provider === "sensenova" && /flash-lite/i.test(x.id)) || null,
});
initModelProbe({
  httpFetch: httpJsonFetch,
  authReader: () => { try { return JSON.parse(fs.readFileSync(AUTH_PATH, "utf8")); } catch { return {}; } },
  modelsReader: () => { try { return JSON.parse(fs.readFileSync(MODELS_PATH, "utf8")); } catch { return {}; } },
  getModelList: () => modelList,
});

// ══ Cursor Router 简化版（2026-08-17，对标 Cursor Router Auto / Windsurf Adaptive）══
// 理念：默认 Auto 路由——规则分类器按任务复杂度选模型：简单→flash（日常主力），复杂→pro（强推理，带上限）。
// 策略保守：flash vs pro 实测（2026-08-13）——pro 慢 2.4-7×、贵 3×、过度思考烧 token、偶发篡改数据，
// 所以 99% 的日常任务走 flash；只有明确复杂任务（长任务/多步骤/深度分析/代码库级）才升级 pro。
// 用户手动选择具体模型 → 不干预（与 Cursor "手动覆盖 Auto" 同构）。环境变量 PI_AUTO_ROUTE=0 可关闭。
// ⚠️ 实现已拆到 engine/model-router.mjs（2026-08-19）：
//   pro/flash 同源问题修正——千问只作 flash 主力，pro = ocGo deepseek-v4-pro → mimo-pro → ark；
//   ocGo 429 期间 pro 无可用 → 回落 flash 并播报真实原因（不假装升级）。

// ── 会话近期历史提取（2026-08-24 修复"失忆回复"）──
// 现象：复读守卫/降级重试走 directChat 时传空历史 → 替补模型只看到最后一句裸消息，
// 回出"您的消息不完整/我没有工具"这类失忆话术。修复：统一从会话树取最近 N 轮真实历史。
function recentHistory(entry, limit = 10, maxChars = 1600) {
  try {
    const roots = entry?.sm?.getTree?.() || [];
    const msgs = [];
    for (const n of roots) {
      const m = n?.entry?.message;
      if (!m || !["user", "assistant"].includes(m.role)) continue;
      const t = extractText(m).trim();
      if (!t) continue;
      msgs.push({ role: m.role, content: t.length > maxChars ? t.slice(0, maxChars) + "…[截断]" : t });
    }
    return msgs.slice(-limit);
  } catch { return []; }
}

// ══ 复读检测与降级重试（2026-08-19 加固）══
// 判定逻辑已迁移到 engine/output-guard.mjs（输出质量守卫，纯判定模块）：
//   复读/空回复/纯思考 统一 classifyAnomaly；这里只保留"重试执行"（换 fallback 模型直调 + 播报）。
async function retryRepeatWithFallback(message, sessionKey, writer, busEmit, currentModel, inspectorSuggestion = "", history = [], entry = null) {
  // 2026-08-21 用户理念：复读是行为跑偏 → 植入修正话语引导方向（同模型重生成），不终止不换模型；
  // 只有真正的模型链接/资源问题（429/400/403）才主动告知用户原因并切换可用模型。
  const note = "⚠️ 检测到回复与上一条完全相同，正在引导模型修正表达…";
  try { writer.push("note", { text: note }); if (busEmit) busEmit("note", { text: note }); } catch {}
  // 修正提示：同模型重生成，明确要求换表达/推进（不终止会话、不换模型）
  const hint = inspectorSuggestion
    ? `AI 质检员发现你的上一条回复异常（${inspectorSuggestion}）。请重新回答这条用户消息，按此指引修正。`
    : "你刚才的回复与上一条完全相同（复读）。请重新回答这条消息：换一种表达、补充更多内容、或继续推进对话，绝不能重复上一条回复。";
  const corrected = await directChat(currentModel, message, history, { systemHint: hint });
  if (corrected?.text) {
    const add = `

（复读修正后的新回复）
${corrected.text}`;
    try { writer.push("delta", { text: add }); if (busEmit) busEmit("delta", { text: add }); } catch {}
    // 让用户看得见"这段是重写来的"（2026-09-16）：以前只在正文里塞一行小字，气泡上的模型角标还是原模型
    try { writer.push("model_switched", { provider: currentModel?.provider || "", id: currentModel?.id || "", sameModel: true, reason: "复读判定成立，同模型重写了一遍" }); } catch {}
    recordReply(sessionKey, corrected.text);
    // #229 修复：修正文本此前不落盘，会话历史里仍是旧异常回复，下轮模型看着旧回复继续复读
    // 2026-09-16 补：落盘时**带上"这是重写来的"标记**——只推前端不落盘的话，刷新/换设备就变回"静默"了。
    try { entry?.sm?.appendMessage({ role: "assistant", content: [{ type: "text", text: `（复读修正后的新回复）\n${corrected.text}` }] }); } catch {}
    console.log(`[元枢] 复读引导修正成功（同模型 ${currentModel?.provider}/${currentModel?.id}）`);
    return corrected.text;
  }
  // 同模型修正失败 → 才切可用模型（真正的异常才换）
  const fbModel = pickFallbackExcluding(currentModel);
  if (fbModel) {
    const note2 = `⚠️ 同模型修正仍失败，已切换 ${fbModel.provider}/${fbModel.id} 重新生成…`;
    try { writer.push("note", { text: note2 }); if (busEmit) busEmit("note", { text: note2 }); } catch {}
    const fb = await directChat(fbModel, message, history);
    if (fb?.text) {
      // #229 修复：换模型分支此前只 recordReply 不推前端，用户看到的仍是旧异常回复；同样落盘修正文本
      const add = `\n\n（已切换 ${fbModel.provider}/${fbModel.id} 重新生成的回复）\n${fb.text}`;
      try { writer.push("delta", { text: add }); if (busEmit) busEmit("delta", { text: add }); } catch {}
      // 静默换模型是用户最直接的"乱做"体感（他原话："静默换成 agnes 3.0"）——现在显式推一条事件，
      // 界面会在气泡上标出「兜底 <模型>（你选的是 X）」
      try { writer.push("model_switched", { provider: fbModel.provider, id: fbModel.id, sameModel: false, reason: "复读判断成立且同模型修正失败，已换模型重生成" }); } catch {}
      recordReply(sessionKey, fb.text);
      // 同上：落盘也要带标记，刷新后仍然看得到"这段是兜底模型写的"（用户原话："静默换成 agnes 3.0"）
      try { entry?.sm?.appendMessage({ role: "assistant", content: [{ type: "text", text: `（已切换 ${fbModel.provider}/${fbModel.id} 重新生成的回复）\n${fb.text}` }] }); } catch {}
      return fb.text;
    }
  }
  try { writer.push("note", { text: "⚠️ 复读修正失败且备用模型无回复（请重试或手动切换模型）" }); } catch {}
  return null;
}

// ══ 会话级模型选择持久化（2026-08-19 修复 A）════
// 现象：模型切换只存内存 entry.modelKey，会话 LRU 淘汰/服务重启后丢失 → 悄悄回 Auto → 429 场景下持续报错。
// Plan 模式只读工具集（工具级硬限制）：读文件 + 搜索，不给写/执行工具
const PLAN_READONLY_SET = ["read", "search_files"];

function readJsonFile(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; } }
function writeJsonFile(p, obj) { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8"); return true; } catch { return false; } }
const CRLF = "\r\n";

// ── 模块化拆分接线（2026-08-29 #7 红线治理）：workspace杂项API / model-keys / session-bus / model-session ──
const modelKeysApi = createModelKeys({ readJsonFile, getAgentDir, getModelList: () => modelList });
const { saveSessionModelKey, loadSessionModelKey, saveLastModel } = modelKeysApi;
const miscApi = createMiscApi({ json, readJsonFile, writeJsonFile, getAgentDir, authPath: AUTH_PATH, modelsPath: MODELS_PATH, openSession, ensureAgent, getDefaultModel: () => defaultModel, refreshModelList, scanSessionFiles, extractText, parseSessionFile, cwd: CONFIG.cwd, gitCwd: __dirname, scanExclude: /(^|[\\/])(node_modules|\.git|\.cache|backups?|temp|tmp|\.token)([\\/]|$)/i });
const { scanRecentArtifacts, handlePrompts, handleSessionTree, handleSessionBranch, handleModelsRemove, handleSearch, handleAIBody, runGit, handleGitStatus, handleGitDiff, handleGitReview } = miscApi;
const sessionBusApi = createSessionBus({ json });
const { busGet, busPush, handleSessionStream } = sessionBusApi;
const { handleModels, handleSwitchModel } = createModelSessionApi({ json, readJsonFile, resolveAuth, modelCapabilities, modelsPath: MODELS_PATH, getModelList: () => modelList, getDefaultModel: () => defaultModel, getModelRuntime: () => modelRuntime, getConfig: () => CONFIG, activeSessions, createSessionAgent, saveLastModel, saveSessionModelKey });

// ── 隔离子任务执行器初始化（P2）──
// 复用系统代理栈 + 模型配置；flash 候选走千问（成本优先，子任务不值得 pro）
try {
  subagent.initSubagent({
    httpFetch: httpJsonFetch,
    authReader: () => readJsonFile(AUTH_PATH),
    modelReader: () => readJsonFile(MODELS_PATH),
    resolveAuth,
    getDefaultModel: () => defaultModel,
    getFlashModel: () => modelList.find(m => m.provider === "sensenova" && /flash-lite/i.test(m.id))
      || modelList.find(m => m.provider === "xiaomi-token-plan-cn" && /mimo-v2\.5$/i.test(m.id))
      || defaultModel,
    traceDir: path.join(AGENT_DIR, "yuanshu-subagents"),
  });
} catch (e) { console.log("[元枢] subagent 初始化失败: " + String(e?.message || e).slice(0, 80)); }
// P3 资产路由：技能库摘要索引注入（任务→技能自动匹配）
try { emotion.bindSkillIndex(() => loadSkillIndex()); } catch {}

// 模型能力档案：根据 id 推断（chat 默认 + image/video/tts/asr 标记）
// 找到已配置的媒体能力模型（查档案，不靠正则猜）

// POST /api/models/remove {provider}
// 内置 provider（走兼容 agent）；其余自定义 provider 走直调通道
// GET /api/prompts —— 提示词模板列表（本机 Agent prompts 目录）
// ── 鉴权 ───────────────────────────────────────────────────────────
function checkAuth(req) {
  const h = req.headers.authorization || "";
  if (h === `Bearer ${CONFIG.token}`) return true;
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  return url.searchParams.get("token") === CONFIG.token;
}

// ── 路由 ───────────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".json": "application/json",
};

const staticServer = createStaticServer({ publicDir: PUBLIC_DIR, mime: MIME });
// ══ UI 入口：React 版为默认，vanilla 通过 ?vanilla=1 保留为兼容入口 ══
// React 构建源为 frontend/dist；dist 缺失时自动回落 public，保证新 clone 尚未构建时仍可启动。
const REACT_DIST = path.join(__dirname, "frontend", "dist");
const reactStatic = (() => {
  try { return fs.existsSync(path.join(REACT_DIST, "index.html")) ? createStaticServer({ publicDir: REACT_DIST, mime: MIME }) : null; }
  catch { return null; }
})();
// 旧 sw.js 注销器：React 版不用 service worker；老用户浏览器里残留的 sw 会用旧缓存劫持新界面，
// 用一个自毁 sw 覆盖注册位：清空全部 Cache + 注销自己。
const SW_UNREGISTER = "self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.map(k=>caches.delete(k)))).then(()=>self.registration.unregister()))});";

async function handleStatic(req, res) {
  return staticServer.handle(req, res);
}

// POST /api/chat —— SSE 流式
// ══ 工作空间：产物落盘 + 文件服务 ══
// ══ 统一模型接入层：所有模型一视同仁（对话 + 工具循环 + 思考提取）══
// 基础工具 schema（bash/read/write/edit/web_search）已抽到 engine/tools/unified-tools.mjs；
// 此处组合 server 特有的工具（技能激活 + 外部思考）
// ══ 当场修（fix_problem，2026-09-17）══
// 用户的原话："任务中的自我反思，是抓了一堆问题，但是没有主动执行能力了"。
// 复盘那条链是"事后"的（定时任务到点才跑）；这个工具把同一套规则搬到**任务过程中**：
// agent 干活时发现当场能修的问题，调一次，就派一个执行轮真去修，拿到证据回到它手里。
// 边界与复盘那条完全一致：红线不碰、每会话 10 分钟最多 3 次、必须交证据、做不了就说做不了。
// 声明必须在 UNIFIED_TOOLS **之前**：那个数组是模块求值时立刻构造的，写反了就是
// `Cannot access 'FIX_PROBLEM_TOOL' before initialization`（进程根本起不来，我已经踩过一次，
// 现在由 tests/unit/module-scope-order.test.mjs 盯着）。
const FIX_PROBLEM_TOOL = {
  type: "function",
  function: {
    name: "fix_problem",
    description: "干活时发现一个当场能修的问题（代码/测试/配置/文档/脚本的小毛病），用这个工具当场派一轮去修，并拿到证据。不要用它做需要人拍板的事（权限/密钥/部署/推送/删数据/花钱）——那些写进结论交给用户。同一个会话 10 分钟内最多 3 次。",
    parameters: {
      type: "object",
      properties: { problem: { type: "string", description: "要修什么，一句话，具体到可核查（≤60 字）" } },
      required: ["problem"],
    },
  },
};
const UNIFIED_TOOLS = [
  ...BASE_TOOL_SCHEMAS,
  ...MEDIA_TOOL_SCHEMAS,
  ...TODO_TOOL_SCHEMAS,
  PLAN_FILES_SCHEMA,
  ACTIVATE_SKILL_TOOL,
  DELEGATE_TASK_TOOL,
  DELEGATE_FORK_TOOL,
  FIX_PROBLEM_TOOL,
];
// ══ 外部思考工具（externalThinking 调试开关，默认关）══
// 思路：关闭模型原生隐藏思考后，给它一张外部"草稿纸"（think 工具），
// 模型会把分析过程写进工具参数返回给开发者——用于调试"模型为什么这么干"。
// 安全：think 内容只在内存/SSE 流中传向前端展示，不落盘、不进会话文件。
const THINK_TOOL = { type: "function", function: { name: "think", description: "（调试用）动手之前，先把你的分析、推理、计划写在 content 里。这段内容仅供开发者调试查看，不会展示给用户。", parameters: { type: "object", properties: { content: { type: "string", description: "你的思考草稿（推理过程/计划/待办检查）" } }, required: ["content"] } } };
const THINK_PROMPT = "你可以调用 think 工具，在动手之前写下你的分析过程（理解、步骤、计划、可能的坑）。写完后再执行任务。think 的内容仅供调试，不展示给用户，可以放心写。";
const isExternalThinking = () => !!(CONFIG.externalThinking || globalThis.__yuanshuExternalThinking || globalThis.__piWebExternalThinking);

// 统一工具执行器：实现已抽到 engine/tools/unified-tools.mjs（大脑可移植第一步）。
// server 侧注入：工作目录 / 工作空间路径安全 / 技能激活 / 时间引擎。
const executeUnifiedTool = createUnifiedToolExecutorGuarded({
  cwd: () => CONFIG.cwd,
  systemDir: __dirname, // 双根白名单：系统本体目录（自进化可写）
  safePath: wsSafePath,
  activateSkill: (name) => {
      // 在线记一条技能选择 episode：做梦/授权状全靠这个喂数据，不然机制建好了也永远没证据。
      // 输入 = 该会话最后一条用户消息；真值 = 这次真的激活了哪个技能。
      try {
        const sid = globalThis.__yuanshuLastSessionKey || "";
        const msg = lastUserBySession.get(sid) || "";
        if (msg) recordSkillChoice(WS_ROOT, { input: msg, skill: name });
      } catch {}
      return execActivateSkill(name);
    },
  timeEngine: () => timeEngine,
  sensitiveHint: () => formatSensitiveHint(listHostChannels({ getModelList: () => modelList })),
  // 外部自定义工具执行器：dsh_task（pi 格式 execute → unified 结果格式）+ 宿主媒体密文通道
  extraExecutors: {
    dsh_task: async (args, ctx) => {
      const t = globalThis.__yuanshuDshTool || globalThis.__piWebDshTool;
      if (!t?.execute) return { text: "[dsh] 执行臂未初始化", isError: true };
      const r = await t.execute("unified-" + Date.now(), args || {}, ctx?.signal);
      const text = (r?.content || []).map((c) => c.text || "").join("\n").trim();
      return { text: text || "（dsh 无输出）", isError: !!r?.isError };
    },
    ...mediaExtraExecutors({ getModelList: () => modelList, generateMediaAsync }),
    ...todoExtraExecutors(),
    ...planFilesExtraExecutors(),
    // 派活 = 元枢里真正的"多路探索"：一次派几个子任务、哪个失败、花了多久。
    // 记成轨迹节点后，"该怎么探索"才有可回放的对象（当场修那条是单线的）。
    delegate_task: async (args, ctx) => {
      const t0 = Date.now();
      const r = await execDelegateTask(args, ctx);
      try {
        const text = typeof r === "string" ? r : (r?.text || "");
        recordDelegation(WS_ROOT, { kind: "delegate_task", task: args?.task || args?.prompt || "", durationMs: Date.now() - t0, ok: !r?.isError, digest: text });
      } catch {}
      return r;
    },
    delegate_fork: async (args, ctx) => {
      const t0 = Date.now();
      const r = await execDelegateFork(args, ctx);
      try {
        const text = typeof r === "string" ? r : (r?.text || "");
        recordDelegation(WS_ROOT, { kind: "delegate_fork", task: args?.task || args?.prompt || "", durationMs: Date.now() - t0, ok: !r?.isError, digest: text });
      } catch {}
      return r;
    },
    // 当场修：把"发现问题"接到"动手做掉"（逻辑在 engine/reflection-exec.mjs，与复盘那条共用规则）。
    // 执行轮用完整工具集（这一步才发可写工具），一轮只做这一条，必须交证据。
    fix_problem: async (args, ctx) => {
      const out = await runOnTheSpotFix({
        problem: args?.problem,
        sessionKey: ctx?.sessionKey || ctx?.sessionId || "anon",
        runTurn: async (prompt) => {
          const r = await unifiedChat(defaultModel, [{ role: "user", content: prompt }], { tools: UNIFIED_TOOLS });
          return r?.text || r?.content || "";
        },
      });
      return { text: out.text, isError: !out.ok };
    },
  },
});

initSessionManager({ cwd: CONFIG.cwd, sessionsDir: SESSIONS_DIR, tools: CONFIG.tools, piPackage: CONFIG.piPackage, isModelBlocked, createAgentSessionServices, createAgentSessionFromServices, getModelRuntime: () => modelRuntime, loadSessionModelKey, getModelList: () => modelList, getDefaultModel: () => defaultModel, activeSessions, SessionManager, SettingsManager, DefaultResourceLoader, getAgentDir, readJsonFile, writeJsonFile, isExternalThinking, THINK_TOOL, modelCapabilities, bindOutputGuardDeps, extractMessages, createSseWriter, unifiedChat, generateMediaAsync, onSessionCreated: ensureSessionSequence, repairSessionFile }); // 会话管理注入
// 当场修的执行器：Pi 会话里的 fix_problem 与统一引擎里的同名工具走**同一套规则**
// （engine/reflection-exec.mjs：红线不碰 / 每会话 10 分钟最多 3 次 / 必须交证据）。
setOnTheSpotFixRunner(({ problem, sessionKey }) => runOnTheSpotFix({
  problem,
  sessionKey,
  runTurn: async (prompt) => {
    const r = await unifiedChat(defaultModel, [{ role: "user", content: prompt }], { tools: UNIFIED_TOOLS });
    return r?.text || r?.content || "";
  },
}));
initUnifiedChat({
  executeUnifiedTool, findKeyByEntry, readJsonFile,
  getModelList: () => modelList, getDefaultModel: () => defaultModel,
  authPath: AUTH_PATH, modelsPath: MODELS_PATH, cwd: CONFIG.cwd, sessionDir: SESSIONS_DIR,
  piPackage: CONFIG.piPackage, UNIFIED_TOOLS, getAgentDir, THINK_TOOL,
  // 元枢沙箱升级与 pi 共用同一人工确认注册表；没有前端应答时由注册表超时并 fail-closed。
  createSandboxAsk: ({ writer, sessionId, taskId }) => async (toolName, args, reason) => {
    const sid = sessionId || taskId || "new";
    const reg = confirmRegistry.register(sid, { toolName, reason, src: "sandbox" });
    writer.push("confirm", { id: reg.id, toolName, reason, args: args || {}, sessionId: sid });
    return reg.promise;
  },
}); // 统一对话通道注入
initRefineApi({ cwd: CONFIG.cwd }); // 经验沉淀台注入
initMcpServer({ modelRouter: (await import("./engine/model-router.mjs")), memoryApi: memoryApi, emotion, getDefaultModel: () => defaultModel, wsRoot: () => CONFIG.cwd, json }); // MCP 认知层注入
initMcpChat({ handleChat }); // MCP 对话注入


// ── 双引擎：dsh（DeepSeek Harness）执行臂工具 —— 实现已抽到 engine/dsh-tool.mjs ──
// 模式：pi 主引擎（规划/对话/验收）→ 派单 dsh 执行（代码/沙箱/工作流）→ 结果回 pi 验收交付。
const { initDshTool } = createDshTool({
  cwd: CONFIG.cwd,
  piPackage: CONFIG.piPackage,
  loadSkillIndex,
  skillsDir: path.join(__dirname, "skills"),
});
// 2026-08-21 注入 dsh 执行臂到统一工具集（此前只初始化未注入——双引擎名存实亡）
// 全局引用：unified 兜底路径执行 dsh_task 用（2026-08-22）。也写旧键名，避免外部集成还在读它。
globalThis.__yuanshuDshTool = null;
globalThis.__piWebDshTool = null;
try {
  const dshTool = await initDshTool();
  globalThis.__yuanshuDshTool = dshTool;
  globalThis.__piWebDshTool = dshTool;
  if (dshTool && !UNIFIED_TOOLS.some((t) => t?.name === dshTool.name || t?.function?.name === dshTool.name)) {
    // ⚠️ 2026-08-22 修复 400 "`function` is not set"：dsh_tool 返回 pi 自定义工具格式（扁平 name/description），
    // UNIFIED_TOOLS 是 OpenAI 格式（{type,function}）——原样 push 导致上游解析 tools[i].function=undefined 必 400，
    // 且只要降级到 unifiedChat 兜底就稳定复现（所有模型、所有触发工具的消息）。
    const openaiDef = dshTool.function ? dshTool : {
      type: "function",
      function: {
        name: dshTool.name,
        description: dshTool.description || "",
        parameters: dshTool.parameters || { type: "object", properties: {} },
      },
    };
    UNIFIED_TOOLS.push(openaiDef);
    console.log(`[dsh] 执行臂已注入统一工具集（${dshTool.name}，OpenAI 格式已转换，并发上限 ${process.env.PI_DSH_MAX || 6}）`);
  }
} catch (e) {
  console.log(`[dsh] 工具注入失败: ${String(e?.message || e).slice(0, 80)}`);
}

// ══ Reasonix 三大机制落地（2026-08-19，esengine/DeepSeek-Reasonix 借鉴）══
// 实现已抽到 engine/reasonix-tools.mjs（纯逻辑模块）：
//   ① shrinkToolResult 工具结果压缩（P3） ② NEEDS_PRO_RE 自报升级（P3） ③ scavengeToolCalls 捞回（P2）

// ══ 记忆结算：引擎无关，实现见 engine/turn-memory.mjs ══
// 它必须在**所有**产生助手回复的引擎路径上跑。原先这段代码只写在下面 Pi 分支的
// try 里，而 Pi 分支位于 early-return 之后 → yuanshu(unified) 与 dsh 静默不写记忆，
// Pi 失败降级时也被跳过；而引擎目录声明的恰恰相反。现在由两个分支的 finally 各调一次。

// 统一对话循环：openai 兼容 API → tool_calls 循环 → 思考提取
// 本轮上游到底失败没有？pi 通道的失败**不抛异常**：它落成一条
// { role:"assistant", content:[], stopReason:"error", errorMessage } 的记录。
//
// ⚠️ 必须**先看 SDK 的内存树**再看文件：失败记录是这一轮结束才落盘的，
// 只读文件会读到上一轮的旧消息（第一版就是这么漏判的，于是又走了无历史兜底）。
function lastTurnUpstreamError(entry) {
  const pick = (m) => (m && m.role === "assistant" && m.stopReason === "error")
    ? { errorMessage: String(m.errorMessage || m.error || "未给出原因"), model: m.model || "", provider: m.provider || "" }
    : null;
  try {
    const roots = entry?.sm?.getTree?.();
    if (Array.isArray(roots) && roots.length) {
      const flat = [];
      const walk = (node) => {
        if (!node) return;
        if (node.entry) flat.push(node.entry);
        const kids = node.children instanceof Map ? [...node.children.values()] : node.children;
        if (Array.isArray(kids)) for (const c of kids) walk(c);
      };
      for (const r of roots) walk(r);
      for (let i = flat.length - 1; i >= 0; i--) {
        const m = flat[i]?.message;
        if (!m || m.role !== "assistant") continue;
        return pick(m);   // 最近一条 assistant：报错就报错，没报错就是本轮正常
      }
    }
  } catch {}
  try {
    const sf = entry?.sm?.getSessionFile?.() || entry?.sm?.sessionFile;
    if (!sf || !fs.existsSync(sf)) return null;
    const entries = parseSessionFile(sf) || [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const m = entries[i]?.message;
      if (!m || m.role !== "assistant") continue;
      return pick(m);
    }
  } catch {}
  return null;
}

async function handleChat(req, res, body) {
  let message = typeof body.message === "string" ? body.message.trim() : "";
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : null;
  // 限速（2026-08-29）：公网暴露下防脚本刷模型接口烧钱，30 次/分钟 per token+IP
  if (!rateLimit(rateLimitKey(req, "chat"), 30, 60000)) {
    return json(res, 429, { error: "请求过于频繁（30次/分钟），请稍后再试" });
  }
  // 外部思考调试开关：请求级 body.think=true 或全局 CONFIG.externalThinking
  const thinkOn = body.think === true || isExternalThinking();
  // 记录对话开始时会话行数（基线）：交付时只提取本轮新增的文件，避免历史文件重复推
  let chatBaseline = 0;
  console.log(`[chat] msg="${message.slice(0, 20)}" sid=${sessionId} model=${defaultModel?.provider}/${defaultModel?.id} agent=${body.model || ""}`);
  if (!message) return json(res, 400, { error: "消息不能为空" });

  // @ 文件引用：把文件内容拼入消息上下文
  if (Array.isArray(body.files) && body.files.length) {
    const parts = [];
    for (const f of body.files.slice(0, 20)) {
      if (!f?.path || typeof f.content !== "string") continue;
      // 二进制文件不内联（2026-09-16，外部机器安装检查的第 4 个 bug）：
      // xlsx/docx/pdf/zip/图片的字节拼进 prompt 就是一堆乱码——费 token、污染对话，
      // 模型还会照着乱码猜内容。换成一条"按路径解析"的提示（/api/parse-file 支持 docx/xlsx/pptx）。
      if (isBinaryReference(f)) {
        console.log(`[chat] 跳过二进制参考文件内联: ${f.path}`);
        parts.push(binaryReferenceNote(f.path));
        continue;
      }
      if (f.content.length > 150000) f.content = f.content.slice(0, 150000) + "\n…[已截断]";
      parts.push(`参考文件 ${f.path}：\n\`\`\`\n${f.content}\n\`\`\``);
    }
    if (parts.length) message = message + "\n\n" + parts.join("\n\n");
  }

  // 图片附件：转给模型的 images 参数
  let images = [];
  if (Array.isArray(body.images) && body.images.length) {
    images = body.images
      .slice(0, 3)
      .filter(i => i?.data && i?.mimeType && i.data.length < 3 * 1024 * 1024)
      .map(i => ({ type: "image", data: i.data, mimeType: i.mimeType }));
  }

  let entry;
  if (sessionId) {
    entry = await openSession(sessionId);
    if (!entry) return json(res, 404, { error: "会话不存在" });
  } else {
    // 未命名会话：body.fresh=true 表示用户点了「新建会话」→ 新建；否则复用上一个（打断续发同一会话）
    // 测试标记（2026-08-29）：x-pi-test 头 → 总是新建独立会话（不复用 lastUnnamed，防污染用户对话流），名字加 [真测] 前缀归入真测分组
    const isTest = String(req.headers?.["x-pi-test"] || "") === "1";
    if (isTest || body.fresh || !lastUnnamedEntry || activeSessions.get(lastUnnamedId) !== lastUnnamedEntry) {
      const id = await createSession(isTest ? `[真测] ${message.slice(0, 30) || "API测试"}` : undefined, { group: isTest ? "test" : "workspace" });
      lastUnnamedId = id;
      lastUnnamedEntry = activeSessions.get(id);
      entry = lastUnnamedEntry;
    } else {
      entry = lastUnnamedEntry;
      // 用户可能切换过模型：同步最新默认模型（用完整 runtime 模型，保证 compat 生效）
      try {
        if (defaultModel) {
          let fm = defaultModel;
          try { fm = modelRuntime.getModels().find(x => x.provider === defaultModel.provider && x.id === defaultModel.id) || defaultModel; } catch {}
          const ag = await ensureAgent(entry, fm);
          await ag.setModel(fm);
        }
      } catch {}
    }
  }
  // 记录对话开始时会话行数（交付去重基线：只推本轮新增文件）
  try {
    const sf = entry.sm.sessionFile;
    if (sf && fs.existsSync(sf)) chatBaseline = fs.readFileSync(sf, "utf8").split("\n").filter(Boolean).length;
  } catch {}
  // 通道策略：主次引擎对（engine-pair）决定本轮主驾。默认仍是 pi 主驾、元枢兑底。
  // PI_USE_AGENT=0 → 强制元枢。非 SDK 原生通道只让兼容 agent 兑底（dsh 有自己的通道）。
  // ⚠️ 这段是纯计算，必须放在 AIBody attach **之前**：attach 会把 engine 写进观测记录，
  // 原先硬编码 "yuanshu"，主驾是 pi 时记录就是错的。留在这里又用 observedEngine 会 TDZ。
  const reqProv = (typeof body.model === "string" && body.model.includes("/"))
    ? body.model.split("/")[0]
    : null;
  const engineDecision = resolveLead(loadEnginePair(), {
    forceYuanshu: process.env.PI_USE_AGENT === "0",
    nativeChannel: !reqProv || NATIVE_PROVIDERS.has(reqProv),
  });
  // 恢复任务必须走带 effects ledger 的统一工具循环；SDK agent 无法在
  // 内置 write/edit/bash 执行前可靠拦截，因此不能让恢复请求盲目重放。
  const forceResumeUnified = body.__runContext?.resume === true;
  const useAgent = !!defaultModel && engineDecision.lead === "pi" && !forceResumeUnified;
  const observedEngine = forceResumeUnified ? "yuanshu" : engineDecision.lead === "dsh" ? "dsh" : useAgent ? "pi" : defaultModel ? "yuanshu" : "pi";
  // 在主聊天 SSE 外层接入 AIBody：同一条流观察计划、工具、子任务、记忆与产物，
  // 结束时自动持久化本轮状态；不会改变 SSE 内容或背压行为。
  const aibodyTurn = aibodyHost.attach({
    res,
    runId: body.__runContext?.runId || undefined,
    sessionId: sessionId || findKeyByEntry(entry),
    engine: observedEngine,
    source: "chat",
    message,
    signals: body.__runContext?.signal,
  });
  const chatRunContext = {
    ...(body.__runContext || {}),
    runId: body.__runContext?.runId || aibodyTurn.runId,
    sessionId: sessionId || findKeyByEntry(entry),
    onEvent: aibodyTurn.event,
    aibodyContext: { goal: aibodyTurn.topic, strategy: aibodyTurn.directive },
  };
  // busy → 打断当前任务（对标 TUI interrupt：同一会话上处理新消息）
  if (entry.busy) {
    const curAgent = entry.agent;
    try { await curAgent.abort(); } catch {}
    // 等待当前任务释放 busy（abort 生效通常 2-3s）
    let waited = 0;
    while (entry.busy && waited < 8000) {
      await new Promise(r => setTimeout(r, 200));
      waited += 200;
    }
    if (entry.busy) {
      // abort 未生效（LLM 流卡死）→ 销毁旧 agent 重建，彻底释放
      try { curAgent.dispose(); } catch {}
      entry.busy = false;
      for (const [id, e] of activeSessions) if (e === entry) activeSessions.delete(id);
      console.log(`[元枢] 会话 ${sessionId || "new"} 打断失败，已销毁卡住 agent 并重建`);
      if (sessionId) {
        entry = await openSession(sessionId);
        if (!entry) return json(res, 404, { error: "会话不存在" });
      } else {
        const id = await createSession();
        lastUnnamedId = id;
        lastUnnamedEntry = activeSessions.get(id);
        entry = lastUnnamedEntry;
      }
    }
  }
  // 代次机制：每次请求递增，旧请求 finally 只在代次未变时释放 busy（防快速重发竞态）
  entry.gen = (entry.gen || 0) + 1;
  const thisGen = entry.gen;
  entry.busy = true;
  entry.busySince = Date.now();
  // 复读守卫的基准：**必须在动笔之前取**（2026-09-16 修首轮误判）。
  // pi 通道会在本轮中途就把回复写进会话文件；事后读文件当基准 = 拿自己跟自己比 → 全新会话首轮必判复读，
  // 然后静默换模型重写。取不到就是 null：首轮没有"上一条"，不可能复读。
  const replyBaseline = (() => {
    try { return lastAssistantReply({ sessionFile: entry.sm?.sessionFile, tree: entry.sm?.getTree?.() }); } catch { return null; }
  })();

  // /compact 手动压缩命令（Claude Code /compact 借鉴）：强制对早前历史生成结构化摘要，不消耗模型回合
  // 用法：/compact 或 /compact focus on <主题>；压缩结果写入会话（compaction 条目），返回摘要供前端展示
  const compactCmd = typeof message === "string" && message.trim().match(/^\/compact(?:\s+(?:focus\s+on\s+)?(.+))?$/i);
  if (compactCmd) {
    const compactFocus = (compactCmd[1] || "").trim();
    const sf = entry.sm.sessionFile;
    try {
      if (!sf || !fs.existsSync(sf)) return json(res, 400, { error: "会话文件不存在，无法压缩" });
      entry.busy = false;
      const r = await compactSession(sf, defaultModel, true, compactFocus);
      if (!r || r.skip) return json(res, 200, { compact: "skip", reason: r?.reason || "没有可压缩的内容（消息过少或摘要生成失败）" });
      console.log(`[元枢] 手动 /compact 完成: focus=${compactFocus || "-"} retained=${r.retained}`);
      return json(res, 200, { compact: "done", focus: compactFocus, retained: r.retained, summary: String(r.summary || "").slice(0, 500) });
    } catch (e) {
      console.log(`[元枢] 手动 /compact 失败: ${String(e?.message || e).slice(0, 120)}`);
      return json(res, 500, { error: "压缩失败：" + String(e?.message || e).slice(0, 120) });
    } finally {
      entry.busy = false;
    }
  }

  // Plan Mode v2（Cursor/Claude Code 借鉴，工具级硬限制）：/plan <需求> → 只读调研+输出分步计划
  // v2 用 agent.setActiveToolsByName 把工具集硬切为只读集（read/search_files）——模型目录里没有写工具，
  // 无法调用 write/edit/bash/dsh/share，结构性杜绝违规（v1 仅指令约束靠模型自觉）；accept 时恢复全量。
  // unifiedChat 兑底路径在 handleUnifiedChat 内做工具定义层过滤（见下）。
  const planCmd = typeof message === "string" && message.trim().match(/^\/plan(?:\s+(accept|cancel|execute)\b)?\s*(.*)$/i);
  if (planCmd) {
    const pAct = (planCmd[1] || "").toLowerCase();
    const pRest = (planCmd[2] || "").trim();
    const applyPlanTools = async (readonly) => {
      if (!entry.agent) return; // agent 尚未创建（新会话首条 /plan），ensureAgent 后统一应用
      try {
        const names = readonly ? PLAN_READONLY_SET : entry.agent.getAllTools().map(t => t.name);
        entry.agent.setActiveToolsByName(names);
        console.log(`[plan] ${readonly ? "工具级限制生效（只读）" : "工具集已恢复全量"} → ${names.join(", ")}`);
      } catch (e) { console.log(`[plan] 工具集设置失败: ${String(e?.message || e).slice(0, 80)}`); }
    };
    if (!pAct) {
      if (!pRest) return json(res, 400, { error: "/plan 用法：/plan <需求> 进入规划模式；/plan accept 批准执行；/plan cancel 取消" });
      entry.planPending = true;
      await applyPlanTools(true);
      message = `【规划模式】请先只读调研（你的工具已被系统限制为只读，仅能读取/搜索文件，无法修改/创建/删除任何文件、无法运行写入或测试命令），然后输出一份分步实施计划：目标 / 实施步骤 / 涉及文件 / 风险点。计划用编号列表清晰输出，最后询问用户是否批准。\n\n需求：${pRest}`;
    } else if (pAct === "accept" || pAct === "execute") {
      entry.planPending = false;
      await applyPlanTools(false);
      message = `【批准规划】用户已批准你上一步输出的计划。请现在按计划开始执行（你的工具已恢复，可以正常读写文件、运行命令）。`;
    } else {
      entry.planPending = false;
      await applyPlanTools(false);
      return json(res, 200, { plan: "cancelled" });
    }
  }

  // 绘图模型（id 含 image）→ 走图像生成接口（在写 SSE headers 之前处理）
  if (defaultModel && /image/i.test(defaultModel.id)) {
    try {
      const image = await generateImage(defaultModel.provider, defaultModel.id, message);
      if (image) return json(res, 200, { image, model: `${defaultModel.provider}/${defaultModel.id}` });
    } catch {}
    return json(res, 500, { error: "绘图失败（模型不支持图像生成或 Key 无效）" });
  }
  // 视频模型（id 含 video）→ 走视频生成（异步任务轮询）
  if (defaultModel && /video/i.test(defaultModel.id)) {
    const r = await generateVideo(defaultModel.provider, defaultModel.id, message);
    if (r.video) return json(res, 200, { video: r.video, model: `${defaultModel.provider}/${defaultModel.id}` });
    return json(res, 500, { error: r.error || "视频生成失败" });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // 前端携带模型同步（修复 C：显示与实发一致——刷新/多端时前端下拉值与服务端 modelKey 对齐）
  // ⚠️ 2026-08-19 防呆：auto/auto 是前端下拉默认显示值（未显式选择），不能覆盖用户已切过的具体会话模型
  //    ——否则用户切千问后，消息带的 stale "auto/auto" 会把 modelKey 打回 Auto → 路由乱跳（铁证：选了千问实际跑 mimo）
  if (typeof body.model === "string" && body.model.includes("/")) {
    // 2026-08-21 修复：模型 id 可含 /（如 stealth/ox-alpha）——split 只拆第一段 provider，其余拼回 id
    const slashIdx = body.model.indexOf("/");
    const bp = body.model.slice(0, slashIdx);
    const bm = body.model.slice(slashIdx + 1);
    try {
      if (bp === "auto" || /^auto(-smart)?$/i.test(bm)) {
        // 仅当会话本就处于 Auto（未切过具体模型）才保持；用户显式切过具体模型 → 不动，避免覆盖
        if (entry.modelKey && entry.modelKey.provider !== "auto" && entry.modelKey.id !== "auto") {
          // 已切具体模型：忽略 stale auto，保持用户选择
        } else if (!entry.modelKey || entry.modelKey.provider !== "auto") {
          entry.modelKey = { provider: "auto", id: "auto" };
          if (sessionId) saveSessionModelKey(sessionId, entry.modelKey);
        }
      } else {
        const same = entry.modelKey && entry.modelKey.provider === bp && entry.modelKey.id === bm;
        // ⚠️ 2026-08-19 收敛：前端 stale 显示值（localStorage 残留 nvidia/deepseek）不再同步进服务端——
        //   新会话一律默认千问，用户切模型走 /api/model 显式切换，只锁当前会话
        if (!same && modelList.find(m => m.provider === bp && m.id === bm)) {
          if (bp !== "deepseek" && bp !== "nvidia") {
            entry.modelKey = { provider: bp, id: bm };
            if (sessionId) saveSessionModelKey(sessionId, entry.modelKey);
            console.log(`[元枢] 前端同步模型 → ${bp}/${bm}`);
          } else {
            console.log(`[元枢] 忽略前端 ${bp} 同步（残留显示值防呆）→ ${bp}/${bm}`);
          }
        }
      }
    } catch {}
  }
  try { sseWrite(res, "engine_selected", { engine: observedEngine, reason: forceResumeUnified ? "恢复任务使用元枢循环，承接已保存的步骤。" : ({ primary: "使用系统配置的主引擎。", force: "启动配置指定使用元枢引擎。", "non-native": "当前模型通道由元枢自建循环承接。", "cannot-lead": "配置主引擎无法承担此任务，由可执行的引擎接替。" }[engineDecision.reason] || "使用本轮可用的执行通道。") }); } catch {}
  // 跨轮目标：本轮推进一轮（闸门在 advanceGoalTurn 里：到顶/重放/revision 不匹配一律不放行）。
  // 必须在分支之前认领，这样 pi 与 yuanshu 两条路径看到的是同一个轮号。
  const goalTurn = advanceGoalTurn(CONFIG.cwd);
  // 本轮开始前的会话文件大小：收尾结算时按这个偏移切片，只认本轮新追加的助手回复
  let sessionBytesBefore = (() => { try { return fs.statSync(entry.sm.sessionFile).size; } catch { return 0; } })();
  if (forceResumeUnified || engineDecision.lead === "dsh" || (defaultModel && !useAgent)) {
    const hb2 = startSseHeartbeat(res);
    // 打断支持：客户端断开 SSE 时中止 unifiedChat / dsh 子进程
    const abortCtrl = new AbortController();
    const onClose = () => { try { abortCtrl.abort(); } catch {} };
    req.on("close", onClose);
    try {
      try { sseWrite(res, "note", { text: leadNote(engineDecision) }); } catch {}
      if (engineDecision.lead === "dsh" && !forceResumeUnified) {
        await handleDshChat(res, entry, message, sessionId || findKeyByEntry(entry), abortCtrl.signal, { cwd: CONFIG.cwd });
      } else {
        await handleUnifiedChat(res, entry, message, sessionId || findKeyByEntry(entry), body.params, abortCtrl.signal, undefined, thinkOn, body.taskKey, (entry.modelKey && !isAutoModel(entry.modelKey)) ? entry.modelKey : null, null, chatRunContext);
      }
    } catch (e) {
      try { sseWrite(res, "error", { message: String(e?.message || e) }); } catch {}
      // 闸门③：一轮出错就解除目标，不带着错误继续转
      if (goalTurn?.ok) noteGoalError(CONFIG.cwd, goalTurn.goal.id, e?.message || e);
    } finally {
      clearInterval(hb2);
      req.removeListener("close", onClose);
      // 代次匹配才释放（快速重发时新请求已占 busy，旧请求不得干扰）
      if (entry.gen === thisGen) entry.busy = false;
      try { res.end(); } catch {}
      if (entry.gen === thisGen) invalidateSessionCache(); // 消息写入会话文件 → 列表缓存失效
      // 记忆结算：放在 res.end() 之后，不拖慢客户端收尾。
      // dsh 按引擎目录声明的边界（「不接记忆 / 出图 / 规划主循环」）跳过；
      // 被新请求顶掉的轮次也跳过——那时按偏移切片会切到新轮次的回复，属于错误归因。
      const ranUnifiedLoop = !(engineDecision.lead === "dsh" && !forceResumeUnified);
      if (ranUnifiedLoop && entry.gen === thisGen) {
        await settleTurnMemory({ wsRoot: CONFIG.cwd, entry, message, sessionId, bytesBefore: sessionBytesBefore });
      }
    }
    return;
  }
  // 会话级模型：切过模型则用会话的；未切（默认）→ Auto 路由（Cursor Router 简化版：按任务复杂度选 flash/pro）
  let autoRoute = null;
  const effModel = (() => {
    if (entry.modelKey && isAutoModel(entry.modelKey)) {
      autoRoute = routeForAuto(message, sessionId);
      return autoRoute.model;
    }
    if (entry.modelKey) {
      const picked = modelList.find(m => m.provider === entry.modelKey.provider && m.id === entry.modelKey.id) || defaultModel;
      // 主动避让：用户显式选中的模型已在冷却中(之前撞过 401/402/403/429/529) → 不进 SDK 重试循环，直接换备选
      // （上游错误文本常是中文（如智谱/opencode-go 的额度提醒），兼容 SDK 内部可重试判定用英文关键词正则匹配不上不可重试模式，
      // 会把额度耗尽误判成可重试，平白多等 3 次退避（共 ~14s）才降级）
      if (isModelBlocked(picked)) {
        const alt = pickFallbackExcluding(picked);
        console.log(`[元枢] 主动避让冷却模型: ${picked?.provider}/${picked?.id} 已冷却 → 换 ${alt?.provider}/${alt?.id}`);
        return alt || picked;
      }
      return picked;
    }
    // 未设置会话模型：默认走 Auto 路由（对标 Cursor 默认 Auto；PI_AUTO_ROUTE=0 可关闭）
    autoRoute = routeForAuto(message, sessionId);
    return autoRoute.model;
  })();
  if (autoRoute?.auto && autoRoute.model) markSticky(sessionId, autoRoute.model); // 会话粘性：10min 内 simple 轮不降档
  entry.autoRoute = autoRoute; // 供 SSE 播报与日志
  // ⚠️ 上下文余量闸门必须放在"agent 重建"之前（2026-09-18 真机事故）：
  //   会话涨到 195k/200k 时，SDK 按 min(模型声明, 窗口−输入−安全余量) 只肯给模型 ~400 token 输出，
  //   答案在 387 token 处被 length 截断，SDK 又删掉半截答案压缩重试（重试只吐 1 token）——
  //   用户看到"说到一半被打断"。这里先压缩+重开会话，让本轮就有输出余量。
  let headroom = null;
  if (sessionId && (entry.sm?.sessionFile || entry.sm?.getSessionFile?.())) {
    try {
      const h = await ensureContextHeadroom(sessionId, entry, effModel);
      if (h?.entry && h.entry !== entry) entry = h.entry;
      headroom = h;
    } catch (e) { console.log(`[headroom] 闸门失败(不阻断): ${String(e?.message || e).slice(0, 100)}`); }
  }
  // 压缩改写会让基线错位（chatBaseline/sessionBytesBefore 都用行数/字节数当锚）→ 重算
  if (headroom?.compacted) {
    try {
      const sf = entry.sm.sessionFile;
      if (sf && fs.existsSync(sf)) {
        chatBaseline = fs.readFileSync(sf, "utf8").split("\n").filter(Boolean).length;
        sessionBytesBefore = fs.statSync(sf).size;
      }
    } catch {}
  }
  // agent 绑定模型与本次生效模型（会话级切换 或 Auto 路由实时决策）不一致 → 重建 agent
  // ⚠️ 2026-08-19：原来只在 entry.modelKey 存在时重建，Auto 路由下 agent 仍绑创建时的 defaultModel（429 中）
  //    → 主请求失败、兕底文本回复、无思考无工具。改为与 effModel 全量对齐。
  if (entry.agent && effModel &&
      (!entry.agentModel || entry.agentModel.provider !== effModel.provider || entry.agentModel.id !== effModel.id)) {
    try { entry.agent.dispose(); } catch {}
    entry.agent = null;
    console.log(`[元枢] 生效模型变化，重建 agent → ${effModel.provider}/${effModel.id}`);
  }
  const agent = await ensureAgent(entry, effModel);
  // Plan 模式工具级限制：agent 就绪后统一应用一次（覆盖新会话首条 /plan / 模型切换重建后的 agent）
  if (entry.planPending) {
    try {
      agent.setActiveToolsByName(PLAN_READONLY_SET);
      console.log(`[plan] 工具级限制生效（只读）→ ${PLAN_READONLY_SET.join(", ")}`);
    } catch (e) { console.log(`[plan] 工具集设置失败: ${String(e?.message || e).slice(0, 80)}`); }
  }
  // agentModel 由 ensureAgent/createSessionAgent 设置真实值，这里不覆盖
  const sm = entry.sm;
  // 两阶段引导：本次请求是否新会话首轮（首轮锚定后 promote 完整工具集）
  let bootstrapTurn = isFirstTurn(entry.sm) && process.env.PI_TWO_PHASE !== "0";
  const hbTimer = startSseHeartbeat(res); // 心跳保活（公网隧道不因 idle 断开）
  const writer = createSseWriter(res); // 背压控制：慢网络时事件排队等 drain，不丢不堆
  try { const selected = entry.agentModel || effModel; writer.push("model_selected", { model: { provider: selected?.provider, id: selected?.id } }); } catch {}
  try { writer.push("note", { text: leadNote(engineDecision) }); } catch {}
  // 上下文余量如实播报：真腾出余量就报"压完还剩多少"；没腾出来就直说，别拿 🧹 糊弄
  try {
    if (headroom?.after?.contextWindow) {
      const used = headroom.after.usedTokens || headroom.before?.usedTokens || 0;
      const room = Number.isFinite(headroom.roomAfter) ? headroom.roomAfter : outputRoomTokens({ contextWindow: headroom.after.contextWindow, usedTokens: used });
      const modelName = `${effModel?.provider}/${effModel?.id}`;
      if (headroom.compacted && room >= 8192) {
        writer.push("note", { text: headroomNote({ contextWindow: headroom.after.contextWindow, usedTokens: used, room, compressed: true, model: modelName }) });
      } else if (room < 8192) {
        const why = !headroom.compacted && headroom.reason ? `（压缩没成功：${headroom.reason}）` : "";
        writer.push("note", { text: headroomNote({ contextWindow: headroom.after.contextWindow, usedTokens: used, room, model: modelName }) + why });
      }
    }
  } catch {}
  // Cursor Router 播报：Auto 路由决策对用户透明（取 Cursor 可用性长板，可解释）
  if (autoRoute && autoRoute.auto && effModel) {
    const routeBadge = autoRoute.level === "complex" ? "🛰️ 复杂任务" : "⚡ 日常任务";
    const routeNote = `${routeBadge} · Auto 路由 → ${effModel.id}${autoRoute.reasons?.length ? "（" + autoRoute.reasons.join("/") + "）" : ""}`;
    writer.push("note", { text: routeNote });
    console.log(`[router] ${routeNote}`);
  }
  const taskId = body.taskKey || sessionId || findKeyByEntry(entry) || "new";
  // 事件总线：任务事件同时入总线（多端订阅观看），sessionId 存在时双挂
  const busKeys = [taskId, ...(sessionId && sessionId !== taskId ? [sessionId] : [])];
  const busEmit = (type, data) => { for (const k of busKeys) busPush(k, type, data); };
  touchTask(taskId, { stage: "处理中" });

  // ── 危险操作确认（dsh user-approval seam）：命中危险 cmd → 弹框等人工 ──
  // 包装底层 agent 的 beforeToolCall：命中危险 → 发 confirm 事件 → 等前端回答 → 放行/阻断
  // ⚠️ 只挂一次：entry.agent 会话级复用，若每次 handleChat 都包装会层层叠加（重复确认刷屏）
  try {
    const innerAgent = agent?.agent || agent; // AgentSession.agent(底层) 优先
    if (innerAgent && typeof innerAgent.beforeToolCall === "function" && !innerAgent.__approvalWrapped) {
      innerAgent.__approvalWrapped = true;
      const origBefore = innerAgent.beforeToolCall;
      const approval = createApprovalInterceptor({
        policyDecide, // dsh-keys 策略引擎（安全红线仍直接拒绝，不弹框）
        ask: async (toolName, args, reason) => {
          const sid = sessionId || findKeyByEntry(entry) || taskId;
          const reg = confirmRegistry.register(sid, { toolName, reason, src: "ask" });
          // 推给前端：确认框
          writer.push("confirm", { id: reg.id, toolName, reason, args: args || {}, sessionId: sid });
          busEmit("confirm", { id: reg.id, toolName, reason, args: args || {}, sessionId: sid });
          const outcome = await reg.promise; // 等前端/超时 （cancelled / allowed-once / rejected）
          return outcome;
        },
        enabled: process.env.PI_APPROVAL !== "0", // 默认开；PI_APPROVAL=0 关
        log: (m) => console.log(m),
      });
      innerAgent.beforeToolCall = approval.wrapBeforeToolCall(origBefore);
    }
  } catch (e) {
    console.log(`[approval] 注入失败(不阻断正常流): ${String(e?.message || e)}`);
  }

  let sawDelta = false; // 是否产生过文本输出（用于空回复兜底）
  let collected = "";   // 收集主模型输出（用于媒体路由的配图/配音内容）
  // ④ 续画上下文（2026-09-16）：用户上一轮在出图，这一轮只说"再换个词的出一下"——
  // 关键词检测必然漏，宿主旁路不出图、模型又不主动调工具 → 表现就是"经常不画"。
  const mediaKey = sessionId || findKeyByEntry(entry) || "new";
  const lastMedia = lastMediaBySession.get(mediaKey) || null;
  const mediaIntents = detectMediaIntents(message, { lastMediaType: lastMedia?.type, lastPrompt: lastMedia?.prompt });
  const mediaPromptOf = (it) => extractMediaPrompt(message, { followUp: it.followUp, lastPrompt: lastMedia?.prompt });
  // 并行启动全部媒体生成（不阻塞主模型文字流式）
  let mediaPromise = mediaIntents.length
    ? Promise.all(mediaIntents.map(it => generateMediaAsync(it, mediaPromptOf(it))))
    : Promise.resolve([]);
  let settledMedia = [];
  const mediaDelivered = mediaIntents.length
    ? mediaPromise.then(async (results) => {
        const items = [];
        const errors = [];
        for (const mr of results || []) {
          if (!mr) continue;
          if (mr.error && !mr.url) { errors.push(mr.error); continue; }
          if (!mr.url) continue;
          // 本地化契约：外站临时链接必须先落本地；没落成要标记出来，
          // 不能再 try/catch 一吞了事——那样界面分辨不出"已存"和"没存"。
          const saved = await saveArtifact(mr);
          mr.url = saved.url;
          mr.localized = saved.local;
          if (!saved.local) {
            mr.localizeError = saved.reason;
            errors.push(`产物没能存到本地（${saved.reason}）：当前用的是外站临时链接，过期会失效`);
          }
          items.push(mr);
          try { writer.push("media", mr); busEmit("media", mr); } catch {}
        }
        settledMedia = items;
        // ④ 记住"这个会话上一轮出过图、用的是什么提示词"，供续画（"再换个词"）使用
        if (items.some(i => i.type === "image")) {
          const used = mediaIntents[0]?.followUp ? (lastMedia?.prompt || extractMediaPrompt(message)) : extractMediaPrompt(message);
          lastMediaBySession.set(mediaKey, { type: "image", prompt: used, at: Date.now() });
        }
        if (items.length && mediaIntents.some(i => i.followUp)) {
          const why = "按你上一张的要求又画了一张（宿主旁路出图：不依赖模型自己想起来调工具）";
          try { writer.push("note", { text: why }); busEmit("note", { text: why }); } catch {}
        }
        const notice = mediaReadyNotice(items);
        if (notice) {
          try {
            await entry.agent?.sendCustomMessage?.(
              { customType: "context", content: [{ type: "text", text: notice }] },
              { deliverAs: "nextTurn" }
            );
          } catch {}
        } else if (mediaIntents.some(i => i.type === "image")) {
          const miss = `图像模型这次没出成图${errors.length ? "：" + explainMediaError(errors[0]) : ""}。你可以继续用工具画 SVG 或其他成品交出来。`;
          try { writer.push("note", { text: miss }); busEmit("note", { text: miss }); } catch {}
        }
        return items;
      }).catch((e) => {
        const miss = `出图未成功：${explainMediaError(e)}。思考和工具不受影响。`;
        try { writer.push("note", { text: miss }); busEmit("note", { text: miss }); } catch {}
        return [];
      })
    : Promise.resolve([]);
  const unsubscribe = agent.subscribe((event) => {
    try {
      // 两阶段引导 promote：首轮产生首个文本/工具事件 → 恢复完整工具集（下个 turn 生效，零成本）
      // turn_end 兜底：首轮无论是否产生文本/工具事件（纯思考/空回复/报错），结束时也强制 promote，杜绝工具集永久残缺
      // Plan 模式例外：规划期间保持只读硬限制，不 promote（否则工具级限制被绕过）
      if (bootstrapTurn && !entry.planPending && (event.type === "message_update" || event.type === "tool_execution_start" || event.type === "turn_end")) {
        try {
          const allNames = agent.getAllTools().map(t => t.name);
          if (allNames.length) {
            agent.setActiveToolsByName(allNames);
            console.log(`[agent] 两阶段引导：首轮锚定完成，promote → 完整工具集 ${allNames.join(", ")}`);
          }
        } catch (e) { console.log(`[agent] 两阶段引导 promote 失败: ${String(e?.message || e).slice(0, 80)}`); }
        bootstrapTurn = false;
      }
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        sawDelta = true;
        const delta = event.assistantMessageEvent.delta || "";
        collected += delta;
        // 过滤模型复述/泄漏的内部指令（情绪语境等），避免显示给用户
        const cleaned = delta.replace(/【内部指令·情绪语境】[\s\S]*?(?=【|\n\n|$)/, "").replace(/【当前情绪语境】[\s\S]*?(?=【|\n\n|$)/, "");
        if (cleaned) { writer.push("delta", { text: cleaned }); busEmit("delta", { text: cleaned }); }
      } else if (event.type === "message_update" && event.assistantMessageEvent?.type === "thinking_delta") {
        writer.push("think", { text: event.assistantMessageEvent.delta });
        busEmit("think", { text: event.assistantMessageEvent.delta });
      } else if (event.type === "message_update" && event.assistantMessageEvent?.type === "thinking_end") {
        writer.push("think_end", {});
        busEmit("think_end", {});
      } else if (event.type === "tool_execution_start") {
        touchTask(taskId, { stage: "执行工具", toolName: event.toolName });
        writer.push("tool", { name: event.toolName, args: event.args, id: event.toolCallId });
        busEmit("tool", { name: event.toolName, args: event.args, id: event.toolCallId });
      } else if (event.type === "tool_execution_end") {
        touchTask(taskId, { stage: "工具完成", toolName: event.toolName });
        const text = Array.isArray(event.result?.content)
          ? event.result.content.map(c => c.text || "").join("")
          : "";
        writer.push("tool_end", { name: event.toolName, id: event.toolCallId, isError: !!event.isError, output: text });
        busEmit("tool_end", { name: event.toolName, id: event.toolCallId, isError: !!event.isError, output: text });
        const media = event.result?.details?.media;
        if (media?.url) {
          try { writer.push("media", media); busEmit("media", media); } catch {}
        } else if (text) {
          try {
            const scraped = extractPlayableMedia(text);
            // 2026-09-16：从工具输出里刮出来的媒体也要走**本地化契约**。
            // 以前是原样推给前端：真机验证时就看到一条 platform-outputs.agnes-ai.space 的外站链接
            // 直接进了对话——那种链接会过期，图和视频迟早变裂图。这里统一 saveArtifact 后再推。
            const pushScraped = async (type, url) => {
              let finalUrl = url;
              let localizeError = "";
              try {
                const saved = await saveArtifact({ type, url });
                if (saved?.url) finalUrl = saved.url;
                if (saved && !saved.local) localizeError = saved.reason || "下载失败";
              } catch (e) { localizeError = String(e?.message || e).slice(0, 120); }
              const payload = { type, url: finalUrl, ...(localizeError ? { localizeError } : {}) };
              try { writer.push("media", payload); busEmit("media", payload); } catch {}
            };
            for (const url of scraped.videos) void pushScraped("video", url);
            for (const url of scraped.images) void pushScraped("image", url);
            for (const url of scraped.audios) void pushScraped("audio", url);
          } catch {}
        }
      } else if (event.type === "turn_end") {
        writer.push("turn_end", {});
        busEmit("turn_end", {});
        // P1 活跃会话按轮卫生：turn_end 时检查文件大小，超阈值先 sanitize 再 compact
        try {
          const sf = entry.sm?.getSessionFile?.();
          if (sf && fs.existsSync(sf)) {
            const sz = fs.statSync(sf).size;
            if (sz > 5 * 1024 * 1024) { // >5MB 触发 sanitize
              sanitizeSessionFile(sf);
              if (sz > 10 * 1024 * 1024) { // >10MB 额外触发 compact
                compactSession(sf, effModel || defaultModel, true).catch(() => {});
              }
            }
          }
        } catch {}
        // 情绪实时推送：每轮结束把最新情绪快照推给前端（emo 指示器实时跳动，不再是只发/收时更新）
        try {
          const esKey = sessionId || findKeyByEntry(entry) || "new";
          emotion.updateFromOutput(esKey, collected); // 曦系⑥：输出侧感知，回复长短也影响唤醒（09-04）
          emotion.recordFeeling(esKey, message); // 曦系二期：真实感受存档（事+感+强度）
          try { emotion.flushPersonaAttribution(esKey); } catch {}
          const es = emotion.getSnapshot(esKey);
          if (es) { writer.push("emotion", { state: es }); busEmit("emotion", { state: es }); }
        } catch {}
      } else if (event.type === "auto_retry_start") {
        writer.push("note", { text: `⚠️ 自动重试中（第 ${event.attempt} 次）：${event.errorMessage}` });
        busEmit("note", { text: `⚠️ 自动重试中（第 ${event.attempt} 次）：${event.errorMessage}` });
        // 主动避让：重试事件带真实错误文本，命中额度/权限错误码提前标冷却，下一轮进入 effModel 选择时就能直接避开
        // （中文额度错误文本 SDK 重试判定正则匹配不上不可重试模式，重试耗尽后不抛异常 catch 块无机会标冷却，事件里的 errorMessage 是唯一可靠信号源）
        try {
          const st = String(event.errorMessage || "").match(/HTTP\s*(\d{3})|status.?(\d{3})|^(\d{3}):/);
          const code = st ? parseInt(st[1] || st[2] || st[3], 10) : 0;
          if ([401, 402, 403, 429, 529].includes(code) && effModel) {
            markModelBlocked(effModel, { reason: `HTTP ${code} (重试中提前标冷却)` });
          }
        } catch {}
      } else if (event.type === "compaction_start") {
        writer.push("note", { text: "🧹 上下文压缩中…" });
        busEmit("note", { text: "🧹 上下文压缩中…" });
      }
    } catch {}
  });

  let aborted = false;
  req.on("close", () => {
    if (!res.writableEnded && !aborted) {
      aborted = true;
      try { agent.abort(); } catch {}
      // 兜底：abort 未及时生效时（如 LLM 流卡住），2.5s 后销毁 agent 并释放 busy，避免会话被永久锁定
      setTimeout(() => {
        if (entry.busy && entry.gen === thisGen) {
          entry.busy = false;
          try { agent.dispose(); } catch {}
          for (const [id, e] of activeSessions) if (e === entry) activeSessions.delete(id);
          console.log(`[元枢] 会话 ${sessionId || "new"} 连接断开，已销毁卡住 agent`);
        }
      }, 2500);
    }
  });

  try {
    // 情绪感知：更新会话情绪状态，注入行为指令（用 nextTurn 机制，不写入会话历史）
    const sessKey = sessionId || findKeyByEntry(entry) || "new";
    // 记下这条消息与当前会话：activate_skill 发生时用它当 episode 的输入（工具执行器没有对话上下文）
    globalThis.__yuanshuLastSessionKey = sessKey;
    if (message) lastUserBySession.set(sessKey, String(message).slice(0, 500));
    // ⚠️ 必须在 updateEmotion **之前**取：它会把 lastTalk 刷成本轮，之后差值恒为 0
    const prevTalkAt = (() => { try { return Number(emotion.getSnapshot(sessKey)?.lastTalk) || 0; } catch { return 0; } })();
    emotion.updateEmotion(sessKey, message);
    const emoPrompt = emotion.emotionPrompt(sessKey, message);
    // 自我认知：仅当用户问"你是谁/介绍自己"等身份问题时注入固定答案（不主动开场白）
    let promptMsg = message;
    const isIdentityAsk = /^(你是谁|你叫什么|你叫啥|你是谁啊|介绍一下你|介绍下你自己|自我介绍|你是做什么|你是干什么|干嘛的|干什么的|什么身份|你.{0,3}(?:多大|几岁)|(?:多大|几岁)了|年龄|生日|出生|你有哪.{0,4}能力|你能.{0,6}做.{0,4}什么)/.test(message) && message.length < 80;
    if (isIdentityAsk) {
      const m = effModel || defaultModel;
      const features = [];
      if (m?.reasoning) features.push("推理型");
      if (m?.contextWindow) features.push(`上下文 ${Math.round(m.contextWindow / 1000)}k`);
      if (Array.isArray(m?.input) && m.input.includes("image")) features.push("支持图片");
      const featText = features.length ? features.join(" · ") : "标准模型";
      const modelName = m?.name || m?.id || "未知";
      const providerName = m?.provider ? `（${m.provider}）` : "";
      // 2026-08-24 修复：不再替换 promptMsg（模型看不到原始问题），改 context 注入
      try {
        const pd = loadPersonaDefinition(CONFIG.cwd);
        const self = `${pd.def.name}，${Number(pd.def.age)} 岁的${pd.def.kind || "AI 工作伙伴"}`;
        const identityAnswer = `（自我认知指令）用户问了身份类问题。请按固定格式回答。硬性要求：①完整输出下面这段格式后立即结束，不要追加任何内容；②禁止调用任何工具/搜索/读文件；③不要输出过程性文字（如"我去查"）；④**身份事实以人格定义为准**：名字/年龄/称呼照抄下面这段，不要用记忆时间线、系统运行时长、建号天数自行推断年龄。格式如下：\n"我叫${self}。我能干：写代码、做设计、整理文档、分析数据，并直接操作工作空间完成交付。由元枢工作台驱动。当前使用模型是：${modelName}${providerName}。模型特色：${featText}。"\n回答完直接等用户下一步指令。`;
        await entry.agent?.sendCustomMessage?.(
          { customType: "context", content: [{ type: "text", text: identityAnswer }] },
          { deliverAs: "nextTurn" }
        );
      } catch {}
      // promptMsg 保持原始消息不变
    } else if (emoPrompt) {
      // 非身份类：情绪指令通过 nextTurn 注入（不污染会话历史）
      try {
        await entry.agent?.sendCustomMessage?.(
          { customType: "context", content: [{ type: "text", text: emoPrompt }] },
          { deliverAs: "nextTurn" }
        );
      } catch {}
    }
    // 时间上下文：统一由 promptTimeText 产出（含"距上次对话多久" + 观测到的作息/节律）
    try {
      const rhythm = readActivityRhythm(CONFIG.cwd, { now: new Date(), sessionDir: SESSIONS_DIR });
      await entry.agent?.sendCustomMessage?.(
        { customType: "context", content: [{ type: "text", text: `【时间上下文】${promptTimeText(new Date(), { since: prevTalkAt, rhythm })}` }] },
        { deliverAs: "nextTurn" }
      );
    } catch {}
    // 跨轮目标：把"进行到第几轮"和纪律交给模型（未武装时为空，不占上下文）
    if (goalTurn?.prompt) {
      try {
        await entry.agent?.sendCustomMessage?.(
          { customType: "context", content: [{ type: "text", text: goalTurn.prompt }] },
          { deliverAs: "nextTurn" }
        );
      } catch {}
    }
    // 待兑现承诺：模型自己许下但没结清的事，主动交代；账上为空时不占上下文
    try {
      const owed = pendingPromiseText(CONFIG.cwd, { now: new Date(), limit: 5 });
      if (owed) {
        await entry.agent?.sendCustomMessage?.(
          { customType: "context", content: [{ type: "text", text: owed }] },
          { deliverAs: "nextTurn" }
        );
      }
    } catch {}
    // AIBody 运行协调：模式策略 + 状态提供者摘要。
    // 之前这份 directive 只进了 executionContext 给子智能体用，**主角色收不到**；
    // 而 directiveFor 里写的正是"母体协调身份、记忆与角色治理""主角色负责综合和交付"。
    // 用 nextTurn 注入，与情绪/时间同一个口子，不污染会话历史。
    if (aibodyTurn?.directive) {
      try {
        await entry.agent?.sendCustomMessage?.(
          { customType: "context", content: [{ type: "text", text: aibodyTurn.directive }] },
          { deliverAs: "nextTurn" }
        );
      } catch {}
    }
    // PPT 任务专用执行护栏：交付类请求不能停在“我会做/大纲已列”或伪造文件。
    // 通过 nextTurn 注入，不改人格文件，也不污染会话历史；真正的工具由 Pi SDK customTools 提供。
    if (/\b(?:pptx?|powerpoint)\b|幻灯片|演示文稿|宣传ppt/i.test(message)) {
      try {
        await entry.agent?.sendCustomMessage?.(
          { customType: "context", content: [{ type: "text", text: "【PPT 任务执行约束】这是直接交付任务。先调用 activate_skill 加载匹配的 ppt-generator 或 ppt-html 技能全文，再立刻用 read/write/bash/edit 完成内容与构建；不要只输出计划、伪造 <tool_call> 文本或声称文件已生成。必须实际检查 .pptx/设计稿文件存在且大小有效，回复末尾写出真实相对路径并使用“📎 交付: <路径>”。工具参数过长请分段执行。" }] },
          { deliverAs: "nextTurn" }
        );
      } catch {}
    }
    // 大文件分块写（2026-09-18）：Pi 通道用的是 SDK 内置 write（元枢拦不到它的参数），
    // 只能把写法写进每轮上下文；元枢自制循环那边有硬闸门（engine/tools/unified-tools.mjs）。
    try {
      await entry.agent?.sendCustomMessage?.(
        { customType: "context", content: [{ type: "text", text: "【大文件分块写】一次 write 的内容就是你的输出，超过约 2 万 token 会被单次输出上限截断（参数断在 JSON 中间，整轮白费）。要写长文件就分块：第一块 write，后续块在同一路径上用 bash 追加重定向（>>）或 edit 续写；每块控制在 1.5 万 token 以内。" }] },
        { deliverAs: "nextTurn" }
      );
    } catch {}
    // 元枢内置技能库（仓库根 skills/）：Pi SDK 会话的技能发现只看 `cwd/skills` 与
    // `agentDir/skills` 两个根，**仓库里的 skills/ 不在它的扫描范围内**——于是「元枢技能」
    // 页面上列得出来、模型却看不见，`activate_skill` 也就永远等不到调用。
    // 2026-09-15 实测：问"用提示词架构师的办法…"，模型回"列表里没有 prompt-architect 技能"，
    // 转身去读了 SDK 自己那份目录里的 multi-agent-meeting。
    // 修法：每个会话注入一次目录（不重复占上下文），命中匹配时再补一句"本轮可能匹配"。
    try {
      const builtinSkills = loadSkillIndex();
      if (!skillCatalogSent.has(sessKey)) {
        const catalog = formatSkillIndexPrompt(builtinSkills);
        if (catalog) {
          skillCatalogSent.add(sessKey);
          await entry.agent?.sendCustomMessage?.(
            { customType: "context", content: [{ type: "text", text: `【元枢内置技能库】这是元枢自带的技能（与 SDK 自己扫描到的那份是**两个来源**，两边都可能有用）。对得上就先 activate_skill 加载全文再做，对不上按你的判断做。\n${catalog}` }] },
            { deliverAs: "nextTurn" }
          );
        }
      }
    // 当场修护栏（2026-09-17）：Pi 会话的提示词不是统一引擎那份协议，工具光注册了模型不会用。
    // 每会话注入一次（与技能目录同一个口子、同一个 Set），把"发现问题就当场修"讲清楚。
    if (!skillCatalogSent.has(`${sessKey}::fix`)) {
      skillCatalogSent.add(`${sessKey}::fix`);
      try {
        await entry.agent?.sendCustomMessage?.(
          { customType: "context", content: [{ type: "text", text: "【发现问题就当场修】干活时发现**当场能修**的小毛病（代码/测试/配置/文档/脚本），别只在结论里写一条「建议修复」——用 fix_problem 当场派一轮修掉、拿回证据再继续（同一会话 10 分钟内最多 3 次）。需要人拍板的（权限/密钥/部署/推送/删数据/花钱）不要碰，写进结论说清等谁做哪一步。修不成如实说卡在哪。" }] },
          { deliverAs: "nextTurn" }
        );
      } catch {}
    }
    const matchedSkills = matchSkillsForTask(message, builtinSkills, 3, currentWeights(WS_ROOT).weights || undefined);
      if (matchedSkills.length) {
        await entry.agent?.sendCustomMessage?.(
          { customType: "context", content: [{ type: "text", text: `本轮任务可能匹配元枢内置技能：${matchedSkills.map(s => s.name).join("、")}。对得上就 activate_skill 加载全文，对不上按你的判断继续。` }] },
          { deliverAs: "nextTurn" }
        );
      }
    } catch {}
    // 条件注入全量记忆（任务型消息才带）：人格保底用常驻索引（agent 创建时已注入），干活时全量
    if (shouldInjectFullMemory(message)) {
      setLastUserQuery(message);
      try {
        const fullMem = loadMemory();
        console.log(`[tiered] 任务型注入: msg="${message.slice(0, 30)}" mem=${fullMem.length ? fullMem.reduce((a, c) => a + c.length, 0) : 0}c`);
        if (fullMem.length) {
          await entry.agent?.sendCustomMessage?.(
            { customType: "context", content: [{ type: "text", text: fullMem.join("\n\n") }] },
            { deliverAs: "nextTurn" }
          );
        }
      } catch {}
    } else {
      console.log(`[tiered] 闲聊不注入: msg="${message.slice(0, 30)}"`);
    }
    // 外部思考调试：注入 think 引导（nextTurn，不污染会话历史）
    if (thinkOn) {
      try {
        await entry.agent?.sendCustomMessage?.(
          { customType: "context", content: [{ type: "text", text: THINK_PROMPT }] },
          { deliverAs: "nextTurn" }
        );
      } catch {}
    }
    // 出图与主模型真正并行：先注入「正在出图、照常思考、允许交 SVG」，立刻 prompt。
    // 图若在注入 context 的几百毫秒里已经回来，settledMedia 会带上路径；否则 nextTurn 再告知。
    if (mediaIntents.length && !settledMedia.length) {
      const drawingNote = mediaIntents.some(i => i.type === "video")
        ? "视频模型正在出片，完成后会显示在对话里。"
        : "图像模型正在出图，完成后会显示在对话里。";
      try { writer.push("note", { text: drawingNote }); busEmit("note", { text: drawingNote }); } catch {}
    }
    promptMsg = mediaAwarePrompt(promptMsg, settledMedia);
    // 图像兜底：当前模型不支持图片且消息带图 → 临时切套餐内图像模型识别，处理完恢复原模型
    let visionSwitched = false, origAgentModel = null, visionModel = null;
    if (images.length) {
      const curM = entry.agentModel || (defaultModel ? { provider: defaultModel.provider, id: defaultModel.id } : null);
      const curSupportsVision = curM && (modelList.find(m => m.provider === curM.provider && m.id === curM.id)?.input?.includes("image"));
      if (!curSupportsVision) {
        // 兜底优先级：⚠️ 2026-08-20 修正——原 fallbackIds（mimo-v2.5/minimax-m3/qwen3.8-max/kimi-k3/gpt-5.6-luna）全是 opencode-go 套餐模型，
        // 清单瘦身(464→22)后已不存在，第一层永远落空。改为直接候选支持 image 的免费通道：xiaomi mimo-v2.5 → 商汤 flash-lite
        // （默认主力商汤本身就支持 image，一般不会走到这里）
        visionModel = modelList.find(m => m.provider === "xiaomi-token-plan-cn" && m.input?.includes("image"))
          || modelList.find(m => m.provider === "sensenova" && m.input?.includes("image"));
        if (visionModel) {
          try {
            origAgentModel = entry.agentModel || (defaultModel ? { provider: defaultModel.provider, id: defaultModel.id } : null);
            if (entry.agent) { try { entry.agent.dispose(); } catch {} entry.agent = null; }
            entry.agentModel = { provider: visionModel.provider, id: visionModel.id };
            await ensureAgent(entry, visionModel);
            visionSwitched = true;
            console.log(`[元枢] 图像兜底：${curM?.provider}/${curM?.id} → ${visionModel.provider}/${visionModel.id}`);
          } catch (e) {
            console.log(`[元枢] 图像兜底切换失败: ${String(e?.message || e).slice(0, 80)}`);
          }
        }
      }
    }
    // P0 卫生防线：agent.prompt 前截断会话里的超大 thinkingSignature/thinking/工具结果
    // 防止 reasoning 模型签名膨胀导致上游 400/502（10MiB 单字段限制+200k 上下文超限）
    try {
      const sf = entry.sm?.getSessionFile?.();
      if (sf) {
        const sr = sanitizeSessionFile(sf);
        if (sr.truncated) console.log(`[sanitize] 会话 ${sessionId || "new"}: 截断 ${sr.truncated} 条超大消息`);
      }
    } catch (e) { console.log(`[sanitize] 预处理失败(不阻断): ${String(e?.message || e).slice(0, 80)}`); }
    try {
      await agent.prompt(promptMsg, { images });
    } finally {
      // 处理完恢复原模型（避免把会话默认模型悄悄改掉）
      if (visionSwitched && origAgentModel) {
        try {
          if (entry.agent) { try { entry.agent.dispose(); } catch {} entry.agent = null; }
          entry.agentModel = origAgentModel;
          await ensureAgent(entry, modelList.find(m => m.provider === origAgentModel.provider && m.id === origAgentModel.id) || origAgentModel);
          console.log(`[元枢] 图像兜底已恢复: ${origAgentModel.provider}/${origAgentModel.id}`);
        } catch (e) { console.log(`[元枢] 图像兜底恢复失败: ${String(e?.message || e).slice(0, 80)}`); }
      }
    }
    // 空回复兜底：agent 完成但无任何文本输出（部分推理模型偶发把回答全放 <think>）→ 直调模型接口补一次
    // ⚠️ 2026-09-16：先分清"上游**报错**"和"模型真的空回复"——这两件事此前的处理一样，
    // 于是上游报错时走了 directChat 无历史兜底，用户看到一句没有上下文的回答，
    // 只能得出"它失忆了、变傻了"（真机上就是这么被误解的）。
    const upstream = lastTurnUpstreamError(entry);
    if (sawDelta) {
      clearModelFailures(effModel);
    } else if (upstream) {
      console.log(`[元枢] 本轮上游失败 ${effModel?.provider}/${effModel?.id} → ${upstream.errorMessage}`);
      const f = noteModelFailure(effModel, upstream.errorMessage);
      const st = modelFailureState(effModel);
      if (f.blocked) {
        try { markModelBlocked(effModel, { reason: `连续 ${st?.count || f.count} 次上游失败：${f.reason}` }); } catch {}
        console.log(`[元枢] ${f.key} 连续失败 ${st?.count || f.count} 次 → 已标冷却，后续轮次自动避开`);
      }
      const label = effModel ? `${effModel.provider}/${effModel.id}` : "当前模型";
      const why = String(upstream.errorMessage || "未给出原因").slice(0, 300);
      const note = f.blocked
        ? `本轮 ${label} 调用失败：${why}。已连续 ${st?.count || f.count} 次失败，**已把这条路标冷却**，下一轮会自动避开它。`
        : `本轮 ${label} 调用失败：${why}。再失败一次就会自动避开这条路。`;
      try { writer.push("error", { message: note, retryable: true, model: label, reason: why, blocked: !!f.blocked }); busEmit("error", { message: note }); } catch {}
    }
    if (!sawDelta && !upstream) {
      // （重试中提前标冷却已在 auto_retry_start 事件里处理，这里只负责换备选提供回答）
      // 修复 B：空回复兕底用安全模型（避开 opencode-go 429 且排除当前模型，不再死磕 defaultModel）
      const fbModel = pickFallbackExcluding(effModel);
      const fallback = fbModel ? await directChat(fbModel, message) : null;
      if (fallback?.text) {
        writer.push("delta", { text: fallback.text });
        console.log(`[元枢] 空回复兜底成功: ${fbModel.provider}/${fbModel.id}`);
        // 兜底回答没带历史，必须在界面上说清楚，别让用户以为主模型变傻了
        try { writer.push("note", { text: `上面这句来自备用通道 ${fbModel.provider}/${fbModel.id}（本轮主模型空回复，兜底不带对话历史）` }); } catch {}
        try { writer.push("model_switched", { provider: fbModel.provider, id: fbModel.id, sameModel: false, reason: "主模型空回复，走了备用通道（不带对话历史）" }); } catch {}
      } else {
        console.log(`[元枢] 空回复兜底失败: ${fbModel?.provider}/${fbModel?.id}`);
        // 明确提示：报用户选定的模型（兜底链模型只是替死鬼，报它会让用户莫名其妙）
        try { writer.push("error", { message: `模型 ${effModel?.provider}/${effModel?.id} 无回复（已自动尝试备用通道 ${fbModel?.provider}/${fbModel?.id} 也失败）——可能是 API Key 失效/额度不足/网络代理问题，请到模型管理检查配置`, retryable: true, model: `${effModel?.provider}/${effModel?.id}` }); } catch {}
      }
    }
    // 输出质量守卫：主模型输出异常（复读/纯标记/空回复）→ 自动切 fallback 重试
    //（空回复/纯思考由 sawDelta 兜底处理；此处统一 classifyAnomaly 判定，避免双重兜底）
    const rk = sessionId || findKeyByEntry(entry) || "new";
    if (sawDelta && collected) {
      const anom = classifyAnomaly({ sessionKey: rk, text: collected, think: "", sessionFile: entry.sm?.sessionFile, baseline: replyBaseline });
      if (anom.type === "undefined-leak") {
        // undefined 污染：直接清理后接受（内容大部分正常，只清占位符，不打断）
        const clean = sanitizeUndefined(collected);
        if (clean && clean !== collected) {
          console.log(`[元枢] 清理 undefined 污染: ${collected.length} → ${clean.length} 字符`);
          collected = clean;
          try { writer.push("text", { text: clean }); } catch {}
        }
        recordReply(rk, collected);
      } else if (anom.type === "repeat" || anom.type === "marker" || anom.type === "amnesia") {
        // 2026-08-21 AI 检测员复核：规则判异常后，检测员语义级确认 + 给针对性修正建议
        console.log(`[元枢] 输出守卫(${anom.type}): ${effModel?.provider}/${effModel?.id} ${anom.reason} → 检测员复核`);
        const insp = await inspectOutput({ userMessage: message, output: collected, history: recentHistory(entry) }).catch(() => null);
        if (insp && insp.verdict === "ok") {
          // 检测员判定正常（规则误报）→ 接受原输出
          recordReply(rk, collected);
          console.log(`[元枢] 检测员判定 ok（规则误报），接受原输出`);
        } else {
          // 确认异常：用检测员的修正建议（或默认）引导同模型修正
          await retryRepeatWithFallback(message, rk, writer, busEmit, effModel, insp?.suggestion, recentHistory(entry), entry);
        }
      } else if (anom.type === "none") {
        recordReply(rk, collected);
      }
    }
    // 自动命名：尚无名称时用首条消息
    if (!entry.sm.getSessionName()) {
      try { entry.sm.appendSessionInfo(message.slice(0, 24)); } catch {}
    }
    // 文件交付：优先解析模型回复里的「📎 交付:」标记（精准交付，AI 按任务针对性选文件）
    // 解析不到才兜底扫描最近产物（兼容模型不按标记回复的情况）
    try {
      let files = extractMessageFiles(entry.sm, chatBaseline);
      // 识别用户请求的文件类型（"发图片/图/照片"→只要图；"ppt"→只要演示文件）
      const wantImg = /图片|图[片片]?|照片|画|生成图|配图/i.test(message) && !/ppt|文档|pdf/.test(message);
      const wantPpt = /ppt|pptx|演示|幻灯片/i.test(message);
      const wantDoc = /文档|docx?|pdf|word/i.test(message);
      if (!files.length) {
        // 1. 解析交付标记：读取会话最新 assistant 回复，找 📎 交付: 行
        const marked = (() => {
          try {
            const entries = readEntriesFromFile(entry.sm.sessionFile);
            // 只扫本轮新增的 assistant 回复（chatBaseline 之后）——历史交付标记不得重复触发
            for (let i = entries.length - 1; i >= Math.max(chatBaseline, 0); i--) {
              const e = entries[i];
              if (e?.type !== "message" || e?.message?.role !== "assistant") continue;
              const text = extractText(e.message.content) || "";
              const hits = [];
              // 识别多种交付表达：📎 交付: / 交付物：/ 交付文件：/ 已交付 / 生成文件：
              const pats = [
                /📎\s*交付[:：]\s*(.+)/,
                /交付物[:：]?\s*`?([^`\n，。]+\.[a-z0-9]{1,6})`?/i,
                /交付文件[:：]?\s*`?([^`\n，。]+\.[a-z0-9]{1,6})`?/i,
                /(?:已)?交付[:：]?\s*`?([^`\n，。]+\.[a-z0-9]{1,6})`?/i,
              ];
              const seenPaths = new Set();
              for (const line of text.split("\n")) {
                for (const re of pats) {
                  const m = line.match(re);
                  if (!m || !m[1]) continue;
                  let rel = m[1].trim().replace(/[`"'，。、]/g, "").trim();
                  if (!rel) continue;
                  if (seenPaths.has(rel)) continue;
                  seenPaths.add(rel);
                  const safe = wsSafePath(rel);
                  if (safe && fs.existsSync(safe)) {
                    hits.push({
                      name: path.basename(safe),
                      path: rel,
                      size: fs.statSync(safe).size,
                      mime: "",
                      mtimeMs: Date.now(),
                    });
                  }
                }
              }
              if (hits.length) return hits;
            }
            return [];
          } catch { return []; }
        })();
        // 模型有明确交付标记 → 直接用；否则按用户请求关键词+类型智能查找工作空间；再无兜底最近产物
        if (!marked.length) {
          // 用户是否明确要文件（发/给/看/发一下/要文件/找文件）——创作指令（做个/帮我写）不推文件
          const wantFile = /发(个|一下|给我|我)|发我|给我|传我|发文件|找.*文件|要文件|文件.*(发|给|看)|发.*(图片|文件|图|照片)|(?:把|将).*(发|传|给).*我/.test(message);
          if (wantFile) {
          // 从用户请求提取关键词（去掉"发/给/我/一下/的/个/看"等虚词，保留"酒店/ppt/图片"等实词）
          const kwRaw = message.replace(/[发给我你它他她们一下看个这那张张那些最最近做的的了的地得把请帮忙]/g, " ");
          const typeExts = wantImg ? [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"] : wantPpt ? [".ppt", ".pptx"] : wantDoc ? [".doc", ".docx", ".pdf", ".md", ".txt"] : null;
            const found = findWorkspaceFiles({ keyword: kwRaw, types: typeExts });
            files = found.length ? found : scanRecentArtifacts();
          }
          // 不明确要文件（创作/对话）→ 不推任何文件
        } else {
          files = marked;
        }
        // 按用户请求类型过滤（要图只给图，要 ppt 只给 ppt，避免"要图给 PPT"）
        if (files.length && (wantImg || wantPpt || wantDoc)) {
          const extOf = (n) => path.extname(n || "").toLowerCase();
          files = files.filter(f => {
            const e = extOf(f.name);
            if (wantImg) return /^\.(png|jpe?g|gif|webp|bmp|svg)$/.test(e);
            if (wantPpt) return /^\.pptx?$/.test(e);
            if (wantDoc) return /^\.(docx?|pdf|md|txt)$/.test(e);
            return true;
          });
        }
        if (files.length) {
          const sessKey = sessionId || "new";
    globalThis.__yuanshuLastSessionKey = sessKey;
    if (message) lastUserBySession.set(sessKey, String(message).slice(0, 500));
          const pushedSet = pushedArtifacts.get(sessKey) || new Set();
          const fresh = files.filter(f => !pushedSet.has(f.path));
          // 同名去重：同名文件只保留最新一份（避免同一文件从不同目录重复交付）
          {
            const seenName = new Set();
            const deduped = [];
            for (const f of fresh.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))) {
              if (seenName.has(f.name)) continue;
              seenName.add(f.name);
              deduped.push(f);
            }
            fresh.length = 0;
            fresh.push(...deduped);
          }
          if (fresh.length) {
            fresh.forEach(f => pushedSet.add(f.path));
            pushedArtifacts.set(sessKey, pushedSet);
            try {
              const fw = fresh.slice(0, 5).map(f => ({ type: "file", name: f.name, path: f.path, size: f.size, mime: f.mime }));              // ⚠️ 2026-08-19 修复：不再写"（交付文件）"文本标记——模型会把它当回复模板复读（正文全空）；
              //    file 块本身前端就能识别渲染（extractFiles → m.files），无需占位文本。
              await entry.sm.appendMessage({ role: "assistant", content: sdkSafeAssistantBlocks(fw) });
            } catch {}
            files = fresh;
          } else {
            files = [];
          }
        }
      }
      for (const f of files.slice(0, 5)) writer.push("file", f);
    } catch {}
    try {
      // 图片附件：会话里 read 的图直接推给前端渲染（窗口内直接显示）
      const imgs = extractMessageImages(entry.sm);
      for (const img of imgs.slice(0, 3)) writer.push("image", img);
    } catch {}
    // 记忆结算（流水账 / 承诺 / 纠正 / 关系 / 每-N-轮快照计数）已抽成 settleTurnMemory，
    // 在 finally 里对 pi 与 yuanshu 统一执行。原先就写在这个 try 里，于是
    // yuanshu / dsh 路径静默不写记忆，Pi 失败降级到 unified 时也被一起跳过。
    clearTask(taskId, "done");
    try { await mediaDelivered; } catch {}
    if (settledMedia.length) {
      try {
        entry.sm.appendMessage({
          role: "assistant",
          // ⚠️ 必须过 sdkSafeAssistantBlocks：settledMedia 会产出 {type:"image",url} 块，
          // 直接落盘就等于亲手写一条"下次走 pi 通道必崩"的记录（复现见 CHANGELOG 2026-09-16）。
          content: sdkSafeAssistantBlocks(assistantContentWithMedia("", settledMedia)),
        });
      } catch {}
    }
    writer.push("done", { sessionId: sessionId || findKeyByEntry(entry) });
  } catch (e) {
    // 官方 agent 管线异常 → 降级到自制 unifiedChat 兑底（避免任务静默失败）
    const agentErr = String(e?.message || e);
    // 闸门③：一轮出错就解除目标，不带着错误继续转（降级重试属于同一轮）
    if (goalTurn?.ok) noteGoalError(CONFIG.cwd, goalTurn.goal.id, agentErr);
    try { await mediaDelivered; } catch {}
    if (/fetch failed|Failed to fetch/i.test(agentErr)) {
      const netNote = `⚠️ ${explainMediaError(agentErr)}。思考和工具若已开始会保留；出图走旁路，失败不会再挡住主模型。`;
      try { writer.push("note", { text: netNote }); busEmit("note", { text: netNote }); } catch {}
    }
    // 429/额度检测（修复 B）：agent 管线错误里出现 opencode-go 额度耗尽 → 标记降级，后续 Auto 路由避开
    // 2026-08-21 用户理念：429/400 等链接/资源错误 → 主动告知原因 + 通断探测拿好模型顶上
    const briefErr = agentErr.slice(0, 80);
    if (/GoUsageLimit|HTTP 429|status.?429/i.test(agentErr) && modelList.some(m => m.provider === "opencode-go")) {
      markOcGoBlocked(agentErr);
      try { writer.push("note", { text: `⚠️ opencode-go 额度耗尽（429），正在探测可用模型…` }); } catch {}
      // 主动探测：候选链里拿第一个可用的顶上（不靠冷却跳过）
      const cands = [flashCandidate(), routeProCandidate(), defaultModel].filter(Boolean);
      const healthy = await pickHealthyModel(cands).catch(() => null);
      if (healthy) {
        try { writer.push("note", { text: `✅ 探测到可用模型 ${healthy.provider}/${healthy.id}，已切换` }); } catch {}
        console.log(`[元枢] 通断探测 → 好模型顶上: ${healthy.provider}/${healthy.id}`);
      }
    } else if (effModel) {
      // ⚙️ 2026-08-28 修复：原正则只识 "HTTP 429"/"status 429" 格式，漏掉上游直接抛 "429: {...}" 的情况
      // （实测智谱 zai-coding-cn 套餐额度耗尽的真实错误格式）——code=0 永远不命中，冷却一直没被标记，每轮都白撞
      const st = agentErr.match(/HTTP\s*(\d{3})|status.?(\d{3})|^(\d{3}):/);
      const code = st ? parseInt(st[1] || st[2] || st[3], 10) : 0;
      if ([401, 402, 403, 429, 529].includes(code)) {
        markModelBlocked(effModel, { reason: `HTTP ${code} (agent管线)` });
        const reason = code === 429 ? "额度/限流" : code === 400 ? "请求被拒" : "权限/服务问题";
        try { writer.push("note", { text: `⚠️ ${effModel.provider}/${effModel.id} 报 HTTP ${code}（${reason}），正在探测可用模型…` }); } catch {}
        // 主动探测候选链（排除当前坏的），拿到好模型播报
        const cands = [flashCandidate(), routeProCandidate(), pickFallbackExcluding(effModel)].filter(Boolean);
        const healthy = await pickHealthyModel(cands).catch(() => null);
        if (healthy) {
          try { writer.push("note", { text: `✅ 探测到可用模型 ${healthy.provider}/${healthy.id}，已切换` }); } catch {}
          console.log(`[元枢] 通断探测 → 好模型顶上: ${healthy.provider}/${healthy.id}`);
        }
      }
    }
    console.log(`[元枢] agent 通道异常，降级 unifiedChat: ${agentErr.slice(0, 120)}`);
    try { unsubscribe(); } catch {}
    try {
      // 降级前先释放 busy（unifiedChat 会重新接管），并用同代次避免竞态
      if (entry.gen === thisGen) entry.busy = false;
      const abortCtrl2 = new AbortController();
      const onClose2 = () => { try { abortCtrl2.abort(); } catch {} };
      req.on("close", onClose2);
      await handleUnifiedChat(res, entry, message, sessionId || findKeyByEntry(entry), body.params, abortCtrl2.signal, writer, undefined, body.taskKey, null, null, chatRunContext);
      req.removeListener("close", onClose2);
    } catch (e2) {
      try { writer.push("error", { message: `降级通道也失败: ${explainMediaError(e2)}` }); } catch {}
    }
  } finally {
    clearTask(taskId, "done"); // 兜底：任何路径结束都清快照，防残留 running
    clearInterval(hbTimer);
    try { unsubscribe(); } catch {}
    // 代次匹配才释放（快速重发时新请求已占 busy，旧请求不得干扰）
    if (entry.gen === thisGen) entry.busy = false;
    try { await writer.flush(); } catch {} // 背压：确保排队事件写完再关连接，不丢尾事件
    try { writer.close(); } catch {}
    try { res.end(); } catch {}
    if (entry.gen === thisGen) invalidateSessionCache(); // 消息写入会话文件 → 列表缓存失效
    // 记忆结算：pi 成功、以及 pi 失败降级到 unified 之后（此时助手回复由 unified 落盘），
    // 都在这里统一结算一次。放在 res.end() 之后，不拖慢客户端收尾。
    if (entry.gen === thisGen) {
      await settleTurnMemory({ wsRoot: CONFIG.cwd, entry, message, sessionId, bytesBefore: sessionBytesBefore });
    }
  }
}

function findKeyByEntry(entry) {
  for (const [id, e] of activeSessions) if (e === entry) return id;
  return null;
}

/** 台前没带 sessionId 时用它：最近一个会话。单用户桌面下够用。 */
function latestSessionId() {
  try {
    const list = getSessionList() || [];
    const first = list[0] || {};
    return String(first.id || first.sessionId || "");
  } catch { return ""; }
}

// GET /api/sessions/:id/messages
async function handleMessages(res, id, req, url) {
  // findSession 而不是 getSessionList().find：新建会话的文件是懒落盘的，列表缓存可能比它早，
  // 直接查缓存会 404"会话不存在"——前端上传后刷新消息就卡在这里（真机 bug：卡片不显示）。
  const found = findSession(id);
  if (!found || !found.file || !fs.existsSync(found.file)) return json(res, 404, { error: "会话不存在" });
  const entries = readEntriesFromFile(found.file);
  const leafId = resolveLeafId(entries, url?.searchParams?.get("leafId") || null);
  // 带上模型窗口：这样"被上限截断"的提示能说清"上下文占了多少 / 模型声明多少"（2026-09-18）
  const all = extractMessages(entries, leafId, {
    resolveWindow: (id, provider) => {
      // 必须带上 provider：同一个 id 可能挂在多个通道下（glm-5.3-flash 在 zhipu-paid 是 200k 窗口、
      // 在 opencode-go 是 1000k），只按 id 找会说错占比（核对时踩过）。
      const m = modelList.find(x => x.id === id && provider && x.provider === provider)
        || modelList.find(x => x.id === id);
      return m ? { contextWindow: m.contextWindow, maxOutputTokens: m.maxTokens } : null;
    },
  });
  const tailRaw = url?.searchParams?.get("tail");
  const tail = tailRaw == null || tailRaw === "" ? 80 : parseInt(tailRaw, 10);
  const win = windowMessages(all, Number.isFinite(tail) ? tail : 80);
  json(res, 200, { messages: win.messages, leafId, truncated: win.truncated, total: win.total });
}

// POST /api/sessions/:id/messages —— 持久化用户消息到 JSONL（防 network error 丢消息）
async function handleAppendMessage(res, id, body) {
  const found = findSession(id);
  if (!found || !found.file) return json(res, 404, { error: "会话不存在" });
  const file = found.file;
  let parentId = "";
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(lines[i]);
        if (e.type === "message" && e.id) { parentId = e.id; break; }
      } catch {}
    }
  } catch {}
  const entry = {
    type: "message",
    id: Math.random().toString(16).slice(2, 10),
    parentId,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text: String(body.text || body.content || "") }] }
  };
  try {
    fs.appendFileSync(file, JSON.stringify(entry) + "\n");
    invalidateSessionCache();
    json(res, 200, { ok: true, id: entry.id });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
}

// GET /api/stats/global —— 所有会话的 token/成本汇总（直接从会话文件读取 usage）
// ── HTTP 服务器 ────────────────────────────────────────────────────
// 全局错误兜底：未捕获的异步异常不静默退出进程（watchdog 之外的保命层）
process.on("unhandledRejection", (reason) => {
  console.error("[元枢] unhandledRejection:", String(reason?.stack || reason || "").slice(0, 500));
});
process.on("uncaughtException", (err) => {
  try { fs.appendFileSync(path.join(__dirname, "crash.log"), `[${new Date().toLocaleString("zh-CN")}] uncaughtException: ${String(err?.stack || err)}\n`); } catch {}
  console.error("[元枢] uncaughtException:", String(err?.stack || err || "").slice(0, 500));
  // P1 graceful shutdown：异常后不再接新请求，2s 后退出（watchdog 会拉起）
  try { server?.close?.(); } catch {}
  setTimeout(() => process.exit(1), 2000).unref();
});

// ── 路由表（声明式：method + 匹配器 + handler，替代 if/else 链）──
// 匹配器：字符串=精确 pathname；正则=捕获组传给 handler（$1 $2 ...）
// handler 签名：(res, req, url, match, body) => Promise|void
// 工作台独立页映射（workshop.mjs 导出）
// 专项工作台依赖注入：把 server.mjs 内部依赖打包给 workshop.mjs（无反向 import）
function wsCtx() {
  return { CONFIG, SESSIONS_DIR, defaultModel, createSessionAgent, SessionManager, scanRecentArtifacts, sseWrite, json, getAgentDir, DefaultResourceLoader, WS_ROOT, getModelList: () => modelList };
}

// 情绪指示器：返回当前会话情绪快照（前端展示用）
function handleEmotion(res, url) {
  const key = url.searchParams.get("session");
  json(res, 200, key ? emotion.getSnapshot(key) : emotion.getLatestSnapshot());
}

// 全局执行状态：哪些会话的 agent 正在跑（前端状态灯轮询用，含后台/他端发起的执行）
function handleAgentStatus(res) {
  const busy = [];
  for (const [id, e] of activeSessions) {
    if (e.busy) busy.push({ id, since: e.busySince || null });
  }
  json(res, 200, { busy, anyBusy: busy.length > 0 });
}

const RUNS_DIR = path.join(AGENT_DIR, "pi-web-runs");
const RUN_INSTANCE_ID = `${process.pid}-${Date.now().toString(36)}`;
// 被压缩掉的工具结果原件归档到 agent 目录（与 pi-web-runs 同级）——
// 不进用户工作区、不污染生成物，但给出的是**可执行的**回读路径。
initToolResultArchive({ root: path.join(AGENT_DIR, "yuanshu-tool-results") });
// 与 Pi 的写工具共用同一把按文件队列：Pi 的 edit 走 fs/promises，读写之间有真 await，
// 不共用时"元枢 edit"与"Pi edit"打同一文件会交错、后写覆盖前写。
// 外层再套跨进程锁文件（锚在 AGENT_DIR，所有元枢进程默认落到同一处，不 init 也一致）。
initFileLock({ withFileMutationQueue, dir: path.join(AGENT_DIR, "yuanshu-locks") });
console.log(`  🔒 文件写队列: ${usingSharedFileQueue() ? "与 Pi 共用" : "自带实现（未拿到 Pi 的队列）"} · 跨进程锁目录 ${path.join(AGENT_DIR, "yuanshu-locks")}`);
const runStore = createRunStore({ rootDir: RUNS_DIR });
const runEventLog = createRunEventLog({ rootDir: RUNS_DIR });
const runEffects = createRunEffects({ rootDir: RUNS_DIR });
const runManager = createRunManager({
  store: runStore,
  eventLog: runEventLog,
  executeChat: handleChat,
  instanceId: RUN_INSTANCE_ID,
  effects: runEffects,
  // handleChat 返回时 JSONL 已提交；通知会话订阅者刷新侧栏与多端状态。
  onSessionUpdated: ({ run }) => busPush(run.sessionId, "session_updated", { sessionId: run.sessionId }),
});
const recoveredRuns = runManager.recover();
if (recoveredRuns.length) console.log(`[runs] 已将 ${recoveredRuns.length} 个旧实例任务标记为 interrupted`);
const runApi = createRunApi({ manager: runManager, json, readContext: async (run) => ({
  bodyRun: aibodyRuntime.getRun(run.id),
  subagents: await subagent.getSubagentHistory({ sessionId: run.sessionId, runId: run.id, limit: 50 }),
}) });

// 连续创作「原著改编」按书导入：从小说工坊读指定章节（不给就是全书）。
// 放在 server 层而不是编排层：编排层不该知道小说工坊的文件布局，
// 它只要一份 {title, chapters:[{file,title,chars,content}]} 的纯数据。
function readStoryNovelBook({ bookId, files } = {}) {
  const id = String(bookId || '').trim();
  const detail = novelStudio.bookDetail(id);
  if (detail?.error) throw Object.assign(new Error(`读不到这本书：${detail.error}`), { statusCode: 404 });
  const available = Array.isArray(detail.chapters) ? detail.chapters : [];
  if (!available.length) throw Object.assign(new Error('这本书还没有章节，先在小说工坊写一章'), { statusCode: 400 });
  const want = Array.isArray(files) && files.length ? files.map(String) : null;
  const picked = want ? available.filter(c => want.includes(c.file)) : available;
  if (!picked.length) throw Object.assign(new Error('选中的章节不在这本书里'), { statusCode: 400 });
  const chapters = picked.map(c => {
    const read = novelStudio.readChapter(id, c.file);
    const content = read?.error ? '' : String(read.content || '');
    return { file: c.file, title: c.title || c.file, chars: content.length, content };
  });
  return { bookId: id, title: String(detail.meta?.title || ''), chapters };
}

// 每个会话最后一条用户消息（2026-09-18 第二轮）：activate_skill 发生时要知道"这是在回答哪个任务"，
// 而工具执行器拿不到对话上下文——所以在收到消息时就记下来，键与会话一致。
const lastUserBySession = new Map();

// 版本号唯一来源：仓库根 version.json（与系统页同源，别再各读各的）。
const APP_VERSION = (() => {
  try { return String(JSON.parse(fs.readFileSync(path.join(__dirname, "version.json"), "utf8")).version || ""); }
  catch { return ""; }
})();

// 分镜轨迹要落在工作区（不是进程 cwd）：显式注入，免得又写进产品仓库
try { initStoryTrace({ wsRoot: WS_ROOT }); } catch {}

// 做梦用的候选策略表（2026-09-18）：现役 = 当前 MATCH_WEIGHTS；候选只动**权重数字**，
// 不动匹配规则本身（规则是行为契约，改它要人拍板；调权重才是可回放、可比较的部分）。
const DREAM_POLICIES = {
  incumbent: "matcher-current",
  candidates: [
    { id: "matcher-domainx1.5", weights: { ...MATCH_WEIGHTS, video: 6, image: 4.5, ppt: 6, novel: 4.5 } },
    { id: "matcher-name-hit-up", weights: { ...MATCH_WEIGHTS, nameHit: 8, nameToken: 3 } },
    { id: "matcher-concept-up", weights: { ...MATCH_WEIGHTS, concept: 8, discipline: { retro: 8, verify: 7, diag: 7, settle: 7 } } },
    { id: "matcher-desc-down", weights: { ...MATCH_WEIGHTS, descToken: 1 } },
  ],
};

/**
 * 做梦周期（2026-09-18 第三轮）：不再等人点接口。
 * 你上次说得对——"全让我回答，我不是给她打工了吗"：自决的意义就是**它自己会跑**。
 * 这个函数由启动后延迟 + 每 6 小时定时调用一次；有赢家就走授权状（A/B 自决 / C 转人话提案）。
 */
async function runDreamCycle() {
  let files = [];
  try { files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(SESSIONS_DIR, f)); } catch {}
  // ── 增量 + 让出事件循环（2026-09-19）────────────────────────────────────────
  // 原来这里一次性同步读**全部**会话文件再 appendEpisodes：服务启动后 2 分钟的首跑会把事件循环
  // 整段占住（真机实测单次停顿 12.5s，数据更多时到过 82–95s），期间 /api/health 都超时。
  // 现在：只处理"游标之后改动过的会话"，且每 5 个文件 await setImmediate 让出一次。
  const __dreamCursor = path.join(WS_ROOT, "记忆", "运行时", "做梦游标.json");
  let __cursorMs = 0;
  try { __cursorMs = JSON.parse(fs.readFileSync(__dreamCursor, "utf8")).mtimeMs || 0; } catch {}
  let __fresh = [];
  try {
    __fresh = files
      .map((f) => ({ f, m: (() => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } })() }))
      .filter((x) => x.m > __cursorMs)
      .sort((a, b) => a.m - b.m);
  } catch {}
  let __done = 0;
  for (const __it of __fresh) {
    try { appendEpisodes(WS_ROOT, skillEpisodesFromSessions([__it.f])); } catch {}
    __done++;
    if (__done % 5 === 0) await new Promise((r) => setImmediate(r));
  }
  if (__fresh.length) {
    try { fs.writeFileSync(__dreamCursor, JSON.stringify({ mtimeMs: __fresh[__fresh.length - 1].m, at: new Date().toISOString(), files: __fresh.length })); } catch {}
    console.log(`[dream] 增量摄取 ${__fresh.length} 个新会话（游标 ${__cursorMs ? new Date(__cursorMs).toISOString() : "首次全量"}）`);
  }
  const episodes = loadEpisodes(WS_ROOT, { kind: "skill-match" });
  if (!episodes.length) return { ok: false, reason: "还没有历史 episode（在线记录已接上，等真实使用发生）" };
  const skills = loadSkillIndex();
  const active = currentWeights(WS_ROOT);
  const incumbentId = active.id || DREAM_POLICIES.incumbent;
  const incumbentWeights = active.weights || null;
  const maxRank = (ep, policy) => matchSkillsForTask(ep.input, skills, 3, policy.id === incumbentId ? incumbentWeights : policy.weights).map((s) => s.name);
  const result = dream({
    kind: "skill-match", episodes,
    incumbentId,
    candidates: [{ id: DREAM_POLICIES.incumbent, weights: null }, ...DREAM_POLICIES.candidates].filter((c) => c.id !== incumbentId),
    rank: maxRank,
  });
  if (!result.ok) return result;
  writeDreamLog(WS_ROOT, "skill-match", result);
  if (result.winner) {
    const winnerRow = result.table.find((t) => t.id === result.winner);
    const inc = result.table.find((t) => t.role === "incumbent");
    const chosen = DREAM_POLICIES.candidates.find((c) => c.id === result.winner);
    const auth = await grant(
      { kind: "config", text: `把技能匹配权重从 ${incumbentId} 换成 ${result.winner}` },
      {
        replayable: true, episodes: result.episodes,
        noWorse: (winnerRow?.worse || 0) === 0, betterCount: winnerRow?.better || 0,
        reversible: true, scope: "config",
        text: `回放历史准确率 ${inc?.accuracy} → ${winnerRow?.accuracy}`,
      },
      {
        wsRoot: WS_ROOT,
        previous: incumbentId,
        apply: async () => ({ undo: `weights:${incumbentId}`, ...(promoteWeights(WS_ROOT, result.winner, chosen?.weights || {}) || {}) }),
      },
    );
    result.autonomy = auth;
    if (!auth.decided) {
      try {
        recordPromises(WS_ROOT, [{
          id: `d_${Date.now().toString(36)}`, at: new Date().toISOString(), sessionId: "dream",
          text: auth.human?.ask || result.proposal.text, kind: "ask", due: null, status: "pending", evidence: null, closedAt: null,
        }]);
      } catch {}
    } else {
      console.log(`[dream] 自决上线：${auth.message}`);
    }
  } else {
    console.log(`[dream] 回放 ${result.episodes} 条 episode：没有'每条都不更差'的赢家，保持不变`);
  }

  // 第二类：探索策略（"失败后再试几次"）。数据源是当场修/派活落下的轨迹。
  // 这一类同样满足 A/B 级条件（可回放、可回滚、不碰红线），所以赢家自动上线——
  // 这正是"别什么都让我批"要的效果：技术参数自己定，价值判断才找人。
  try {
    const traces = listTraces(WS_ROOT, { limit: 50 }).map((t) => loadTrace(WS_ROOT, t.id)).filter((t) => t?.nodes?.length);
    const cur = currentExplorePolicy(WS_ROOT);
    const ex = replayExploreAcross(traces, { incumbentId: "recorded", incumbent: { retryOnFailure: cur.retryOnFailure } });
    if (!ex.ok) {
      console.log(`[dream] 探索策略：${ex.reason}`);
    } else {
      result.explore = ex;
      if (ex.winner) {
        const row = ex.table.find((t) => t.id === ex.winner);
        const inc = ex.table.find((t) => t.role === "incumbent");
        const chosen = exploreCandidates().find((c) => c.id === ex.winner);
        const auth = await grant(
          { kind: "config", text: `探索策略从「${cur.id}」换成「${ex.winner}」（失败后再试 ${chosen?.retryOnFailure} 次）` },
          { replayable: true, episodes: ex.traces, noWorse: (row?.worse || 0) === 0, betterCount: row?.better || 0, reversible: true, scope: "config", text: `回放 ${ex.traces} 棵轨迹：成本 ${inc?.cost} → ${row?.cost}` },
          { wsRoot: WS_ROOT, previous: cur.id, apply: async () => { const r = promoteExplorePolicy(WS_ROOT, ex.winner, chosen || {}); return { undo: `explore:${cur.id}`, ...r }; } },
        );
        result.exploreAutonomy = auth;
        console.log(`[dream] 探索策略：${auth.decided ? auth.message : "待你拍板：" + (auth.human?.ask || "")}`);
        if (!auth.decided) {
          try {
            recordPromises(WS_ROOT, [{ id: `d_${Date.now().toString(36)}`, at: new Date().toISOString(), sessionId: "dream", text: auth.human?.ask || ex.proposal.text, kind: "ask", due: null, status: "pending", evidence: null, closedAt: null }]);
          } catch {}
        }
      } else {
        console.log(`[dream] 探索策略：回放 ${ex.traces} 棵轨迹，没有'每条都不更差'的赢家，保持不变`);
      }
    }
  } catch (e) {
    console.log(`[dream] 探索策略回放异常: ${String(e?.message || e).slice(0, 140)}`);
  }
  return result;
}

const API_ROUTES = [
  // ── 连续创作编排（阶段一：项目/Story Bible/镜头运行记录）──
  ["GET", "/api/story/projects", (res) => handleStoryProjects({ root: WS_ROOT }, res)],
  ["POST", "/api/story/projects", async (res, req) => handleStoryProjects({ root: WS_ROOT }, res, await readBody(req, 4))],
  ["GET", /^\/api\/story\/projects\/([^/]+)$/, (res, req, url, m) => handleStoryProject({ root: WS_ROOT }, res, m[1])],
  ["PATCH", /^\/api\/story\/projects\/([^/]+)$/, async (res, req, url, m) => handleStoryProjectPatch({ root: WS_ROOT }, res, m[1], await readBody(req, 8))],
  // 删项目：先留一份副本到 story-projects/.trash/（手滑删掉整部戏不可逆）；
  // 产物文件默认不动，deleteFiles=true 时才清，且只清"没有被别处引用"的
  ["DELETE", /^\/api\/story\/projects\/([^/]+)$/, async (res, req, url, m) => handleStoryProjectDelete({ root: WS_ROOT }, res, m[1], await readBody(req, 4))],
  ["POST", /^\/api\/story\/projects\/([^/]+)\/run-preview$/, async (res, req, url, m) => handleStoryRunPreview({ root: WS_ROOT, getDefaultModel: () => defaultModel, getModelList: () => modelList }, res, m[1], await readBody(req, 8))],
  ["POST", /^\/api\/story\/projects\/([^/]+)\/run$/, async (res, req, url, m) => handleStoryRun({ root: WS_ROOT, generateImage, generateVideo, startVideoJob, checkVideoJob, saveArtifact, directChat, getDefaultModel: () => defaultModel, getModelList: () => modelList }, res, m[1], await readBody(req, 8))],
  // 收尾一次（查上游任务号）：视频是异步的，创建与收尾必须分开，不能让一个请求干等
  ["POST", /^\/api\/story\/projects\/([^/]+)\/run-check$/, async (res, req, url, m) => handleStoryRunCheck({ root: WS_ROOT, startVideoJob, checkVideoJob, saveArtifact }, res, m[1], await readBody(req, 8))],
  // 一次收尾多个运行：批量生成挂着 N 个视频任务号，逐个查就是 N 个请求 + N 轮上游问答。
  // 读接口本该比写接口宽松（Lovart 就是这么分档的），合并成一次最省事也最不容易撞限流。
  ["POST", /^\/api\/story\/projects\/([^/]+)\/run-check-many$/, async (res, req, url, m) => handleStoryRunCheckMany({ root: WS_ROOT, startVideoJob, checkVideoJob, saveArtifact }, res, m[1], await readBody(req, 8))],
  ["POST", /^\/api\/story\/projects\/([^/]+)\/assist$/, async (res, req, url, m) => handleStoryAssist({ root: WS_ROOT, directChat, getDefaultModel: () => defaultModel, getModelList: () => modelList }, res, m[1], await readBody(req, 8))],
  // 角色定妆照 / 场景参考图 / 道具参考图：产出可复用的形象与场景资产，写回 bible 对应条目；
  // 后续镜头生成会按"名字出现在提示词里"把参考图当作真实输入注入。
  ["POST", /^\/api\/story\/projects\/([^/]+)\/portrait$/, async (res, req, url, m) => handleStoryPortrait({ root: WS_ROOT, generateImage, saveArtifact, getDefaultModel: () => defaultModel, getModelList: () => modelList }, res, m[1], await readBody(req, 8))],
  ["POST", /^\/api\/story\/projects\/([^/]+)\/asset-ref$/, async (res, req, url, m) => handleStoryAssetRef({ root: WS_ROOT, generateImage, saveArtifact, getDefaultModel: () => defaultModel, getModelList: () => modelList }, res, m[1], await readBody(req, 8))],
  // 连续性体检：只读，把"这次生成能不能保住人物一致性"的条件提前摊开
  ["POST", /^\/api\/story\/projects\/([^/]+)\/lint$/, async (res, req, url, m) => handleStoryLint({ root: WS_ROOT }, res, m[1], await readBody(req, 8))],
  // 一键分镜：从梗概一次生成整场分镜表并追加进项目
  ["POST", /^\/api\/story\/projects\/([^/]+)\/storyboard$/, async (res, req, url, m) => handleStoryStoryboard({ root: WS_ROOT, directChat, getDefaultModel: () => defaultModel, getModelList: () => modelList }, res, m[1], await readBody(req, 16))],
  // 成片合成：按分镜顺序把成功的视频片段拼成长片并落盘为正式产物。
  // 传 saveArtifact 是因为**外链片段要先下载到本地**（本地化契约），ffmpeg 只认本地文件。
  ["POST", /^\/api\/story\/projects\/([^/]+)\/film$/, async (res, req, url, m) => handleStoryFilm({ root: WS_ROOT, saveArtifact, saveArtifactFromFile }, res, m[1], await readBody(req, 8))],
  // 合成前的候选清单（只读）：同一段生成过好几版镜头时，挑哪一版、要哪几段、什么顺序。
  // 带 durations=1 时额外探每一版的时长（要 spawn ffprobe，所以只在时间轴要合计时带上）
  ["GET", /^\/api\/story\/projects\/([^/]+)\/film-plan$/, (res, req, url, m) => handleStoryFilmPlan({ root: WS_ROOT }, res, m[1], { durations: url.searchParams.get('durations') === '1' })],
  // 删掉某一版产出：记录必删，文件只在**没有别处引用**时才删（删文件不可逆，宁可多留）
  ["POST", /^\/api\/story\/projects\/([^/]+)\/run-delete$/, async (res, req, url, m) => handleStoryRunDelete({ root: WS_ROOT }, res, m[1], await readBody(req, 8))],
  // 把某一版还挂在外站的产物下载到本地（本地化契约的重试入口：只补下载，不重新生成）
  ["POST", /^\/api\/story\/projects\/([^/]+)\/run-localize$/, async (res, req, url, m) => handleStoryRunLocalize({ root: WS_ROOT, saveArtifact }, res, m[1], await readBody(req, 8))],
  // 全项目补下载：参考图（定妆照/场景/道具）与每一次生成的产出，一次把外站的东西拉到本地
  ["POST", /^\/api\/story\/projects\/([^/]+)\/localize$/, async (res, req, url, m) => handleStoryLocalizeAll({ root: WS_ROOT, saveArtifact }, res, m[1], await readBody(req, 4))],
  // 原著改编：小说原文/小说工坊章节 → 分集大纲（集+场+段）一次落进项目。
  // preview=true 只读书报字数，不调模型——先看清要花多少钱再决定。
  ["POST", /^\/api\/story\/projects\/([^/]+)\/adapt$/, async (res, req, url, m) => handleStoryAdapt({ root: WS_ROOT, directChat, getDefaultModel: () => defaultModel, getModelList: () => modelList, readNovelBook: readStoryNovelBook }, res, m[1], await readBody(req, 64))],
  // ── 台词与深度构思（用户："人物场景搭上了，对话和构思还是不行"）──
  // 台词体检：纯机检（语速/时长/拆镜），不花模型钱
  ["POST", /^\/api\/story\/projects\/([^/]+)\/dialogue-audit$/, async (res, req, url, m) => handleStoryDialogueAudit({ root: WS_ROOT }, res, m[1], await readBody(req, 4))],
  // 台词诊断与重构：出草稿不落盘（照七维 + 语速标准，每条要 ≥3 条维度依据）
  ["POST", /^\/api\/story\/projects\/([^/]+)\/dialogue-doctor$/, async (res, req, url, m) => handleStoryDialogueDoctor({ root: WS_ROOT, directChat, getDefaultModel: () => defaultModel, getModelList: () => modelList }, res, m[1], await readBody(req, 16))],
  // 深度构思：情绪契约 / 人物四件套 / 矛盾单元 / 分集地图 / 因果节拍 / 四账台账（出草稿不落盘）
  ["POST", /^\/api\/story\/projects\/([^/]+)\/story-engine$/, async (res, req, url, m) => handleStoryEngine({ root: WS_ROOT, directChat, getDefaultModel: () => defaultModel, getModelList: () => modelList }, res, m[1], await readBody(req, 16))],
  ["POST", /^\/api\/story\/projects\/([^/]+)\/craft$/, async (res, req, url, m) => handleStoryCraftSave({ root: WS_ROOT }, res, m[1], await readBody(req, 64))],
  // 构思体检（只读）：已保存的构思也要能随时体检，而不是只在生成/保存之后
  ["POST", /^\/api\/story\/projects\/([^/]+)\/craft-audit$/, async (res, req, url, m) => handleStoryCraftAudit({ root: WS_ROOT }, res, m[1], await readBody(req, 4))],
  ["POST", /^\/api\/story\/projects\/([^/]+)\/episode-map$/, async (res, req, url, m) => handleStoryEpisodeMapApply({ root: WS_ROOT }, res, m[1], await readBody(req, 16))],
  // 分集：短剧/系列内容的组织单位（场用 episodeId 归属；删集只解绑不删场）
  ["GET", /^\/api\/story\/projects\/([^/]+)\/episodes$/, (res, req, url, m) => handleStoryEpisodes({ root: WS_ROOT }, res, m[1])],
  ["POST", /^\/api\/story\/projects\/([^/]+)\/episodes$/, async (res, req, url, m) => handleStoryEpisodeAdd({ root: WS_ROOT }, res, m[1], await readBody(req, 8))],
  ["PATCH", /^\/api\/story\/projects\/([^/]+)\/episodes$/, async (res, req, url, m) => handleStoryEpisodeUpdate({ root: WS_ROOT }, res, m[1], await readBody(req, 8))],
  ["POST", /^\/api\/story\/projects\/([^/]+)\/episodes\/remove$/, async (res, req, url, m) => handleStoryEpisodeRemove({ root: WS_ROOT }, res, m[1], await readBody(req, 8))],
  ["POST", /^\/api\/story\/projects\/([^/]+)\/scene-assign$/, async (res, req, url, m) => handleStorySceneAssign({ root: WS_ROOT }, res, m[1], await readBody(req, 8))],
  // 剧本要素统计 + 导出（中文剧本 / Fountain / Final Draft FDX）
  ["GET", /^\/api\/story\/projects\/([^/]+)\/script-stats$/, (res, req, url, m) => handleStoryScriptStats({ root: WS_ROOT }, res, m[1])],
  ["POST", /^\/api\/story\/projects\/([^/]+)\/script-export$/, async (res, req, url, m) => handleStoryExportScript({ root: WS_ROOT }, res, m[1], await readBody(req, 4))],
  // 与角色对台词（Laper 的 Playground）：检验台词像不像这个人
  ["POST", /^\/api\/story\/projects\/([^/]+)\/playground$/, async (res, req, url, m) => handleStoryPlayground({ root: WS_ROOT, directChat, getDefaultModel: () => defaultModel, getModelList: () => modelList }, res, m[1], await readBody(req, 8))],
  ["POST", /^\/api\/story\/projects\/([^/]+)\/playground-clear$/, async (res, req, url, m) => handleStoryPlaygroundClear({ root: WS_ROOT }, res, m[1], await readBody(req, 4))],
  // 创作方法包（Skill）：程序性知识，跨项目共用（与配方同级，所以挂在 /api/story/methods）
  ["GET", "/api/story/methods", (res) => handleStoryMethods({ root: WS_ROOT }, res)],
  ["POST", "/api/story/methods", async (res, req) => handleStoryMethods({ root: WS_ROOT }, res, await readBody(req, 16))],
  ["DELETE", /^\/api\/story\/methods\/([^/]+)$/, (res, req, url, m) => handleStoryMethodDelete({ root: WS_ROOT }, res, m[1])],
  // 把这个项目跑通的打法存成方法包 / 把某个方法包套用到项目
  ["POST", /^\/api\/story\/projects\/([^/]+)\/method-capture$/, async (res, req, url, m) => handleStoryMethodCapture({ root: WS_ROOT }, res, m[1], await readBody(req, 16))],
  ["POST", /^\/api\/story\/projects\/([^/]+)\/method$/, async (res, req, url, m) => handleStoryMethodApply({ root: WS_ROOT }, res, m[1], await readBody(req, 8))],
  // 生成配方（可存/可套用/可导出导入的生成设置）——挂在 /api/story/recipes，与项目平级，因为它跨项目
  ["GET", "/api/story/recipes", (res) => handleStoryRecipes({ root: WS_ROOT }, res)],
  ["GET", "/api/story/recipes/export", (res) => handleStoryRecipesExport({ root: WS_ROOT }, res)],
  ["POST", "/api/story/recipes", async (res, req) => handleStoryRecipes({ root: WS_ROOT }, res, await readBody(req, 4))],
  ["POST", "/api/story/recipes/import", async (res, req) => handleStoryRecipesImport({ root: WS_ROOT }, res, await readBody(req, 4))],
  ["DELETE", /^\/api\/story\/recipes\/([^/]+)$/, (res, req, url, m) => handleStoryRecipeDelete({ root: WS_ROOT }, res, m[1])],
  // ── 会话数据库（08-29 真落地：编号/健康度/批量清理；必须先于 :id 正则路由）──
  ["GET", "/api/sessions/db/list", (res) => handleDbList(res)],
  ["GET", "/api/sessions/db/stats", (res) => handleDbStats(res)],
  ["POST", "/api/sessions/db/rebuild", (res) => handleDbRebuild(res)],
  // ── 跨会话回忆（Hermes 闭环第三件）──
  ["POST", "/api/recall/rebuild", (res) => json(res, 200, rebuildIndex())],
  ["GET", "/api/recall", (res, req, url) => handleRecall(res, url)],
  ["POST", "/api/recall/ask", async (res, req) => { const b = await readBody(req); return handleRecallAsk(res, b); }],
  ["GET", "/api/recall/summaries", (res) => handleSummaries(res)],
  ["POST", "/api/recall/summarize", (res) => { buildSummaries({ count: 5 }).catch(() => {}); return json(res, 200, { ok: true, started: true }); }],
  ["GET", "/api/recall/stats", (res) => json(res, 200, recallStats())],
  ["POST", "/api/sessions/db/sanitize", async (res, req) => handleDbSanitize(res, await readBody(req))],
  ["PATCH", "/api/sessions/db/meta", async (res, req) => handleDbMeta(res, await readBody(req))],
  ["POST", "/api/sessions/db/sweep", async (res, req) => handleDbSweep(res, await readBody(req))],
  // ── 会话 ──
  ["GET", "/api/emotion", (res, req, url) => handleEmotion(res, url)],
  ["GET", "/api/run/overview", (res, req, url) => runApi.overview(res, req, url)],
  ["GET", "/api/emotion/tide", (res) => json(res, 200, { tide: emotion.getTide(300) })],
  ["GET", "/api/emotion/feelings", (res) => json(res, 200, { feelings: emotion.getFeelings(50) })],
  ["GET", "/api/agent-status", (res) => handleAgentStatus(res)],
  // ── 记忆园丁：只报告记忆健康（重复/过时/膨胀），不自动写记忆（防污染）──
  ["GET", "/api/memory-gardener", (res) => json(res, 200, { ...gardenMemory(WS_ROOT), report: { ...scanMemoryHealth(WS_ROOT), reviewed: reviewedKeys(WS_ROOT) }, rhythm: readActivityRhythm(WS_ROOT, { now: new Date(), sessionDir: SESSIONS_DIR }) })],
  // ── 承诺兑现：模型自己许下但没结清的事。台前与提示词读同一份账 ──
  ["GET", "/api/promises", (res) => {
    const now = new Date();
    const pending = pendingPromises(WS_ROOT, { now }).map(({ id, text, at, due, sessionId, age }) => ({
      id, text, at, due, sessionId, agePhrase: age.phrase, overdue: age.overdue,
    }));
    const closed = loadPromises(WS_ROOT)
      .filter((p) => p.status !== "pending")
      .slice(-20).reverse()
      .map(({ id, text, at, status, evidence, closedAt }) => ({ id, text, at, status, evidence, closedAt }));
    json(res, 200, { ok: true, pending, closed });
  }],
  ["POST", "/api/promises/close", async (res, req) => {
    const b = await readBody(req);
    if (!b?.id) return json(res, 400, { error: "缺少 id" });
    // 结清只能由人给结论；这里不接受任何自动判定，也没有定时任务会调它
    const r = closePromise(WS_ROOT, String(b.id), { status: b.status === "dropped" ? "dropped" : "kept", evidence: b.evidence || null });
    json(res, r?.ok ? 200 : 400, r);
  }],
  // 做梦用的候选策略表（2026-09-18）：现役 = 当前 MATCH_WEIGHTS；候选只动**权重数字**，
  // 不动匹配规则本身（规则是行为契约，改它要人拍板；调权重才是可回放、可比较的部分）。
  // 表本身声明在文件顶部（DREAM_POLICIES），这里只挂路由。

// ── 做梦（2026-09-18）：拿历史当模拟器，离线评估"要不要改" ──
  // 第一片可做梦的搜索空间是技能匹配器的权重表（输入=当时的任务句，真值=当时真的 activate 了哪个技能）。
  ["GET", "/api/dream/status", (res) => {
    const skillEps = loadEpisodes(WS_ROOT, { kind: "skill-match" });
    let logTail = "";
    try { logTail = fs.readFileSync(dreamPaths(WS_ROOT).log, "utf8").split("\n").slice(-40).join("\n"); } catch {}
    json(res, 200, {
      ok: true,
      kinds: [{ kind: "skill-match", episodes: skillEps.length, incumbent: DREAM_POLICIES.incumbent, candidates: DREAM_POLICIES.candidates.map((c) => c.id) }],
      lastEpisodes: skillEps.slice(-5).map((e) => ({ at: e.at, input: String(e.input).slice(0, 60), choice: e.choice })),
      logTail,
    });
  }],
  ["POST", "/api/dream/collect", async (res) => {
    // 回填：把会话文件里"当时真的 activate 了哪个技能"挖出来做成 episode
    let files = [];
    try { files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(SESSIONS_DIR, f)); } catch {}
    const eps = skillEpisodesFromSessions(files);
    const r = appendEpisodes(WS_ROOT, eps);
    json(res, 200, { ok: true, scanned: files.length, found: eps.length, added: r?.added || 0 });
  }],
  ["POST", "/api/dream/run", async (res) => {
    // 与定时器共用同一份逻辑（runDreamCycle），不重复实现第二遍
    json(res, 200, await runDreamCycle());
  }],
  // ── 运行时实例（2026-09-18）：有几份在跑、谁持有端口、最近几次启动成没成 ──
  ["GET", "/api/system/instances", (res) => {
    // 用"这次请求落在谁身上"校正心跳里的自称——登记不许说谎（详见 reconcileInstances）
    const rec = reconcileInstances(liveInstances(WS_ROOT, {}), { servingPid: process.pid });
    json(res, 200, {
      ok: true,
      me: { pid: process.pid, version: String(APP_VERSION), port: CONFIG.port },
      live: rec.list.map((x) => ({ pid: x.pid, version: x.version, port: x.port, ownsPort: x.ownsPort, staleClaim: x.staleClaim, startedAt: x.startedAt, ageMs: x.ageMs })),
      owner: rec.owner,
      ownerNote: rec.note,
      staleClaims: rec.staleClaims,
      recentStartups: recentStartups(WS_ROOT, { limit: 10 }),
    });
  }],
  // ── 探索轨迹（2026-09-18）：把"试了哪些路、花了多少、结果如何"记成可回放的树 ──
  // 做梦的头一版只能回放"选哪个技能"，因为探索过程没留下结构化轨迹；这一版补上那一半。
  ["GET", "/api/trace/status", (res) => {
    const traces = listTraces(WS_ROOT, { limit: 50 });
    json(res, 200, { ok: true, count: traces.length, recent: traces.slice(0, 10) });
  }],
  ["POST", "/api/trace/replay", async (res, req) => {
    // 在**已记录的轨迹**上回放候选探索策略（现役 = 当时真这么做的那条）：
    // 只有"每条轨迹都不更差、且至少一条更省"才算赢——与技能那版同一套规矩。
    const b = await readBody(req).catch(() => ({}));
    const ids = Array.isArray(b?.ids) ? b.ids : listTraces(WS_ROOT, { limit: 50 }).map((t) => t.id);
    const traces = ids.map((id) => loadTrace(WS_ROOT, id)).filter(Boolean);
    const result = replayAcrossTraces(traces, candidatePolicies(), { incumbentId: "recorded" });
    json(res, 200, { ...result, tracesUsed: traces.length });
  }],
  // ── 授权状（2026-09-18）：元枢自己判断"这件事我能不能自己定" ──
  ["GET", "/api/autonomy", (res) => {
    json(res, 200, {
      ok: true,
      charter: loadCharter(WS_ROOT),
      usedToday: autoUsedToday(WS_ROOT),
      activeWeights: currentWeights(WS_ROOT),
      explorePolicy: currentExplorePolicy(WS_ROOT),
      recent: loadLedger(WS_ROOT).slice(-10).reverse(),
    });
  }],
  ["POST", "/api/autonomy/revoke", async (res, req) => {
    const b = await readBody(req);
    const r = await revoke(WS_ROOT, {
      at: b?.at || null,
      revert: async (row) => {
        // 撤销点：优先回到记录里的上一版；没有就清掉覆盖，回到代码里的默认。
        // undo 有两类前缀：weights:* 是技能权重，explore:* 是探索策略（"失败后再试几次"）。
        const raw = String(row?.undo || "");
        const back = raw.replace(/^(weights|explore):/, "");
        const cand = raw.startsWith("explore:") ? null : DREAM_POLICIES.candidates.find((c) => c.id === back);
        if (cand) return promoteWeights(WS_ROOT, cand.id, cand.weights);
        const ex = exploreCandidates().find((c) => c.id === back);
        if (ex) return promoteExplorePolicy(WS_ROOT, ex.id, ex);
        return raw.startsWith("explore:") ? resetExplorePolicy(WS_ROOT) : resetWeights(WS_ROOT);
      },
    });
    json(res, r.ok ? 200 : 400, r);
  }],
  // ── 会话级沙箱模式：append-only 日志 + fold，收紧随时可以、放宽必须给理由 ──
  // ── 会话级沙箱模式：append-only 日志 + fold，收紧随时可以、放宽必须给理由 ──
  ["GET", "/api/sandbox/mode", (res, req, url) => {
    const sid = url?.searchParams?.get("session") || latestSessionId();
    json(res, 200, { ok: true, sessionId: sid, ...sandboxModeView(AGENT_DIR, sid) });
  }],
  ["POST", "/api/sandbox/mode", async (res, req) => {
    const b = await readBody(req);
    const sid = b?.sessionId || latestSessionId();
    if (!sid) return json(res, 400, { error: "没有可用的会话" });
    // 只可能来自台前点击，所以来源固定记 human
    const r = recordSandboxMode(AGENT_DIR, sid, { preset: b?.preset, origin: "human", reason: b?.reason });
    json(res, r?.ok ? 200 : 400, { ...r, sessionId: sid, view: r?.ok ? sandboxModeView(AGENT_DIR, sid) : null });
  }],
  // ── 跨轮目标：三重闸门在 engine/goals.mjs；台前只做"人类给结论"这一侧 ──
  ["GET", "/api/goals", (res) => {
    const all = listGoals(WS_ROOT);
    const active = all.find((g) => g.status === "active") || null;
    json(res, 200, { ok: true, active, goals: all.map(({ id, objective, status, round, maxRounds, autoAdvance, evidence, blockedReason, updatedAt }) => ({ id, objective, status, round, maxRounds, autoAdvance, evidence, blockedReason, updatedAt })) });
  }],
  ["POST", "/api/goals/create", async (res, req) => {
    const b = await readBody(req);
    const r = createGoal(WS_ROOT, { objective: b?.objective, maxRounds: b?.maxRounds, autoAdvance: b?.autoAdvance });
    json(res, r?.ok ? 200 : 400, r);
  }],
  ["POST", "/api/goals/action", async (res, req) => {
    const b = await readBody(req);
    if (!b?.id || !b?.action) return json(res, 400, { error: "缺少 id/action" });
    // 武装与结清都标记 origin: "human"——它们只可能来自台前的人工点击，
    // 没有任何服务端路径会自己调这两个（模型要结清必须由人确认）。
    const map = {
      arm: () => armGoal(WS_ROOT, String(b.id), { origin: "human", autoAdvance: b.autoAdvance ?? null }),
      pause: () => pauseGoal(WS_ROOT, String(b.id), { origin: "human" }),
      complete: () => settleGoal(WS_ROOT, String(b.id), { status: "complete", origin: "human", evidence: b.evidence }),
      block: () => settleGoal(WS_ROOT, String(b.id), { status: "blocked", origin: "human", reason: b.reason, evidence: b.evidence }),
    };
    const fn = map[String(b.action)];
    if (!fn) return json(res, 400, { error: "action 只能是 arm/pause/complete/block" });
    const r = fn();
    json(res, r?.ok ? 200 : 400, r);
  }],
  ["POST", "/api/memory-gardener/reviewed", async (res, req) => {
    const b = await readBody(req);
    if (!b?.kind || !b?.key) return json(res, 400, { error: "缺少 kind/key" });
    const items = b.unmark ? unmarkReviewed(WS_ROOT, b.kind, b.key) : markReviewed(WS_ROOT, b.kind, b.key);
    json(res, 200, { ok: true, items });
  }],
  ["POST", "/api/memory-gardener/dedupe", (res) => {
    const r = dedupeLog(WS_ROOT);
    json(res, 200, { ok: true, ...r });
  }],
  ["POST", "/api/memory/upsert", async (res, req) => {
    const b = await readBody(req);
    return json(res, 200, upsertMemoryFact(WS_ROOT, b || {}));
  }],
  // ── 记忆快照：此前只有写入方、没有任何读取方（restoreSnapshot 零调用、无端点、前端零引用），
  //    攒了 98.7MB 却一份都回退不了。补上列表 + 回退，让快照真正成为可用的安全网。──
  ["GET", "/api/memory/snapshots", (res) => {
    const names = memoryApi.listSnapshots(WS_ROOT);
    const dir = memoryApi.snapshotPaths(WS_ROOT).dir;
    const items = names.slice(0, 50).map((f) => {
      let reason = "", timestamp = "", bytes = 0;
      try {
        const full = path.join(dir, f);
        bytes = fs.statSync(full).size;
        // id/reason/timestamp 排在 JSON 最前面，读文件头即可；列表不能把上百 MB 全读进来
        const fd = fs.openSync(full, "r");
        const buf = Buffer.alloc(320);
        const n = fs.readSync(fd, buf, 0, 320, 0);
        fs.closeSync(fd);
        const head = buf.subarray(0, n).toString("utf8");
        reason = (head.match(/"reason"\s*:\s*"([^"]*)"/) || [])[1] || "";
        timestamp = (head.match(/"timestamp"\s*:\s*"([^"]*)"/) || [])[1] || "";
      } catch {}
      return { id: f.replace(/\.json$/, ""), reason, timestamp, bytes };
    });
    json(res, 200, { ok: true, total: names.length, items });
  }],
  ["POST", "/api/memory/snapshot/restore", async (res, req) => {
    const b = await readBody(req);
    if (!b?.id) return json(res, 400, { error: "缺少 id" });
    // 回退本身就是危险动作：先把现状留一份，避免"回退错了再也回不来"
    try { memoryApi.saveSnapshot(WS_ROOT, "pre-restore"); } catch {}
    const r = memoryApi.restoreSnapshot(WS_ROOT, String(b.id));
    try { memoryApi.pruneSnapshots(WS_ROOT); } catch {}
    json(res, r?.ok ? 200 : 400, r);
  }],
  ["GET", "/api/theme-prefs", (res) => json(res, 200, loadThemePrefs())],
  ["POST", "/api/theme-prefs", async (res, req) => { const b = await readBody(req, 12); return json(res, 200, saveThemePrefs(b || {})) }],
  ["GET", "/api/color-prefs", (res) => json(res, 200, loadColorPrefs())],
  ["POST", "/api/color-prefs", async (res, req) => { const b = await readBody(req, 12); return json(res, 200, saveColorPrefs(b || {})) }],
  ["GET", "/api/system/info", (res) => json(res, 200, buildSystemInfo(WS_ROOT, AGENT_DIR))],
  ["POST", "/api/system/network", async (res, req) => {
    const b = await readBody(req);
    const r = saveNetworkConfig(AGENT_DIR, b);
    if (r.error) return json(res, 400, { error: r.error });
    json(res, 200, { ok: true, domains: r.domains });
  }],
  ["GET", "/api/system/check-update", async (res) => json(res, 200, await checkUpdate(__dirname))],
  // ── 灵犀：双向灵感池（user/xiaoyu 分源记录，攒着一起过）──
  ["GET", "/api/lingxi", (res, req, url) => {
    const source = url.searchParams.get("source") || undefined;
    const status = url.searchParams.get("status") || undefined;
    return json(res, 200, { entries: listLingXi(WS_ROOT, { source, status }) });
  }],
  ["POST", "/api/lingxi", async (res, req) => {
    const b = await readBody(req);
    const r = addLingXi(WS_ROOT, { text: b?.text, source: b?.source, note: b?.note });
    if (r.error) return json(res, 400, { error: r.error });
    json(res, 200, r);
  }],
  ["PATCH", /^\/api\/lingxi\/([\w-]+)$/, async (res, req, url, m) => {
    const b = await readBody(req);
    const e = setLingXi(WS_ROOT, m[1], { status: b?.status, note: b?.note, target: b?.target, artifact: b?.artifact });
    if (!e) return json(res, 404, { error: "灵感不存在或状态非法" });
    json(res, 200, { ok: true, entry: e });
  }],
  ["DELETE", /^\/api\/lingxi\/([\w-]+)$/, (res, req, url, m) => {
    const ok = removeLingXi(WS_ROOT, m[1]);
    if (!ok) return json(res, 404, { error: "灵感不存在" });
    json(res, 200, { ok: true });
  }],
  // ── 人格基因 + 提案制进化 ──
  ["GET", "/api/genome", (res) => json(res, 200, emotion.getGenome())],
  ["POST", "/api/genome/propose", async (res, req) => {
    const b = await readBody(req);
    const p = emotion.proposeBaselineChange(b?.gene, b?.value, b?.reason, b?.evidence);
    if (!p) return json(res, 400, { error: "提案无效（基因不存在或变化太小）" });
    json(res, 200, { ok: true, proposal: p });
  }],
  ["POST", "/api/genome/approve", async (res, req) => {
    const b = await readBody(req);
    json(res, 200, emotion.approveProposal(b?.proposal_id, b?.reviewer || "operator"));
  }],
  ["POST", "/api/genome/reject", async (res, req) => {
    const b = await readBody(req);
    json(res, 200, emotion.rejectProposal(b?.proposal_id, b?.reviewer || "operator", b?.reason));
  }],
  ["POST", "/api/genome/rollback", async (res, req) => {
    const b = await readBody(req);
    json(res, 200, emotion.rollbackSnapshot(b?.snapshot_id));
  }],
  ["POST", "/api/genome/auto", async (res) => json(res, 200, { proposals: emotion.autoProposeFromDrift() })],
  // ── 技能基因 ──
  ["GET", "/api/skill-genes", (res) => json(res, 200, emotion.getSkillGenes())],
  ["POST", "/api/skill-genes/feedback", async (res, req) => {
    const b = await readBody(req);
    const domain = b?.domain || emotion.detectSkillDomain(b?.text || "");
    const updated = emotion.updateSkillGene(domain, { success: b?.success, efficiency: b?.efficiency, reliability: b?.reliability, adaptability: b?.adaptability });
    json(res, 200, { ok: true, domain, genes: updated });
  }],
  // ── P3 资产路由：任务 → 技能自动匹配 ──
  ["GET", "/api/skill-router", (res, req, url) => json(res, 200, { skills: emotion.routerSkill(url.searchParams.get("text") || "", 3) })],
  // ── P2 隔离子任务执行器（多 agent）──
  ["POST", "/api/subagent", async (res, req) => {
    const b = await readBody(req);
    if (!b?.task) return json(res, 400, { error: "缺 task 参数" });
    const r = await subagent.spawnSubagent({ task: b.task, context: b.context || [] });
    json(res, 200, r);
  }],
  ["GET", /^\/api\/sessions\/([^/]+)\/tree$/, (res, req, url, m) => handleSessionTree(res, decodeURIComponent(m[1]))],
  ["POST", /^\/api\/sessions\/([^/]+)\/branch$/, async (res, req, url, m) => handleSessionBranch(res, decodeURIComponent(m[1]), await readBody(req))],
  ["GET", /^\/api\/sessions\/([^/]+)\/messages$/, (res, req, url, m) => handleMessages(res, decodeURIComponent(m[1]), req, url)],
  ["POST", /^\/api\/sessions\/([^/]+)\/messages$/, async (res, req, url, m) => handleAppendMessage(res, decodeURIComponent(m[1]), await readBody(req))],
  ["GET", /^\/api\/sessions\/([^/]+)\/stream$/, (res, req, url, m) => handleSessionStream(res, req, url, m[1])],
  ["GET", /^\/api\/sessions\/([^/]+)\/stats$/, (res, req, url, m) => handleStats(res, decodeURIComponent(m[1]))],
  ["POST", /^\/api\/sessions\/([^/]+)\/compact$/, (res, req, url, m) => handleCompact(res, decodeURIComponent(m[1]))],
  ["POST", /^\/api\/sessions\/([^/]+)\/rename$/, async (res, req, url, m) => handleRename(res, decodeURIComponent(m[1]), await readBody(req))],
  ["DELETE", /^\/api\/sessions\/([^/]+)$/, async (res, req, url, m) => { await deleteSession(decodeURIComponent(m[1])); return json(res, 200, { ok: true }); }],
  ["GET", /^\/api\/sessions\/([^/]+)\/export$/, (res, req, url, m) => handleExport(res, decodeURIComponent(m[1]), url.searchParams.get("format") || "html")],
  ["GET", "/api/stats/global", (res) => handleGlobalStats(res)],
  ["GET", "/api/improvements", (res) => json(res, 200, { improvements: openImprovements(), diagnostics: getImprovementDiagnostics() })],
  ["POST", "/api/improvements/analyze", (res) => json(res, 200, { improvements: analyzeImprovements(), diagnostics: getImprovementDiagnostics() })],
  ["POST", /^\/api\/improvements\/([^/]+)\/status$/, async (res, req, url, m) => json(res, 200, setImprovementStatus(decodeURIComponent(m[1]), (await readBody(req)).status || "dismissed"))],
  ["GET", "/api/stats/providers", (res) => handleProviderStats(res)],
  ["GET", "/api/stats/daily", (res) => handleDailyStats(res)],
  ["GET", "/api/subagent/runs", (res) => handleSubagentRuns(res)],
  ["GET", "/api/subagent/history", (res) => handleSubagentHistory(res)],
  // ── 进化引擎（09-03）：反思式进化提案 + 人工审批写回 ──
  ["GET", "/api/evolution/proposals", (res) => json(res, 200, { proposals: listEvolution() })],
  ["POST", "/api/evolution/propose", async (res, req) => { const b = await readBody(req); return json(res, 200, await proposeEvolution({ name: b.name, model: defaultModel })); }],
  ["POST", "/api/evolution/apply", async (res, req) => { const b = await readBody(req); return json(res, 200, applyEvolution(b.id, b.variantIndex || 0)); }],
  ["POST", "/api/evolution/dismiss", async (res, req) => { const b = await readBody(req); return json(res, 200, dismissEvolution(b.id)); }],
  ["POST", "/api/evolution/evaluate", async (res, req) => { const b = await readBody(req); evaluateProposal(b.id, defaultModel).catch(() => {}); return json(res, 200, { ok: true, started: true }); }],
  // ── 技能自主沉淀（Hermes 闭环）──
  ["GET", "/api/skillnudge/list", (res) => json(res, 200, { nudges: listSkillNudges() })],
  ["POST", "/api/skillnudge/apply", async (res, req) => { const b = await readBody(req); return json(res, 200, applySkillNudge(b.id)); }],
  ["POST", "/api/skillnudge/dismiss", async (res, req) => { const b = await readBody(req); return json(res, 200, dismissSkillNudge(b.id)); }],
  // ── 记忆 nudge（情绪→记忆联动）──
  ["GET", "/api/memorynudge/list", (res) => json(res, 200, { nudges: listMemoryNudges() })],
  ["POST", "/api/memorynudge/apply", async (res, req) => { const b = await readBody(req); return json(res, 200, applyMemoryNudge(b.id)); }],
  ["POST", "/api/memorynudge/dismiss", async (res, req) => { const b = await readBody(req); return json(res, 200, dismissMemoryNudge(b.id)); }],
  // ── 记忆进化压缩（EvoX MemoryOptimizer 思想）──
  ["GET", "/api/memcompress/analyze", (res) => json(res, 200, analyzeMemoryCompress())],
  ["POST", "/api/memcompress/propose", (res) => json(res, 200, proposeMemoryCompress(defaultModel))],
  ["GET", "/api/memcompress/list", (res) => json(res, 200, { proposals: listMemoryCompress() })],
  ["POST", "/api/memcompress/apply", async (res, req) => { const b = await readBody(req); return json(res, 200, applyMemoryCompress(b.id)); }],
  ["POST", "/api/memcompress/dismiss", async (res, req) => { const b = await readBody(req); return json(res, 200, dismissMemoryCompress(b.id)); }],
  ["GET", "/api/sessions", (res) => json(res, 200, { sessions: getSessionList().filter(s => isListedGroup(s.group)) })],
  // 批准后的回写（2026-09-19）：这条是**人**的通道——agent 工具只能落草案区，落地走这里。
  // 校验通过才写；写前留 .bak-apply，写后审计一行到 记忆/授权记录.jsonl，并同步 APPEND_SYSTEM.md 的人格块。
  ["POST", "/api/persona/apply", async (res, req) => {
    const body = await readBody(req);
    const incoming = body?.definition && typeof body.definition === "object" ? body.definition : null;
    if (!incoming) return json(res, 400, { error: "缺 definition" });
    const cur = loadPersonaDefinition(CONFIG.cwd);
    const next = { ...cur.def, ...incoming, setBy: String(body.by || "human"), updatedAt: new Date().toISOString() };
    const problems = (await import("./engine/persona-def.mjs")).validatePersonaDefinition(next);
    if (problems.length) return json(res, 400, { error: "定义不合法: " + problems.join("；"), problems });
    const file = personaFilePath(CONFIG.cwd);
    try {
      if (fs.existsSync(file)) fs.writeFileSync(file + ".bak-apply", fs.readFileSync(file, "utf8"), "utf8");
      fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n", "utf8");
    } catch (e) { return json(res, 500, { error: String(e?.message || e).slice(0, 120) }); }
    // 审计留痕：谁在什么时候把定义改成了什么（只记关键字段，不写全文）
    try {
      fs.appendFileSync(path.join(CONFIG.cwd, "记忆", "授权记录.jsonl"), JSON.stringify({ at: new Date().toISOString(), kind: "persona-apply", by: next.setBy, changed: Object.keys(incoming), name: next.name, age: next.age }) + "\n", "utf8");
    } catch {}
    let synced = null;
    try { synced = syncAppendSystemPersona(next, { agentDir: getAgentDir() }); } catch {}
    return json(res, 200, { ok: true, definition: next, synced: !!synced?.ok, changed: !!synced?.changed });
  }],

  // 木偶部件标注存盘（2026-09-19）：标注页 /static/label.html 点"保存"走这里，
  // 落到 工程/小语木偶/labels.json，随后 `node scripts/puppet-build.mjs` 切成件 + 生成骨骼。
  ["POST", "/api/puppet/labels", async (res, req) => {
    const body = await readBody(req);
    const parts = Array.isArray(body?.parts) ? body.parts : null;
    if (!parts || !parts.length) return json(res, 400, { error: "缺 parts" });
    const dir = path.join(CONFIG.cwd, "工程", "小语木偶");
    const file = path.join(dir, "labels.json");
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ ...body, savedAt: new Date().toISOString() }, null, 2), "utf8");
    } catch (e) { return json(res, 500, { error: String(e?.message || e).slice(0, 120) }); }
    return json(res, 200, { ok: true, file, parts: parts.length });
  }],
  // 天团取正文（2026-09-20）：/api/think 返回的是**思考文本**（真机抓到的是英文内心独白），
  // 角色要的是 assistant 的**正文**，所以走 directChat（它把 text 与 think 分开返回）。
  ["POST", "/api/team/complete", async (res, req) => {
    const body = await readBody(req, 12);
    const provider = String((body && body.provider) || "");
    const modelId = String((body && body.modelId) || "");
    const message = String((body && body.message) || "");
    if (!provider || !modelId || !message) return json(res, 400, { error: "provider/modelId/message 必填" });
    const maxTokens = Number(body && body.maxTokens) > 0 ? Number(body.maxTokens) : undefined;
    try {
      const r = await directChat({ provider, id: modelId }, message, [], maxTokens ? { maxTokens } : {});
      if (!r) return json(res, 502, { error: "模型调用失败（渠道/密钥/超时）" });
      return json(res, 200, { text: String(r.text || ""), thinkLen: String(r.think || "").length, note: r.text ? "ok" : "只有思考、没有正文" });
    } catch (e) { return json(res, 500, { error: String(e && e.message || e).slice(0, 120) }); }
  }],

  // 天团触发（2026-09-20）：**只允许**跑白名单里的那一个脚本（不接任意命令），带单实例锁。
  // 这样"她自己开天团"是可控的一条路，而不是一个万能后门。
  ["POST", "/api/team/run", async (res, req) => {
    const body = await readBody(req, 4);
    const task = String((body && body.task) || "").slice(0, 300) || "写一个 10 秒飞天舞者视频脚本";
    const script = path.join(WS_ROOT, "工程", "多AI角色扮演系统", "scripts", "team-run-live.mjs");
    if (!fs.existsSync(script)) return json(res, 404, { error: "team-run-live.mjs 不存在" });
    const lock = path.join(WS_ROOT, "记忆", "运行时", "天团运行锁.json");
    try {
      const cur = JSON.parse(fs.readFileSync(lock, "utf8"));
      const ageMs = Date.now() - Date.parse(cur.at || 0);
      if (cur.pid && ageMs < 20 * 60 * 1000) {
        let alive = true; try { process.kill(cur.pid, 0); } catch { alive = false; }
        if (alive) return json(res, 409, { error: "已有一趟天团在跑", since: cur.at, pid: cur.pid, task: cur.task });
      }
    } catch {}
    try {
      const { spawn } = await import("node:child_process");
      const child = spawn(process.execPath, [script, task], { cwd: WS_ROOT, detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
      fs.writeFileSync(lock, JSON.stringify({ at: new Date().toISOString(), pid: child.pid, task }), "utf8");
      console.log(`[team] 天团已开跑：pid ${child.pid}｜${task}`);
      return json(res, 200, { ok: true, started: true, pid: child.pid, task, note: "跑完写 工程/多AI角色扮演系统/team-run.json，工作台「天团」视图会自动刷新" });
    } catch (e) { return json(res, 500, { error: String(e?.message || e).slice(0, 120) }); }
  }],

  // 天团运行态（2026-09-19）：只读暴露 工程/多AI角色扮演系统/team-run.json（工作台「天团」视图的数据源）。
  ["GET", "/api/team/run", (res) => {
    const p = path.join(CONFIG.cwd, "工程", "多AI角色扮演系统", "team-run.json");
    try {
      if (!fs.existsSync(p)) return json(res, 200, { ok: true, run: null, hint: "还没有运行记录：node 工程/多AI角色扮演系统/scripts/team-run.mjs \"任务\"" });
      return json(res, 200, { ok: true, run: JSON.parse(fs.readFileSync(p, "utf8")) });
    } catch (e) { return json(res, 500, { error: String(e?.message || e).slice(0, 120) }); }
  }],

  // 人格定义（2026-09-18）：一份定义决定人格——把定义与渲染结果如实暴露出来，便于核对。
  ["GET", "/api/persona", (res) => {
    const pd = loadPersonaDefinition(CONFIG.cwd);
    const genes = (() => { try { return emotion.getGenome(); } catch { return null; } })();
    json(res, 200, {
      definition: pd.def, source: pd.source, file: personaFilePath(CONFIG.cwd), problems: pd.problems,
      rendered: renderPersonaSection(pd.def, { genes }),
    });
  }],
  ["POST", "/api/sessions", async (res, req) => {
    const body = await readBody(req);
    const group = body.group === "test" || body.group === "terminal" ? body.group : "workspace";
    const id = await createSession(body.name, { group });
    return json(res, 200, { id, name: body.name || "新会话", group });
  }],
  // 存量会话 SDK 安全化：手动触发（启动时也会自动扫一遍）。body.sessionId 只修一个会话。
  ["POST", "/api/sessions/repair", async (res, req) => {
    const body = await readBody(req);
    const sid = String(body.sessionId || "");
    if (sid) {
      const found = findSession(sid);
      if (!found) return json(res, 404, { error: "会话不存在" });
      return json(res, 200, { ok: true, result: repairSessionFile(found.file) });
    }
    return json(res, 200, { ok: true, summary: repairSessionDir(SESSIONS_DIR) });
  }],
  // ── 工作空间 ──
  ["GET", "/api/prompts", (res) => handlePrompts(res)],
  ["GET", "/api/ws/tree", (res, req, url) => handleWsTree(res, url.searchParams.get("path") || "")],
  ["GET", "/api/ws/file", (res, req, url) => handleWsFile(res, req, url)],
  ["HEAD", "/api/ws/file", (res, req, url) => handleWsFile(res, req, url)],
  ["GET", "/api/ws/read", (res, req, url) => handleWsRead(res, url.searchParams.get("path") || "")],
  ["POST", "/api/ws/preview", async (res, req) => handleWsPreview(res, await readBody(req))],
  ["GET", "/api/ws/artifacts", (res) => handleWsArtifacts(res)],
  ["POST", "/api/ws/write", async (res, req) => handleWsWrite(res, await readBody(req))],
  ["POST", "/api/ws/deliver", async (res, req) => handleWsDeliver(res, await readBody(req))],
  ["POST", "/api/ws/deliver/package", async (res, req) => handleWsPackage(res, await readBody(req))],
  ["GET", "/api/ws/deliveries", (res) => handleWsDeliveries(res)],
  ["GET", "/api/ws/search", (res, req, url) => handleWsSearch(res, url.searchParams.get("q") || "")],
  ["POST", "/api/ws/rename", async (res, req) => handleWsRename(res, await readBody(req))],
  ["POST", "/api/ws/delete", async (res, req) => handleWsDelete(res, await readBody(req))],
  ["POST", "/api/ws/projects", async (res, req) => handleWsProjectCreate(res, await readBody(req))],
  ["POST", "/api/ws/convert", async (res, req) => handleWsConvert(res, await readBody(req))],
  // ── 系统 ──
  ["GET", "/api/notices", (res) => handleNotices(res)],
  ["GET", "/api/health", (res) => json(res, 200, { ok: true })],
  ["POST", "/api/repair", async (res, req) => handleRepair(res, await readBody(req))],
  ["GET", "/api/update/check", (res) => handleUpdateCheck(res)],
  // 前端版本号（从 index.html 的 ?v= 提取）：供前端自动检测更新→自动刷新
  ["GET", "/api/frontend-version", async (res) => {
    try {
      const html = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
      let max = 0;
      for (const m of html.matchAll(/[?&]v=(\d+)/g)) max = Math.max(max, parseInt(m[1], 10));
      json(res, 200, { version: max });
    } catch { json(res, 200, { version: 0 }); }
  }],
  ["POST", "/api/update/apply", async (res, req) => handleUpdateApply(res, await readBody(req))],
  // ── 设计器 ──
  ["POST", "/api/designer/generate", async (res, req) => handleDesignerGenerate(res, await readBody(req))],
  ["POST", "/api/designer/save", async (res, req) => handleDesignerSave(res, await readBody(req))],
  // ── 对外分享 ──
  ["POST", "/api/share", async (res, req) => handleShare(res, await readBody(req))],
  ["GET", "/api/share/status", (res) => handleShareStatus(res)],
  ["POST", "/api/share/stop", (res) => handleShareStop(res)],
  // ── 文件传输：上传任意文件到工作空间，写入会话 file 消息（聊天界面可见可下载）──
  ["POST", "/api/files/upload", async (res, req) => {
    // 限速（2026-08-29）：20MB 上传端点防灌盘，10 次/分钟
    if (!rateLimit(rateLimitKey(req, "upload"), 10, 60000)) {
      return json(res, 429, { error: "上传过于频繁（10次/分钟），请稍后再试" });
    }
    const body = await readBody(req, 24);
    const name = String(body.name || "").slice(0, 120);
    // 路径穿越防护（2026-08-29）：拒绝路径分隔符与 ..，防止写入任意路径
    if (!name || /[\\/:*?"<>|]/.test(name) || name.includes("..")) return json(res, 400, { error: "文件名不合法" });
    const data = String(body.data || "");
    const sessionId = String(body.sessionId || "");
    if (!name || !data) return json(res, 400, { error: "name 和 data 必填" });
    try {
      const buf = Buffer.from(data, "base64");
      if (buf.length > 20 * 1024 * 1024) return json(res, 400, { error: "文件过大（限 20MB）" });
      const date = new Date().toISOString().slice(0, 10);
      const dir = path.join(WS_ROOT, "收发文件", date);
      fs.mkdirSync(dir, { recursive: true });
      let fp = path.join(dir, name);
      if (fs.existsSync(fp)) { const pp = path.parse(name); fp = path.join(dir, `${pp.name}-${Date.now().toString(36)}${pp.ext}`); }
      fs.writeFileSync(fp, buf);
      const rel = path.relative(WS_ROOT, fp).replace(/\\/g, "/");
      // 挂到有效会话：优先指定会话（含从磁盘打开的），其次最近未命名会话，否则自动新建（保证界面可显示）
      let entry = sessionId && activeSessions.has(sessionId) ? activeSessions.get(sessionId) : null;
      if (!entry && sessionId) {
        // 会话文件存在但不在内存（如 CLI 会话 / 重启后）→ 从磁盘打开，挂到正确会话
        try {
          const opened = await openSession(sessionId);
          if (opened) { entry = opened; activeSessions.set(sessionId, opened); }
        } catch {}
      }
      if (!entry && lastUnnamedId && activeSessions.get(lastUnnamedId)) entry = activeSessions.get(lastUnnamedId);
      if (!entry) { try { const nid = await createSession(); entry = activeSessions.get(nid); } catch {} }
      if (entry) {
        try {
          // ⚠️ 2026-09-18 真机事故：这里原先落 {type:"file"} 块 → SDK 的 openai-completions
          //   把用户消息里的非 text 块无条件写成 image_url(data:;base64,undefined) →
          //   上游 400「unsupported image」，且此后每轮重放都 400（会话作废）。
          //   必须过 sdkSafeUserBlocks：文件附件落成一行文本标记，界面靠 extractFiles 照样出卡片。
          await entry.sm.appendMessage({ role: "user", content: sdkSafeUserBlocks([{ type: "file", name, path: rel, size: buf.length, mime: body.mime || "" }]) });
          // 触发落盘：兼容适配器在出现 assistant 消息前不写文件，追加一条空 assistant 强制 flush（空消息渲染时被过滤，不影响显示）
          await entry.sm.appendMessage({ role: "assistant", content: sdkSafeAssistantBlocks([]) });
          // 会话文件刚刚才真正落盘（SDK 懒写），列表缓存里可能还没有这个会话 →
          // 不失效的话前端按 id 拉消息会 404「会话不存在」，卡片就永远不显示。
          invalidateSessionCache();
        } catch {}
      }
      // 2026-09-18：没带 sessionId 时服务端只能"猜"挂到哪个会话（最近未命名 / 新建一个），
      // 猜错的后果就是**文件卡片落进用户没看的那个会话**——真机 bug"传上去聊天界面不显示"。
      // 猜的规则不能改（TUI 等调用方依赖它），但要把"挂到哪儿、是不是猜的"如实返回，
      // 让调用方能判断"这不是我这个会话的附件"，而不是靠猜。
      return json(res, 200, { ok: true, name, path: rel, size: buf.length, url: `/api/ws/file?path=${encodeURIComponent(rel)}`, sessionId: entry?.sm?.getSessionId() || null, attachedTo: entry?.sm?.getSessionId() || null, guessedSession: !sessionId });
    } catch (e) { return json(res, 500, { error: String(e.message || e).slice(0, 100) }); }
  }],
  // ── 技能/搜索/Git/文件 ──
  ["GET", "/api/skills", (res) => handleSkills(res)],
  ["GET", "/api/skills/read", (res, req, url) => handleSkillRead(res, url.searchParams.get("path") || "")],
  ["GET", "/api/search", (res, req, url) => handleSearch(res, url.searchParams.get("q") || "")],
  ["GET", "/api/git/status", (res) => handleGitStatus(res)],
  ["GET", "/api/git/diff", (res) => handleGitDiff(res)],
  ["GET", "/api/git/review", (res) => handleGitReview(res)],
  ["GET", "/api/aibody", (res, req, url) => json(res, 200, aibodyRuntime.overview({ sessionId: url?.searchParams?.get("session") || undefined, runId: url?.searchParams?.get("run") || undefined }))],
  ["GET", "/api/aibody/overview", (res, req, url) => json(res, 200, aibodyRuntime.overview({ sessionId: url?.searchParams?.get("session") || undefined, runId: url?.searchParams?.get("run") || undefined }))],
  // ── 浏览器操作（CDP 控制 Chrome）──
  ["POST", "/api/browser/start", async (res, req) => { const b = await import("./engine/browser.mjs"); const r = await b.startChrome(); json(res, r.error ? 500 : 200, r); }],
  ["POST", "/api/browser/stop", async (res) => { const b = await import("./engine/browser.mjs"); json(res, 200, b.stopChrome()); }],
  ["POST", "/api/browser/navigate", async (res, req) => { const b = await import("./engine/browser.mjs"); const body = await readBody(req); json(res, 200, await b.navigate(String(body.url || ""))); }],
  ["POST", "/api/browser/screenshot", async (res) => { const b = await import("./engine/browser.mjs"); json(res, 200, await b.screenshot()); }],
  ["POST", "/api/browser/text", async (res) => { const b = await import("./engine/browser.mjs"); json(res, 200, await b.pageText()); }],
  ["GET", "/api/fs", (res, req, url) => handleFsList(res, url.searchParams.get("path") || ".")],
  ["GET", "/api/fs/read", (res, req, url) => handleFsRead(res, url.searchParams.get("path") || "")],
  // ── 模型 ──
  ["GET", "/api/models", (res) => handleModels(res)],
  ["GET", "/api/models/manage", (res) => handleModelsManage(res)],
  ["POST", "/api/models/add", async (res, req) => handleModelsAdd(res, await readBody(req))],
  ["GET", "/api/keys/status", (res) => handleKeysStatus(res)],
  ["GET", "/api/dsh/status", (res) => handleDshStatus(res)],
  ["POST", "/api/dsh/web/start", (res) => handleDshWebStart(res)],
  ["GET", "/api/keys/presets", (res) => handleKeysPresets(res)],
  ["POST", "/api/keys/apply", async (res, req) => handleKeysApply(res, await readBody(req))],
  ["POST", "/api/models/remove", async (res, req) => handleModelsRemove(res, await readBody(req))],
  ["POST", "/api/model", async (res, req) => handleSwitchModel(req, res, await readBody(req))],
  // ── 媒体/对话 ──
  ["POST", "/api/think", async (res, req) => handleThink(res, await readBody(req))],
  ["POST", "/api/asr", async (res, req) => handleAsr(res, await readBody(req, 16))], // 语音转文字
  ["POST", "/api/image", async (res, req) => handleImageWithSave(res, req, await readBody(req))],
  ["POST", "/api/media", async (res, req) => handleMedia(res, await readBody(req))],
  ["GET", "/api/tasks/active", async (res, req) => {
    const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const sid = u.searchParams.get("sessionId") || "";
    const tk = u.searchParams.get("taskKey") || "";
    const key = tk || sid;
    const t = key ? taskProgress.get(key) : null;
    if (!t || t.status !== "running") return json(res, 200, { active: false, taskKey: tk || null, sessionId: sid || null });
    return json(res, 200, { active: true, taskKey: tk || null, sessionId: sid || null, stage: t.stage, toolName: t.toolName || null, startedAt: t.startedAt, updatedAt: t.updatedAt });
  }],
  ["POST", "/api/runs", async (res, req) => runApi.create(res, await readBody(req, 12), req)],
  ["GET", /^\/api\/runs\/([^/]+)$/, (res, req, url, m) => runApi.get(res, decodeURIComponent(m[1]))],
  ["GET", /^\/api\/runs\/([^/]+)\/events$/, (res, req, url, m) => runApi.events(res, req, url, decodeURIComponent(m[1]))],
  ["POST", /^\/api\/runs\/([^/]+)\/stop$/, (res, req, url, m) => runApi.stop(res, decodeURIComponent(m[1]))],
  ["POST", /^\/api\/runs\/([^/]+)\/resume$/, (res, req, url, m) => runApi.resume(res, decodeURIComponent(m[1]), req)],
  ["POST", "/api/chat", async (res, req) => handleChat(req, res, await readBody(req, 12))],
  ["POST", "/api/compare", async (res, req) => handleCompare(res, await readBody(req))],
  // ── Agent 活动事件（pi 事件广播扩展 → 前端实时显示小语在干嘛）──
  ["POST", "/api/agent/events", async (res, req) => handleAgentEventIn(req, res, await readBody(req, 2))],
  ["GET", "/api/agent/events", (res) => handleAgentEventOut(res)],
  // 危险操作确认回传：前端弹框后调这里（ok=true 放行 / ok=false 拒绝）
  ["POST", "/api/agent/confirm", async (res, req) => {
    try {
      const b = await readBody(req, 1);
      const sid = String(b?.sessionId || "");
      const id = String(b?.id || "");
      const ok = b?.ok === true;
      if (!sid || !id) return json(res, 400, { error: "缺少 sessionId/id" });
      const r = confirmRegistry.settle(sid, id, ok);
      json(res, 200, r);
    } catch (e) { json(res, 500, { error: String(e?.message || e) }); }
  }],
  // ── Gateway 2.0 插件化引擎（dsh 设计沉淀）──
  ["GET", "/api/engine/pair", async (res) => json(res, 200, await describePair())],
  ["POST", "/api/engine/pair", async (res, req) => {
    try {
      const b = await readBody(req, 1);
      if (b?.swap) return json(res, 200, await describePair(swapEnginePair()));
      json(res, 200, await describePair(saveEnginePair(b || {})));
    } catch (e) { json(res, 400, { error: String(e?.message || e).slice(0, 120) }); }
  }],
  ["GET", "/api/engine/status", async (res) => {
    try {
      const gw = await initEngine();
      json(res, 200, decorateEngineStatus(gw.status(), { gatewayReady: true, codeReady: !!getCodeRuntime() }));
    } catch (e) { json(res, 500, { error: String(e?.message || e) }); }
  }],
  // 真实工具集（主聊天 UNIFIED_TOOLS）：名字+描述+是否 dsh 注入，供引擎页「工具注册表」可视化
  ["GET", "/api/engine/tools", async (res) => {
    try {
      const tools = (UNIFIED_TOOLS || []).map(t => {
        const f = t?.function || t;
        return { name: f?.name || t?.name || "?", description: (f?.description || t?.description || "").slice(0, 160) };
      });
      const names = tools.map(t => t.name);
      json(res, 200, { tools, count: tools.length, dsh: names.includes("dsh_task"), skill: names.includes("activate_skill") });
    } catch (e) { json(res, 500, { error: String(e?.message || e) }); }
  }],
  ["POST", "/api/engine/plugins/register", async (res, req) => {
    try {
      const def = pluginFromBody(await readBody(req, 2));
      const gw = await initEngine();
      const r = await gw.registerPlugin(def);
      json(res, 200, r);
    } catch (e) { json(res, 400, { error: String(e?.message || e) }); }
  }],
  ["POST", "/api/engine/plugins/unregister", async (res, req) => {
    try {
      const body = await readBody(req, 1);
      const id = String(body?.id || "");
      if (isCorePlugin(id)) return json(res, 400, { error: "核心底盘不能卸" });
      const gw = await initEngine();
      json(res, 200, { removed: await gw.unregisterPlugin(id) });
    } catch (e) { json(res, 400, { error: String(e?.message || e) }); }
  }],
  ["POST", "/api/engine/chat", async (res, req) => {
    try {
      const body = await readBody(req, 12);
      const gw = await initEngine();
      // model 字符串 "provider/id" → 拆成 {provider, id}（engine/chat 端点此前传字符串导致 provider undefined）
      const modelStr = String(body?.model || "");
      const slashIdx = modelStr.indexOf("/");
      const model = slashIdx > 0 ? { provider: modelStr.slice(0, slashIdx), id: modelStr.slice(slashIdx + 1) } : (body?.model || undefined);
      const r = await gw.chat(String(body?.message || ""), { history: body?.history || [], sessionId: body?.sessionId, model, tools: body?.tools !== false, params: body?.params, system: body?.system });
      json(res, r.error ? 400 : 200, r);
    } catch (e) { json(res, 500, { error: String(e?.message || e) }); }
  }],
  // ── Code Mode（PTC 模式：模型写程序编排工具）──
  ["GET", "/api/code/tools", async (res) => {
    try {
      const gw = await initEngine();
      const rt = getCodeRuntime(), cm = getCodeMode();
      if (!rt || !cm) return json(res, 503, { error: "引擎未初始化，请先发一条消息或稍后重试" });
      json(res, 200, { bindings: Object.entries(rt.bindings).map(([n, b]) => ({ name: n, args: b.args, description: b.description })), sdk: cm.buildSdkText() });
    } catch (e) { json(res, 500, { error: String(e?.message || e) }); }
  }],
  ["POST", "/api/code/run", async (res, req) => {
    try {
      const body = await readBody(req, 4);
      await initEngine();
      const rt = getCodeRuntime();
      if (!rt) return json(res, 503, { error: "代码运行时未就绪" });
      const r = await rt.run({ program: String(body?.program || ""), timeoutMs: body?.timeoutMs });
      json(res, r.error ? 400 : 200, r);
    } catch (e) { json(res, 500, { error: String(e?.message || e) }); }
  }],
  ["POST", "/api/code/chat", async (res, req) => {
    try {
      const body = await readBody(req, 12);
      const gw = await initEngine();
      const r = await gw.chat(String(body?.message || ""), { history: body?.history || [], tools: true, params: body?.params, system: (body?.system || "") + "\n\n你可以用 run_code 工具写程序编排多步操作。" });
      json(res, r.error ? 400 : 200, r);
    } catch (e) { json(res, 500, { error: String(e?.message || e) }); }
  }],
  ["POST", "/api/parse-file", async (res, req) => handleParseFile(res, await readBody(req, 12))],
  // ── 专项工作台 ──
  ["POST", "/api/workshop/ppt", async (res, req) => workshop.handleWorkshopPpt({ ...wsCtx(), req }, res, await readBody(req))],
  ["POST", "/api/workshop/expand-prompt", async (res, req) => handleExpandPrompt({ ...wsCtx(), getDefaultModel: () => defaultModel, directChat }, res, await readBody(req))],
  ["POST", "/api/workshop-ui/v1/chat/completions", async (res, req) => handleWorkshopUiChat({ ...wsCtx(), req, directChat }, res, await readBody(req))],
  // PPT 设计干预：大纲编辑后本地重建 .pptx（2026-09-03）
  ["POST", "/api/workshop/pptx/rebuild", async (res, req) => workshop.rebuildPptx(wsCtx(), res, await readBody(req))],
  ["GET", "/api/workshop/ppt/history", (res) => workshop.listPptHistory(wsCtx(), res)],
  // 作品集（扫描式：聊天/工坊产出落进 workshop-out 即收录）
  ["GET", "/api/gallery", (res) => gallery.handleGalleryList(wsCtx(), res)],
  ["GET", "/api/gallery/deck", (res, req) => gallery.handleGalleryDeck(wsCtx(), res, req)],
  ["GET", "/api/gallery/page", (res, req) => gallery.handleGalleryPage(wsCtx(), res, req)],
  // 主题蒸馏（网址/本地HTML → theme CSS 入库 ppt-html templates）
  ["GET", "/api/workshop/ppt/themes", (res) => distill.handlePptThemes(wsCtx(), res)],
  ["POST", "/api/workshop/ppt/distill", async (res, req) => distill.handlePptDistill(wsCtx(), res, await readBody(req))],
  ["POST", "/api/workshop/ppt-html/refine", async (res, req) => workshop.handlePptRefine({ ...wsCtx(), req }, res, await readBody(req))],
  // PPT 设计稿模式（HTML 路线，2026-09-03）
  ["POST", "/api/workshop/ppt/html", async (res, req) => workshop.handleWorkshopPptHtml({ ...wsCtx(), req }, res, await readBody(req))],
  ["POST", "/api/workshop/ppt-html/save", async (res, req) => workshop.savePptHtmlPage(wsCtx(), res, await readBody(req))],
  // ── 小说工坊（书架式：作品沉淀/真相文件/第N章递进，收编自 novel-studio）──
  ["GET", "/api/novel/books", (res) => json(res, 200, { books: novelStudio.listBooks() })],
  ["POST", "/api/novel/books", async (res, req) => {
    const b = await readBody(req);
    const r = novelStudio.createBook(b);
    json(res, r.error ? 400 : 200, r);
  }],
  ["PATCH", "/api/novel/books", async (res, req) => {
    const b = await readBody(req);
    const r = novelStudio.updateBook(b?.id || "", b);
    json(res, r.error ? 400 : 200, r);
  }],
  ["DELETE", "/api/novel/books", async (res, req, url) => {
    const r = novelStudio.deleteBook(url.searchParams.get("id") || "");
    json(res, r.error ? 400 : 200, r);
  }],
  ["GET", "/api/novel/detail", (res, req, url) => json(res, 200, novelStudio.bookDetail(url.searchParams.get("id") || ""))],
  ["GET", "/api/novel/chapter", (res, req, url) => json(res, 200, novelStudio.readChapter(url.searchParams.get("id") || "", url.searchParams.get("file") || ""))],
  ["POST", "/api/novel/chapter", async (res, req) => {
    const b = await readBody(req);
    const r = novelStudio.writeChapter(b?.id || "", b?.file || "", b?.content);
    json(res, r.error ? 400 : 200, r);
  }],
  ["GET", "/api/novel/node", (res, req, url) => json(res, 200, novelStudio.readNode(url.searchParams.get("id") || "", url.searchParams.get("node") || ""))],
  ["POST", "/api/novel/node", async (res, req) => {
    const b = await readBody(req);
    const r = novelStudio.writeNode(b?.id || "", b?.node || "", b?.content);
    json(res, r.error ? 400 : 200, r);
  }],
  ["GET", "/api/novel/export", (res, req, url) => json(res, 200, novelStudio.exportBook(url.searchParams.get("id") || ""))],
  ["POST", "/api/novel/write", async (res, req) => novelRun.handleBookWrite({ ...wsCtx(), req }, res, await readBody(req))],
  ["POST", "/api/novel/advance", async (res, req) => novelRun.handleBookAdvance({ ...wsCtx(), req }, res, await readBody(req))],
  ["POST", "/api/novel/revise", async (res, req) => novelRun.handleBookRevise({ ...wsCtx(), req }, res, await readBody(req))],
  ["POST", "/api/novel/studio", async (res, req) => novelRun.handleBookStudio({ ...wsCtx(), req }, res, await readBody(req))],
  ["POST", "/api/novel/notes", async (res, req) => {
    const b = await readBody(req);
    const r = novelStudio.writeNotes(b?.id || "", b?.notes ?? b?.note ?? "");
    json(res, r.error ? 400 : 200, r);
  }],
  // ── 经验沉淀台（refine 提案制，Prime Agent 移植）──
  ["GET", "/api/refine/status", (res) => handleRefineStatus(res)],
  ["GET", "/api/refine/list", (res) => handleRefineList(res)],
  ["GET", "/api/refine/genes", (res) => handleRefineGenes(res)],
  ["POST", "/api/refine/feedback", async (res, req) => handleRefineFeedback(res, await readBody(req))],
  ["POST", "/api/refine/plan", async (res, req) => handleRefinePlan(res, await readBody(req))],
  ["POST", "/api/refine/approve", async (res, req) => handleRefineApprove(res, await readBody(req))],
  ["POST", "/api/refine/reject", async (res, req) => handleRefineReject(res, await readBody(req))],
  ["POST", "/api/refine/rollback", async (res, req) => handleRefineRollback(res, await readBody(req))],
  // ── 时间引擎 API ──
  ["GET", "/api/time/tasks", (res) => json(res, 200, { tasks: timeEngine ? timeEngine.list() : [] })],
  ["POST", "/api/time/tasks", async (res, req) => {
    try {
      const body = await readBody(req);
      if (!timeEngine) return json(res, 500, { error: "时间引擎未初始化" });
      const r = timeEngine.register(body);
      json(res, r.error ? 400 : 200, r);
    } catch (e) { json(res, 500, { error: String(e?.message || e).slice(0, 120) }); }
  }],
  ["DELETE", "/api/time/tasks", async (res, req) => {
    const u = new URL(req.url, "http://x");
    json(res, 200, timeEngine ? timeEngine.remove(u.searchParams.get("id") || "") : { removed: false });
  }],

  // 任务中心 v2（08-25）：状态机 / 手动执行 / 运行历史 / 停止
  ["PATCH", "/api/time/tasks", async (res, req) => {
    if (!timeEngine) return json(res, 500, { error: "时间引擎未初始化" });
    const body = await readBody(req);
    const fn = { pause: "pause", resume: "resume", archive: "archive" }[body?.action];
    if (!fn || !body?.id) return json(res, 400, { error: "需要 id + action(pause|resume|archive)" });
    return json(res, 200, timeEngine[fn](body.id));
  }],
  ["POST", "/api/time/tasks/run", async (res, req) => {
    if (!timeEngine) return json(res, 500, { error: "时间引擎未初始化" });
    const body = await readBody(req);
    if (!body?.id) return json(res, 400, { error: "需要 id" });
    const r = await timeEngine.runNow(body.id);
    return json(res, 200, r);
  }],
  ["GET", "/api/time/tasks/history", (res, req) => {
    const u = new URL(req.url, "http://x");
    if (!timeEngine) return json(res, 500, { error: "时间引擎未初始化" });
    const t = u.searchParams.get("id") ? timeEngine.find(u.searchParams.get("id")) : null;
    return json(res, 200, { history: t?.history || [] });
  }],
  ["POST", "/api/time/tasks/stop", async (res, req) => {
    if (!timeEngine) return json(res, 500, { error: "时间引擎未初始化" });
    const body = await readBody(req);
    if (!body?.id) return json(res, 400, { error: "需要 id" });
    return json(res, 200, timeEngine.stopRun(body.id));
  }],
  // ── MCP 认知层（NomiFun 等客户端接入，2026-08-20）──
  ["POST", "/mcp", async (res, req) => {
    const ctx = {
      api: async (path, opts = {}) => {
        const r = await fetch("http://127.0.0.1:" + CONFIG.port + path, {
          ...opts,
          headers: { Authorization: "Bearer " + CONFIG.token, "Content-Type": "application/json", ...(opts.headers || {}) },
        });
        return r;
      },
    };
    return handleMcp(req, res, ctx);
  }],
];

const corsPolicy = createCorsPolicy(CONFIG.corsOrigins);

const server = http.createServer(async (req, res) => {
  // 请求级 request-id：排查并发问题时能关联同一次请求的日志（小米 4.13）
  const reqId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  res.setHeader("X-Request-Id", reqId);
  // CORS：只允许已知本地壳 origin 和显式配置的远程前端，不能反射任意 Origin。
  for (const [name, value] of Object.entries(corsPolicy.headers(req.headers.origin))) res.setHeader(name, value);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  const t0 = Date.now();
  try {
    // 安全响应头（CSP 限制脚本来源，防止第三方注入执行；禁 MIME 嗅探；防 clickjacking）
    // OMEGA 页需连 OpenIM(10002/10001) 与 Gateway(9000)，connect-src/worker-src 已放行本地服务
    // P2 CSP 加固：React 版无内联脚本 → 去掉 script-src unsafe-inline；vanilla 版保留（有内联 <script>）
    const isVanillaReq = req.url?.includes("vanilla=");
    const scriptSrc = isVanillaReq ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'";
    res.setHeader("Content-Security-Policy", `default-src 'self'; ${scriptSrc}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.loli.net; img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; connect-src 'self' ws: wss: http://127.0.0.1:10002 http://127.0.0.1:9000 ws://127.0.0.1:10001 ws://127.0.0.1:9000 https://fastly.jsdelivr.net https://cubism.live2d.com https://v1.hitokoto.cn; worker-src 'self' blob:; font-src 'self' data: https://fonts.gstatic.com https://fonts.googleapis.com https://fonts.loli.net https://gstatic.loli.net; frame-ancestors 'none'`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    // 官方 M3E Canvas（Next 静态导出）需要内联脚本；本路径允许同源 iframe，其余仍 DENY
    if (url.pathname.startsWith("/static/workshop-ui")) {
      res.setHeader("X-Frame-Options", "SAMEORIGIN");
      res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.loli.net; img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; worker-src 'self' blob:; font-src 'self' data: https://fonts.gstatic.com https://fonts.googleapis.com https://fonts.loli.net https://gstatic.loli.net; frame-ancestors 'self'");
    }
    const isStatic = (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/sw.js" || url.pathname === "/api/health" || WORKSHOP_PAGES[url.pathname])) ||
                     (req.method === "GET" && (url.pathname.startsWith("/static/") || url.pathname.startsWith("/assets/") || url.pathname.startsWith("/legacy/") || url.pathname === "/vite.svg" || url.pathname === "/manifest.webmanifest" || url.pathname.startsWith("/icons/")));
    // 健康探活接口免 token（只返回 {ok:true}，无敏感信息）：安卓客户端连接页需在没有 token 时也能探地址是否可达（2026-08-31 修：之前需鉴权导致探活永远 401，客户端误判为连不上）
    // 签名文件链接（filebox 签名）免 token：签名本身是凭证
    let isSignedFile = false;
    try {
      if (url.pathname === "/api/ws/file" && url.searchParams.get("sig")) {
        const fb = await import("./engine/filebox.mjs");
        isSignedFile = fb.verifySigned(req).ok;
      }
    } catch {}
    if (!isStatic && !isSignedFile && !checkAuth(req)) {
      return json(res, 401, { error: "未授权，请提供访问令牌" });
    }

    // 静态资源
    // 主界面转正：默认 → React 版（今日大改后已成熟）；?vanilla=1 → 旧版 vanilla（保底）；?react=1 向后兼容
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const wantVanilla = url.searchParams.has("vanilla");
      const wantReact = reactStatic && (!wantVanilla || url.searchParams.has("react"));
      if (reactStatic && !wantVanilla) { req.url = "/index.html"; return reactStatic.handle(req, res); }
      return handleStatic(req, res);
    }
    // sw.js：默认反应版下发自毁脚本（React 不用 service worker）；?vanilla=1 下发原版缓存
    if (req.method === "GET" && url.pathname === "/sw.js") {
      if (reactStatic && !url.searchParams.has("vanilla")) {
        res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-cache" });
        return res.end(SW_UNREGISTER);
      }
      return handleStatic(req, res);
    }
    // Vite 指纹资产 + PWA 资源（manifest/图标无敏感内容，免 token 供安装器拉取）
    if (reactStatic && req.method === "GET" && (url.pathname.startsWith("/assets/") || url.pathname === "/vite.svg" || url.pathname === "/manifest.webmanifest" || url.pathname.startsWith("/icons/"))) return reactStatic.handle(req, res);
    // 旧版入口：/legacy/* → public/*
    if (req.method === "GET" && url.pathname.startsWith("/legacy/")) {
      req.url = url.pathname.slice("/legacy".length) || "/index.html";
      if (!req.url.includes("?") && url.search) req.url += url.search;
      return handleStatic(req, res);
    }
    if (req.method === "GET" && url.pathname.startsWith("/static/")) {
      req.url = url.pathname.replace(/^\/static/, "") + (url.search || "");
      return handleStatic(req, res);
    }

    // 工作台独立页（页面本身无敏感数据，鉴权由页面 JS 调 API 时执行；可直达 URL：/workshop /workshop/ppt 等）
    if (req.method === "GET" && WORKSHOP_PAGES[url.pathname]) {
      req.url = "/" + WORKSHOP_PAGES[url.pathname] + (url.search || "");
      return handleStatic(req, res);
    }

    // API（路由表匹配）
    for (const [method, matcher, handler] of API_ROUTES) {
      if (req.method !== method) continue;
      let m = null;
      if (typeof matcher === "string") {
        if (url.pathname !== matcher) continue;
      } else {
        m = url.pathname.match(matcher);
        if (!m) continue;
      }
      return await handler(res, req, url, m);
    }
    // 路由表无匹配 → 404
    return json(res, 404, { error: "not found" });
  } catch (e) {
    // 尊重错误自带的 statusCode（如 readBody 的 413「请求体太大」）：
    // 一律回 500 会把"客户端发太大了"说成"服务端炸了"，把排查方向带偏。
    try { json(res, Number(e?.statusCode) || 500, { error: String(e?.message || e) }); } catch {}
  } finally {
    // 请求日志（带 request-id 和耗时，API 路径记录，静态资源不刷屏）
    try {
      const url2 = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (!url2.pathname.startsWith("/static/")) {
        const ms = Date.now() - t0;
        console.log(`[req:${reqId}] ${req.method} ${url2.pathname} ${res.statusCode || 0} ${ms}ms`);
      }
    } catch {}
  }
});

// ── 启动时每日备份配置 ─────────────────────────────────────────────
try {
  const bkDir = path.join(__dirname, "backups");
  fs.mkdirSync(bkDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const bkServer = path.join(bkDir, `server-${today}.mjs`);
  const bkConfig = path.join(bkDir, `config-${today}.mjs`);
  if (!fs.existsSync(bkServer)) {
    fs.copyFileSync(__filename, bkServer);
    fs.copyFileSync(path.join(__dirname, "config.mjs"), bkConfig);
    console.log(`[元枢] 配置已备份: ${bkDir}`);
  }
} catch {}

// 端口占用时等待释放（自愈重启后旧进程可能未退出）
let listenAttempt = 0;
// error listener 只挂一次（避免重试时叠加，MaxListenersExceededWarning 根因）
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    // 被占用时先问一句"谁在服务"：同版本实例在服务 → 这份是重复实例，干净退出（别空转 30×2 秒）。
    // 版本不同 → 也说清楚，但**绝不替用户杀进程**（那是红线）；空转等待交回给原来的重试逻辑。
    try {
      const chk = selfCheck(WS_ROOT, { myPid: process.pid, myVersion: String(APP_VERSION) });
      console.log(`  [实例自检] ${chk.note}`);
      recordStartup(WS_ROOT, { version: String(APP_VERSION), port: CONFIG.port, ownsPort: false, duplicate: chk.duplicate, reason: chk.note, listening: false });
      if (chk.duplicate && process.env.YUANSHU_ALLOW_DUPLICATE !== "1") {
        console.log("  [实例自检] 重复实例：退出（已有同版本在服务；要强制并跑请设 YUANSHU_ALLOW_DUPLICATE=1）");
        process.exit(0);
      }
    } catch {}
  }
  if (err.code === "EADDRINUSE" && listenAttempt < 30) {
    listenAttempt++;
    console.log(`[元枢] 端口 ${CONFIG.port} 占用，等待释放 (${listenAttempt}/30)…`);
    setTimeout(() => { try { server.close(); } catch {}
    startServer(); }, 2000);
  } else {
    console.error("[元枢] 启动失败:", err.message);
    process.exit(1);
  }
});
function startServer() {
  // async：启动收尾里有需要 await 的清理（例如连续创作的孤儿运行）
  server.listen(CONFIG.port, CONFIG.host, async () => {
    listenAttempt = 0; // 监听成功 → 重置重试计数
    // 实例登记（2026-09-18）：此刻起"这份就是持有端口的那一份"，写进心跳让外面看得见。
    try {
      const startedAt = new Date().toISOString();
      heartbeat(WS_ROOT, { pid: process.pid, version: String(APP_VERSION), port: CONFIG.port, ownsPort: true, startedAt });
      const others = liveInstances(WS_ROOT, {}).filter((x) => x.pid !== process.pid);
      console.log(`  [实例自检] pid ${process.pid} · v${APP_VERSION} · 持有端口 ${CONFIG.port} · 其它存活实例 ${others.length}${others.length ? "（" + others.map((o) => `pid ${o.pid} v${o.version}`).join("、") + "）" : ""}`);
      setInterval(() => heartbeat(WS_ROOT, { pid: process.pid, version: String(APP_VERSION), port: CONFIG.port, ownsPort: true, startedAt }), 30000).unref?.();
    } catch (e) { console.log("  [实例自检] 登记失败:", String(e?.message || e).slice(0, 100)); }
    try { initTuiBridge(server, { token: CONFIG.token, cwd: WS_ROOT }); console.log("  TUI 桥接: ws://…/ws/tui 已就绪"); } catch {}
    console.log("");
    console.log("╭──────────────────────────────────────────────╮");
    console.log("│                元枢已启动                    │");
    console.log("╰──────────────────────────────────────────────╯");
    console.log(`  本地地址: http://${CONFIG.host}:${CONFIG.port}`);
    console.log(`  访问令牌: ${CONFIG.token}`);
    console.log(`  工作目录: ${CONFIG.cwd}`);
    console.log(`  工具集  : ${CONFIG.tools.join(", ")}`);
    console.log(`  默认模型: ${defaultModel ? defaultModel.provider + "/" + defaultModel.id : "(未设置)"}`);
    // 启动预探测 opencode-go（修复 B）：周额度 429 时启动即标记，Auto 路由全程避开，不浪费首轮请求；8/23 额度恢复后探测通过自动回到 opencode-go 优先
    setTimeout(async () => {
      try {
        const oc = modelList.find(m => m.provider === "opencode-go" && /deepseek-v4-flash/i.test(m.id));
        const ocKey = readJsonFile(AUTH_PATH)["opencode-go"]?.key;
        if (!oc || !ocKey) return;
        const ocBase = (oc.baseUrl || "https://opencode.ai/zen/go/v1").replace(/\/+$/, "");
        const probe = await httpJsonFetch(`${ocBase}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ocKey}` },
          body: JSON.stringify({ model: oc.id, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
          timeout: 25000,
        });
        // 2026-08-20 加固：403(Access denied)/401/402/429 都标记——opencode-go 账号无资格也是不可用态，Auto 路由应全程避开（此前只认 429，403 时每次请求都撞墙）
        if ([401, 402, 403, 429].includes(probe.status) || /GoUsageLimit/i.test(await probe.text().catch(() => ""))) markOcGoBlocked(`启动预探测 HTTP ${probe.status}`);
      } catch {}
    }, 3000);
    // 记忆自维护（启动后后台执行，不阻塞）：归档过期状态节；偏好提炼走提案制不自动写（改记忆需审批）
    try {
      const a = memoryApi.archiveStateSections(CONFIG.cwd, 5);
      if (a?.archived) console.log(`[memory] 归档 ${a.archived} 个过期状态节（固定记忆瘦身）`);
      else console.log(`[memory] 固定记忆状态节 ${a?.ok ? "无需归档" : "检查失败"}`);
      // 快照现在只在"真要改记忆"时才产生；这里再兜一次保留上限。
      // 旧版在每次 server 启动时无条件写一份（每份内嵌记忆日志全文），攒到 521 份 / 98.7MB 且无人读取。
      const pr = memoryApi.pruneSnapshots(CONFIG.cwd);
      if (pr?.removed) console.log(`[memory] 快照收敛：删除 ${pr.removed} 份旧快照，保留 ${pr.kept} 份 / ${(pr.bytes / 1048576).toFixed(1)}MB`);
      // 日志 .bak 同理：每次"去重"都落一份全量日志副本，保留最近几份即可
      const pb = pruneLogBackups(CONFIG.cwd);
      if (pb?.removed) console.log(`[memory] 日志备份收敛：删除 ${pb.removed} 份旧 .bak，保留 ${pb.kept} 份`);
      // 跨轮目标：重启后一律回到未武装态，必须人类重新确认——重启不该自动续跑
      const dg = disarmAllGoals(CONFIG.cwd, { reason: "服务重启后需人类重新确认" });
      if (dg?.disarmed) console.log(`[goals] ${dg.disarmed} 个进行中的目标已解除武装（重启不自动续跑）`);
      // 连续创作的孤儿运行：状态还是 running、但没有 finishedAt 的那些，持有它的进程已经没了，
      // 不清理就会永远显示「正在生成」（既不会成功也不会失败）。启动这一刻判它，是确定的。
      const sw = await sweepInterruptedRuns(WS_ROOT);
      if (sw?.swept) console.log(`[story] 清理 ${sw.swept} 条被中断的运行（${sw.touched.map(t => `${t.id.slice(0, 8)}×${t.runs}`).join(', ')}）`);
      // 带任务号的 running 留着：上游任务还在跑，随时能用任务号问一次（界面上的「查一次」）
      if (sw?.resumable) console.log(`[story] 保留 ${sw.resumable} 条可续查的运行（有上游任务号，可在连续创作里点「查一次」）`);
    } catch {}
    // 时间引擎：定时任务调度（触发时跑 unifiedChat + 结果落盘 文档/时间引擎日志.md）
    try {
      timeEngine = createTimeEngine(async (task) => {
        let out = "(无输出)";
        try {
          console.log(`[time-engine] 触发任务 ${task.id}(${task.queueId}): ${String(task.prompt).slice(0, 60)}`);
          try { invalidateSessionCache(); } catch {}
          const messages = composeTimeTaskMessages(task, {
            wsRoot: CONFIG.cwd,
            sessions: getSessionList(),
            now: new Date(),
          });
          const r = await unifiedChat(defaultModel, messages, { tools: timeTaskReadTools(UNIFIED_TOOLS) });
          out = r?.text || r?.content || r?.error || "(无输出)";
          const logDir = path.join(CONFIG.cwd, "文档");
          try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
          const logFile = path.join(logDir, "时间引擎日志.md");
          const entry = `
### ${task.firedAt} [${task.id}/${task.queueId}] ${String(task.prompt).slice(0, 40)}
${String(out).slice(0, 16000)}
`;
          try { fs.appendFileSync(logFile, entry); } catch {}
          // 复盘的行动清单落成承诺：这样"今天要做的"才可追踪——下一轮复盘会看到它、
          // 台前「待兑现承诺」会列它，结清仍只能由人给结论。没有 JSON 块的任务是无操作。
          try {
            const rec = recordReflectionActions(CONFIG.cwd, out, { taskId: task.id });
            if (rec?.ok) console.log(`[time-engine] 任务 ${task.id} 的行动清单 → 承诺账：解析 ${rec.parsed} 条，新增 ${rec.added} 条`);
            // 2026-09-17：清单不再止于清单——kind=fix 且不碰红线的，当场派一个执行轮做掉，
            // 做完带证据结清；做不了就 blocked/failed 留在账上（下一轮复盘会带着"上次试过什么"追问）。
            // 复盘那轮只有只读工具（这是刻意的），执行轮才发可写工具，且一次只做一条、最多 3 条。
            const { executable, deferred } = planReflectionExecution(rec?.actions || []);
            if (deferred.length) {
              console.log(`[time-engine] 留给跟踪/人工 ${deferred.length} 条：${deferred.map((a) => `${a.kind}(${a.reason || "-"})`).join('、').slice(0, 160)}`);
            }
            const rows = [];
            for (const action of executable) {
              let result = null;
              try {
                const prompt = buildActionExecutionPrompt(action, { ymd: yesterdayYmd() });
                const rr = await unifiedChat(defaultModel, [{ role: "user", content: prompt }], { tools: UNIFIED_TOOLS });
                result = parseActionResult(rr?.text || rr?.content || "");
              } catch (e) {
                result = { status: "failed", evidence: `执行轮异常：${String(e?.message || e).slice(0, 120)}`, files: [], summary: "" };
              }
              // 独立验证（2026-09-18）：执行轮自称 done 不算数——再派一个只看产物、
              // 看不到执行者推理的验证轮；不过验证就把结果降级，绝不让"自证成功"进账。
              if (result?.status === "done") {
                try {
                  const v = await verifyArtifacts({
                    claim: `${action.text}（执行轮自述：${result.evidence || "无证据"}）`,
                    artifacts: Array.isArray(result.files) ? result.files : [],
                    runTurn: async (prompt) => {
                      const rr = await unifiedChat(defaultModel, [{ role: "user", content: prompt }], { tools: timeTaskReadTools(UNIFIED_TOOLS) });
                      return rr?.text || rr?.content || "";
                    },
                  });
                  if (v.verdict !== "PASS") {
                    result = { ...result, status: v.verdict === "FAIL" ? "failed" : "blocked", evidence: `独立验证未通过（${v.verdict}）：${v.evidence}` };
                  }
                  console.log(`[time-engine] 独立验证「${String(action.text).slice(0, 30)}」→ ${v.verdict}`);
                } catch (e) {
                  result = { ...result, status: "blocked", evidence: `验证轮异常：${String(e?.message || e).slice(0, 120)}` };
                }
              }
              const rec2 = recordActionAttempt(CONFIG.cwd, action, result);
              rows.push({ text: action.text, status: result?.status || "failed", closed: rec2?.closed, evidence: result?.evidence || "" });
              console.log(`[time-engine] 自动执行「${String(action.text).slice(0, 40)}」→ ${result?.status || "failed"}${rec2?.closed ? "（已结清）" : ""}：${String(result?.evidence || "").slice(0, 100)}`);
            }
            if (rows.length) {
              const logLine = `
#### 自动执行（${summarizeExecution(rows)}）
${rows.map((r) => `- [${r.status}${r.closed ? "/已结清" : ""}] ${r.text}\n  证据：${r.evidence || "（无）"}`).join("\n")}
`;
              try { fs.appendFileSync(logFile, logLine); } catch (e) { console.log(`[time-engine] 自动执行小节写入日志失败: ${String(e?.message || e).slice(0, 120)}`); }
            }
          } catch (e) {
            // 不要静默：这条链上任何一步失败（派发/执行/回账/写日志）都必须留下痕迹，
            // 否则"复盘说要做、实际没做"会以"什么都没发生"的形式藏起来——正是这个项目在治的病。
            console.log(`[time-engine] 复盘→执行阶段异常: ${String(e?.stack || e?.message || e).slice(0, 300)}`);
          }
          console.log(`[time-engine] 任务 ${task.id} 完成，已记录到 ${logFile}`);
        } catch (e) {
          console.log(`[time-engine] 任务 ${task.id} 异常: ${String(e?.message || e).slice(0, 100)}`);
          throw e; // 上抛给任务中心记 error 历史
        }
        return String(out);
      }, { onTaskDone: (info) => nudgeSkill(info) }); // 技能自主沉淀钩子（09-03，Hermes 闭环）
      timeEngine.start();
    } catch (e) { console.log("[time-engine] 启动失败:", String(e?.message || e).slice(0, 100)); }
    // 做梦周期：自己跑，不等用户点接口（自决的意义就在这）。失败不影响服务。
    try {
      const DREAM_EVERY_MS = 6 * 60 * 60 * 1000;
      const kickDream = () => runDreamCycle().then((r) => {
        if (r?.ok) console.log(`[dream] 周期完成：回放 ${r.episodes} 条，赢家 ${r.winner || "无"}`);
        else console.log(`[dream] 周期跳过：${r?.reason || "无可用数据"}`);
      }).catch((e) => console.log(`[dream] 周期异常: ${String(e?.message || e).slice(0, 120)}`));
      setTimeout(kickDream, 120000).unref?.();
      setInterval(kickDream, DREAM_EVERY_MS).unref?.();
      console.log("  [dream] 做梦周期已挂上（启动 2 分钟后首跑，之后每 6 小时）");
    } catch (e) { console.log("[dream] 周期挂载失败:", String(e?.message || e).slice(0, 100)); }
    console.log(`  会话目录: ${SESSIONS_DIR}`);
    // 人格定义 → 人格化（2026-09-18）：把定义的渲染结果同步进 pi 通道读的 APPEND_SYSTEM.md
    // （幂等，只替换标记块），这样两条通道上"她是谁"来自同一份定义。
    try {
      const pd = loadPersonaDefinition(CONFIG.cwd);
      const r = syncAppendSystemPersona(pd.def, { agentDir: getAgentDir() });
      console.log(`  [persona] ${pd.def.name}（${pd.def.age} 岁，来源 ${pd.source}${pd.problems.length ? "，有问题：" + pd.problems.join("；") : ""}）→ APPEND_SYSTEM.md ${r.changed ? "已同步" : "已是最新"}${r.error ? "（失败：" + r.error + "）" : ""}`);
    } catch (e) { console.log(`  [persona] 同步失败（不阻断启动）: ${String(e?.message || e).slice(0, 100)}`); }
    // 存量会话 SDK 安全化（2026-09-18）：上传文件曾经给用户消息落 {type:"file"} 块，
    // pi 的 provider 适配会把它写成 image_url(data:;base64,undefined) → 该会话此后每轮都
    // 400「unsupported image」。修写入路径救不回已经在盘上的会话，所以启动时扫一遍。
    // 放 listen 之后异步跑：修会话不是启动前提，不能拖慢或拖挂服务。
    setTimeout(() => {
      try {
        const t0 = Date.now();
        const r = repairSessionDir(SESSIONS_DIR);
        if (r.repaired) console.log(`[session-repair] 修复 ${r.repaired} 个会话（${r.lines} 条消息，扫描 ${r.scanned} 个文件，${Date.now() - t0}ms）`);
        else console.log(`[session-repair] 无需修复（扫描 ${r.scanned} 个文件，${Date.now() - t0}ms）`);
      } catch (e) { console.log(`[session-repair] 扫描异常: ${String(e?.message || e).slice(0, 120)}`); }
    }, 3000).unref?.();
    // 机器可读的启动事实：不受重定向日志 GBK 乱码影响，验证时直接读 jsonl（今天就是在这栽的）
    try {
      recordStartup(WS_ROOT, { version: String(APP_VERSION), port: CONFIG.port, ownsPort: true, listening: true, dreamTimerMounted: true, sessionsDir: String(SESSIONS_DIR) });
    } catch {}
    // 发现文件：写入运行时目录，让本机 Agent 会话能发现元枢入口
    try {
      const discoverDir = path.join(getAgentDir());
      fs.mkdirSync(discoverDir, { recursive: true });
      const disc = `# 元枢（个人智能系统）
\n这是本机已安装的元枢 Web 工作台。\n\n- 访问地址: http://${CONFIG.host}:${CONFIG.port}\n- 访问令牌: 见服务器 .token 文件\n- 工作目录: ${CONFIG.cwd}\n- 一键打开: 运行 \`yuanshu\` 命令（兼容 \`pi-web\`）\n- 目录: ${__dirname}\n`;
      fs.writeFileSync(path.join(discoverDir, "元枢.md"), disc, "utf8");
      // 旧文件名继续保留兼容，但内容和品牌统一为元枢。
      fs.writeFileSync(path.join(discoverDir, "pi-web.md"), disc, "utf8");
      console.log(`  📍 已写入发现文件: ${path.join(discoverDir, "元枢.md")}`);
    } catch (e) {
      console.log(`  ⚠️ 发现文件写入失败: ${String(e?.message || e).slice(0, 60)}`);
    }
  });
}

// ══ 订阅到期提醒：每天检查追踪文档，到期前 7 天/3 天/当天打印提醒 ══
function checkSubscriptions() {
  try {
    const f = path.join(CONFIG.cwd, "文档", "平台订阅费用追踪.md");
    const raw = readSubscriptionText(f);
    if (!raw) return;
    const today = new Date();
    const rows = raw.split("\n").filter(l => l.includes("|") && l.includes("2026-"));
    for (const line of rows) {
      const cols = line.split("|").map(c => c.trim());
      // 只匹配表格（行首是 | 且含到期日列）；排除说明段（无到期日格式）
      if (!line.trim().startsWith("|")) continue;
      // 到期日在第 4 列（平台|key|计费|到期日|...）；余额查询日期在备注列不应匹配
      const expCell = cols[4] || "";
      const m = expCell.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (!m || expCell.includes("待确认")) continue;
      const name = cols[1].replace(/[★*()]/g, "").trim();
      const exp = new Date(+m[1], +m[2] - 1, +m[3]);
      const days = Math.ceil((exp - today) / 86400000);
      if (days === 0) console.log(`[订阅提醒] ⚠️ ${name} 今天到期！记得处理续费/退订`);
      else if (days === 3) console.log(`[订阅提醒] ⚠️ ${name} 还有 3 天到期（${m[1]}-${m[2]}-${m[3]}），如需退订请提前操作`);
      else if (days === 7) console.log(`[订阅提醒] ⚠️ ${name} 还有 7 天到期（${m[1]}-${m[2]}-${m[3]}）`);
    }
  } catch {}
}
checkSubscriptions();
setInterval(checkSubscriptions, 6 * 3600 * 1000); // 每 6 小时查一次

// 空会话定期清扫：冷却 6 小时，进回收站，不碰置顶/外部联系/有实质内容的会话
const SWEEP_MS = 6 * 3600 * 1000;
async function sweepSessionsQuietly() {
  try {
    const r = await sweepSessionsNow({ minAgeMs: SWEEP_MS });
    if (r.swept) console.log(`[session-sweep] 定期清理 ${r.swept} 条空会话`);
  } catch (e) {
    console.log("[session-sweep]", String(e.message || e).slice(0, 120));
  }
}
setTimeout(sweepSessionsQuietly, 2 * 60 * 1000);
setInterval(sweepSessionsQuietly, SWEEP_MS);

// ── 事件循环停顿监测（2026-09-19）────────────────────────────────────────────
// 背景：真机实测服务端出现过一次 ~90 秒的整段阻塞（/api/health 连续三次 30s 超时，之后恢复 12ms）。
// 阻塞时任何接口都会跟着卡（"电脑感觉卡"里有一部分就是它）。先装仪表，卡了留证据，再修。
try {
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  const lagFile = path.join(WS_ROOT, "记忆", "运行时", "事件循环停顿.jsonl");
  try { fs.appendFileSync(lagFile, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, mounted: true, note: "loop-lag 监测已挂上（>500ms 记一条）" }) + "\n"); } catch {}
  setInterval(() => {
    const maxMs = Math.round(lag.max / 1e6);
    if (maxMs > 500) {
      const line = JSON.stringify({
        at: new Date().toISOString(), pid: process.pid, maxMs,
        meanMs: Math.round(lag.mean / 1e6), p99Ms: Math.round(lag.percentile(99) / 1e6),
        rssMB: Math.round(process.memoryUsage().rss / 1048576),
      });
      try { fs.appendFileSync(lagFile, line + "\n"); } catch {}
      console.log("[loop-lag]", line);
    }
    lag.reset();
  }, 30000).unref?.();
  console.log("  [loop-lag] 事件循环停顿监测已挂上（>500ms 记一条：记忆/运行时/事件循环停顿.jsonl）");
} catch (e) { console.log("[loop-lag] 挂载失败:", String(e?.message || e).slice(0, 100)); }

startServer();


