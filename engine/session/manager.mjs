// 2026-11-06：上下文预算纯函数已搬到 session/context-budget.mjs。
import { _clearSessionModelKey, isFirstTurn } from "./context-budget.mjs";
export { estimateCompactedTokens, ensureContextHeadroom, isFirstTurn, _clearSessionModelKey } from "./context-budget.mjs";

// engine/session-manager.mjs —— 会话生命周期管理（2026-08-20 从 server.mjs 拆出）
// createSession/openSession/deleteSession/compactSession/slimSessionImages + agent 组装
// 依赖注入：initSessionManager({ cwd, sessionsDir, getModelList, getDefaultModel, activeSessions, SessionManager, SettingsManager, DefaultResourceLoader, getAgentDir, readJsonFile, writeJsonFile, initSearchTool, initShareTool, initDshTool, isExternalThinking, THINK_TOOL, modelCapabilities, bindOutputGuardDeps, extractMessages, createSseWriter, unifiedChat })
import fs from "node:fs";
import path from "node:path";
import { createPiTeamTool } from '../team-tool-context.mjs';
import { invalidateSessionCache, getSessionList, findSession } from "./files.mjs";
import { appendSessionGroup, normalizeCreateGroup } from "./groups.mjs";
import { appendArchiveJsonl, archivePathFor } from "../yuanshu-compact.mjs";
import { headroomCheck, estimateTokensFromText } from "../context-headroom.mjs";
import { execActivateSkill } from "../context-loader.mjs";
import { httpJsonFetch } from "../http.mjs";
import { wsSafePath } from "../workspace-api.mjs";
import { env } from "../env.mjs";
import { createIdleSessionWriter } from '../idle-session-writer.mjs';
import { validateSessionOrigin } from './origin-auth.mjs';
import { compactManagedSession } from './manual-compaction.mjs';
import { createSessionLifecycle, sessionFileVersion, conversationGone, disposeAgent } from './lifecycle.mjs';
import { createToolInitializers } from "./tool-inits.mjs";
import { resolveShareOrigin } from '../network-endpoints.mjs';

const toolInitializers = createToolInitializers({
  getCwd: () => _cwd,
  getPiPackage: () => _piPackage,
  getFixRunner: () => _runOnTheSpotFix,
});
export const {
  initSearchTool, initActivateSkillTool, initPiThinkTool, initShareTool, initPiMediaTools, initFixProblemTool,
} = toolInitializers;

let _runOnTheSpotFix = null;
let computerToolFactory = null;
export function initComputerTool(factory) { computerToolFactory = factory; }
let cultivationToolFactory = null;
export function initCultivationTool(factory) { cultivationToolFactory = factory; }
let memoryToolFactory = null;
export function initMemoryTool(factory) { memoryToolFactory = factory; }

const lifecycle = createSessionLifecycle();
const lazySessionManagers = new WeakSet();

function hasSessionFile(sm, file) {
  const exists = fs.existsSync(file);
  // SDK first assistant flushes the complete JSONL; afterwards absence means gone,
  // even when no lifecycle call happened between the flush and external removal.
  if (exists || sm.flushed === true) { lazySessionManagers.delete(sm); return exists; }
  return lazySessionManagers.has(sm);
}

function canUseLazyOrigin(id, live) {
  return !!live && _activeSessions?.get(id) === live && live.sm?.getSessionId?.() === id
    && hasSessionFile(live.sm, live.sm.getSessionFile()) && lazySessionManagers.has(live.sm);
}

export function canAccessSessionOrigin(id) {
  try {
    const live = _activeSessions?.get(id);
    if (live && !live.sm) return false;
    const file = live ? live.sm.getSessionFile() : findSession(id)?.file;
    return validateSessionOrigin({ id, file, sessionsDir: _sessionsDir, cwd: _cwd,
      sm: live?.sm, allowUnpersisted: canUseLazyOrigin(id, live) });
  } catch { return false; }
}

export function withIdleSession(id, append) {
  return createIdleSessionWriter({ activeSessions: _activeSessions, SessionManager: _SessionManager,
    findSession, cwd: _cwd, sessionsDir: _sessionsDir, isLocked: (sid, file) => lifecycle.locked(sid, file),
    canUseUnpersisted: canUseLazyOrigin,
    invalidate: invalidateSessionCache })(id, append);
}

export function compactSessionAgent(id, model) {
  return compactManagedSession(id, model, { lifecycle, activeSessions: _activeSessions,
    findSession, openSession, ensureAgent, hasSessionFile });
}

let _cwd = "", _sessionsDir = "", _tools = [], _getModelList = () => [], _getDefaultModel = () => null, _activeSessions = null, _createAgentSessionServices = null, _createAgentSessionFromServices = null, _getModelRuntime = () => null,
    _SessionManager = null, _SettingsManager = null, _DefaultResourceLoader = null, _getAgentDir = () => "", _readJsonFile = null, _writeJsonFile = null, _piPackage = "", _isModelBlocked = () => false,
    _initSearchTool = async () => null, _initShareTool = async () => null, _initDshTool = async () => null, _isExternalThinking = () => false, _THINK_TOOL = null,
    _generateMediaAsync = null,
    _modelCapabilities = null, _bindOutputGuardDeps = null, _extractMessages = null, _createSseWriter = null, _unifiedChat = null, _loadSessionModelKey = null, _onSessionCreated = null,
    _repairSessionFile = null, _agentFactory = createSessionAgent, _summaryFetch = httpJsonFetch;
export function initSessionManager({ cwd = "", sessionsDir = "", tools = [], piPackage = "", isModelBlocked = null, getModelList = null, getDefaultModel = null, activeSessions = null, SessionManager = null, SettingsManager = null, DefaultResourceLoader = null, getAgentDir = null, readJsonFile = null, writeJsonFile = null, initSearchTool = null, initShareTool = null, initDshTool = null, isExternalThinking = null, THINK_TOOL = null, modelCapabilities = null, bindOutputGuardDeps = null, extractMessages = null, createSseWriter = null, unifiedChat = null, createAgentSessionServices = null, createAgentSessionFromServices = null, getModelRuntime = null, loadSessionModelKey = null, generateMediaAsync = null, onSessionCreated = null, repairSessionFile = null, agentFactory = createSessionAgent, summaryFetch = httpJsonFetch } = {}) {
  _agentFactory = agentFactory; _summaryFetch = summaryFetch;
  _cwd = cwd; _sessionsDir = sessionsDir; _tools = tools; _piPackage = piPackage; if (isModelBlocked) _isModelBlocked = isModelBlocked; _activeSessions = activeSessions; _SessionManager = SessionManager; _SettingsManager = SettingsManager; _DefaultResourceLoader = DefaultResourceLoader; _readJsonFile = readJsonFile; _writeJsonFile = writeJsonFile;
  if (createAgentSessionServices) _createAgentSessionServices = createAgentSessionServices; if (createAgentSessionFromServices) _createAgentSessionFromServices = createAgentSessionFromServices; if (getModelRuntime) _getModelRuntime = getModelRuntime; if (loadSessionModelKey) _loadSessionModelKey = loadSessionModelKey;
  if (getModelList) _getModelList = getModelList; if (getDefaultModel) _getDefaultModel = getDefaultModel; if (getAgentDir) _getAgentDir = getAgentDir;
  if (initSearchTool) _initSearchTool = initSearchTool; if (initShareTool) _initShareTool = initShareTool; if (initDshTool) _initDshTool = initDshTool; if (isExternalThinking) _isExternalThinking = isExternalThinking; if (THINK_TOOL) _THINK_TOOL = THINK_TOOL;
  if (generateMediaAsync) _generateMediaAsync = generateMediaAsync;
  if (typeof onSessionCreated === "function") _onSessionCreated = onSessionCreated;
  if (typeof repairSessionFile === "function") _repairSessionFile = repairSessionFile;
  if (modelCapabilities) _modelCapabilities = modelCapabilities; if (bindOutputGuardDeps) _bindOutputGuardDeps = bindOutputGuardDeps; if (extractMessages) _extractMessages = extractMessages; if (createSseWriter) _createSseWriter = createSseWriter; if (unifiedChat) _unifiedChat = unifiedChat;
}

export async function createSession(name, { group, id: fixedId, cwd } = {}) {
  const sm = fixedId ? _SessionManager.create(cwd || _cwd, _sessionsDir, { id: fixedId }) : _SessionManager.create(cwd || _cwd, _sessionsDir);
  const id = sm.getSessionId();
  const file = sm.getSessionFile();
  const g = normalizeCreateGroup(group);
  // 2026-08-19 收敛：新会话一律用默认模型（千问）。不再继承 lastModelKey——
  //   否则用户切过的 nvidia/deepseek 残留会污染新会话默认（“后端不是千问”死循环根源）。
  //   用户切模型只锁当前会话（session-model-keys 持久化），新会话永远回到默认。
  let agent = null;
  let modelKey = null;
  const token = lifecycle.begin('creating', id, file);
  const lazyFile = !fs.existsSync(file); // SDK new sessions can be lazily persisted.
  if (lazyFile) lazySessionManagers.add(sm);
  try {
    agent = await _agentFactory(sm, _getDefaultModel());
    if (!lifecycle.current(token, hasSessionFile(sm, file))) { disposeAgent(agent); throw conversationGone(); }
    _activeSessions.set(id, { agent, sm, busy: false, lastUsed: Date.now(), modelKey: _getDefaultModel() && _getDefaultModel().provider ? { provider: _getDefaultModel().provider, id: _getDefaultModel().id } : null, agentModel: _getDefaultModel() && _getDefaultModel().provider ? { provider: _getDefaultModel().provider, id: _getDefaultModel().id } : null });
    invalidateSessionCache(); // 新增会话 → 列表缓存失效
    if (name) { try { sm.appendSessionInfo(name); } catch {} }
    try { appendSessionGroup(file, g, name); } catch {}
    // 会话数据库编号在创建时立即落盘，避免必须手动点击“重建索引”才出现编号。
    try { await _onSessionCreated?.({ id, file, name: name || "新会话", group: g }); } catch {}
    if (!lifecycle.current(token, hasSessionFile(sm, file))) throw conversationGone();
    return id;
  } finally { lifecycle.end(token); }
}

// 从当前会话某条消息创建一个真正独立的新会话分支。
// 与 sm.branch() 不同：原会话保持不变，新会话只继承目标消息的祖先链，
// 用户切换过去后可以继续对话，也可以随时回到原会话。
export async function cloneSessionFromEntry(sourceId, entryId, name = "") {
  const source = await openSession(sourceId);
  if (!source) throw new Error("源会话不存在");
  const entries = Array.isArray(source.sm?.fileEntries)
    ? source.sm.fileEntries
    : (source.sm?.getFileEntries?.() || []);
  const target = entries.find((e) => e?.id === entryId && e?.type === "message");
  if (!target) throw new Error("找不到要分支的消息");

  const byId = new Map(entries.filter((e) => e?.id).map((e) => [e.id, e]));
  const keep = new Set([entryId]);
  let cursor = target;
  let guard = 0;
  while (cursor?.parentId && guard++ < 2000) {
    if (keep.has(cursor.parentId)) break;
    keep.add(cursor.parentId);
    cursor = byId.get(cursor.parentId);
  }
  const sourceHeader = entries.find((e) => e?.type === "session") || {};
  const branchName = String(name || `分支 · ${source.sm?.getSessionName?.() || "当前会话"}`).slice(0, 120);
  const newId = await createSession(branchName, { group: "workspace" });
  const created = _activeSessions.get(newId);
  const newFile = created?.sm?.getSessionFile?.();
  if (!newFile) throw new Error("新会话文件创建失败");
  const header = {
    ...sourceHeader,
    type: "session",
    id: newId,
    timestamp: new Date().toISOString(),
    cwd: _cwd,
  };
  const info = { type: "session_info", id: `info_${Date.now().toString(36)}`, timestamp: new Date().toISOString(), name: branchName, group: "workspace" };
  const copied = entries.filter((e) => e?.type !== "session" && e?.type !== "session_info" && (!e?.id || keep.has(e.id)));
  fs.writeFileSync(newFile, [header, info, ...copied].map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  invalidateSessionCache();
  // createSession 已经把空会话放入活动表；换成带历史的实例，避免首轮上下文仍指向空文件。
  try { created?.agent?.dispose?.(); } catch {}
  _activeSessions.delete(newId);
  const reopened = await openSession(newId);
  if (!reopened) throw new Error("分支会话打开失败");
  return { id: newId, name: branchName, sourceSessionId: sourceId, sourceEntryId: entryId };
}

// ── 活动会话 LRU 淘汰（防止长跑内存只增不减）──
const MAX_ACTIVE_SESSIONS = 30; // 保留上限；超过后淘汰最久未用且不忙的会话
export function evictInactiveSessions() {
  if (_activeSessions.size <= MAX_ACTIVE_SESSIONS) return;
  const idle = [..._activeSessions.entries()]
    .filter(([id, e]) => !e.busy && !lifecycle.locked(id, e.sm?.getSessionFile?.()))
    .sort((a, b) => (a[1].lastUsed || 0) - (b[1].lastUsed || 0));
  for (const [id, e] of idle) {
    if (_activeSessions.size <= MAX_ACTIVE_SESSIONS) break;
    try { e.agent?.dispose?.(); } catch {}
    _activeSessions.delete(id);
    console.log(`[元枢] LRU 淘汰闲置会话 ${id}`);
  }
}

// 会话瘦身：把会话文件里超大 base64 图片数据替换成占位（read 工具读图会把整张图存进历史，
// 模型不支持看图时这些数据纯浪费——22 张图 = 22MB 垃圾沉淀，拖慢每次对话）
export async function slimSessionImages(file) {
  try {
    const st = fs.statSync(file);
    if (st.size < 5 * 1024 * 1024) return; // 只有超大会话才处理
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split("\n");
    let replaced = 0, totalSlimmed = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const d = JSON.parse(line);
        const msg = d?.message;
        if (!msg || typeof msg !== "object") continue;
        const content = msg.content;
        if (!Array.isArray(content)) continue;
        let changed = false;
        for (const part of content) {
          if (part && part.type === "image" && typeof part.data === "string" && part.data.length > 100_000) {
            totalSlimmed += part.data.length;
            part.data = `[图片已瘦身:原数据 ${(part.data.length / 1024).toFixed(0)}KB，模型不支持看图已省略]`;
            part.slimmed = true;
            changed = true;
          }
        }
        if (changed) {
          lines[i] = JSON.stringify(d);
          replaced++;
        }
      } catch {}
    }
    if (replaced) {
      fs.writeFileSync(file, lines.join("\n"), "utf8");
      console.log(`[元枢] 会话瘦身: ${file.split(/[\\/]/).pop()} 替换 ${replaced} 条图片数据，释放 ${(totalSlimmed / 1024 / 1024).toFixed(1)}MB`);
    }
  } catch (e) {
    console.log(`[元枢] 会话瘦身失败: ${String(e?.message || e).slice(0, 80)}`);
  }
}

// 分层记忆（compaction）：会话历史超过上下文窗口阈值时，把早期消息压缩成摘要
// 原理：pi 引擎原生支持 compaction——context.js 读上下文时自动用摘要替代其之前所有消息
// 实现：自己算 cutPoint + directChat 生成摘要 + 重写文件（parentId 重链到 compaction 条目）
let compactingSessions = new Set();

export async function compactSession(file, model, force = false, focus = "") {
  if (compactingSessions.has(file)) return { skip: true, reason: "busy: 该会话正在压缩中" };
  compactingSessions.add(file);
  const token = lifecycle.begin('compacting', null, file);
  let sm = null;
  try {
    const st = fs.statSync(file);
    // 只有超大会话（>3MB 或估算超阈值）才压缩，避免小会话频繁触发
    if (!force && st.size < 3 * 1024 * 1024) return;
    const originalVersion = sessionFileVersion(file);
    if (!originalVersion) return { skip: true, reason: 'conversation_gone' };
    // 用引擎打开会话（pi-coding-agent 的 SessionManager，fileEntries 公开且完整）
    sm = _SessionManager.open(file, path.dirname(file), _cwd);
    const entries = sm.fileEntries || [];
    token.id = sm.getSessionId?.() || entries.find(e => e.type === 'session')?.id;
    const msgs = entries.filter(e => e.type === "message");
    if (msgs.length < 8) return { skip: true, reason: "会话消息过少(或已压缩过)，无需压缩" };
    // 已有 compaction 且后续消息不多 → 跳过（避免每次打开都压）
    let lastCompIdx = -1;
    for (let i = entries.length - 1; i >= 0; i--) { if (entries[i].type === "compaction") { lastCompIdx = i; break; } }
    if (!force && lastCompIdx >= 0 && entries.length - lastCompIdx < 40) return; // 手动 /compact 强制再压
    // 估算会话 token（中文≈1.5/字，其他≈0.35/字符）——超阈值才压缩
    const estTok = msgs.reduce((s, e) => {
      const txt = JSON.stringify(e.message || {});
      const cn = (txt.match(/[\u4e00-\u9fff]/g) || []).length;
      return s + Math.round(cn * 1.5 + (txt.length - cn) * 0.35);
    }, 0);
    const threshold = Math.min(300_000, Math.round((model?.contextWindow || 1_000_000) * 0.7));
    if (!force && estTok < threshold) return; // 手动 /compact 无条件压缩，自动压缩仍按阈值
    // 保留最近约 30K token 的消息（其余压掉），从 cut 消息沿 parentId 收集整条保留链
    const keepBudget = 30000;
    let keepFrom = msgs.length;
    let acc = 0;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const txt = JSON.stringify(msgs[i].message || {});
      const cn = (txt.match(/[\u4e00-\u9fff]/g) || []).length;
      acc += Math.round(cn * 1.5 + (txt.length - cn) * 0.35);
      if (acc >= keepBudget) { keepFrom = i; break; }
    }
    keepFrom = Math.max(4, Math.min(keepFrom, msgs.length - 2)); // 至少留 2 条，最多压到剩 4 条以下
    const cutMsg = msgs[Math.min(keepFrom, msgs.length - 1)];
    const toSummarize = msgs.slice(0, keepFrom);
    // 保留预算把全部消息都盖住了 → 没有可压的历史。以前 force 会绕过下面的长度检查，
    // 于是"压了个空摘要、消息一条没少"，白花一次模型调用（核对时真出现过 0 条被压）。
    if (!toSummarize.length) return { skip: true, reason: "没有可压缩的历史（保留预算内已覆盖全部消息）" };
    if (!force && toSummarize.length < 6) return; // 手动 /compact 无条件压缩（force）
    // 组装摘要输入（截断到合理长度）
    const parts = [];
    for (const e of toSummarize) {
      const m = e.message || {};
      const role = m.role || "?";
      let text = "";
      const content = m.content;
      if (typeof content === "string") text = content.slice(0, 1500);
      else if (Array.isArray(content)) {
        text = content.map(p => (typeof p === "string" ? p : p?.text || (p?.type === "image" ? "[图片]" : ""))).join(" ").slice(0, 1500);
      }
      if (role === "toolResult") text = `[工具结果 ${m.toolName || ""}] ${text.slice(0, 150)}`;
      if (text.trim()) parts.push(`${role}: ${text}`);
    }
    const inputText = parts.join("\n").slice(0, 60000).replace(/[\uD800-\uDFFF]/g, "") + (focus ? "[\n压缩焦点：" + focus + "]" : "");
    if (!inputText.trim()) return { skip: true, reason: "无可压缩的文本内容" };
    // 用 token 计划免费模型生成摘要（2026-08-19 用户定：deepseek 官方涨价贵，日常不用）；失败回退默认模型
    let summaryModel = _getModelList().find(m => m.provider === "sensenova" && /flash-lite/i.test(m.id))
      || _getModelList().find(m => m.provider === "xiaomi-token-plan-cn" && /mimo-v2\.5$/i.test(m.id));
    const prompt = `你是会话摘要助手。以下是 AI 助手与用户的一段早期对话记录。请生成结构化摘要，按下列六类保留关键信息：
1. 用户的核心诉求与任务目标
2. 已完成的事项与关键决策
3. 重要约定/路径/技术选型（保留具体文件名、路径、命令）
4. 错误与修复方式
5. 遗留问题与待办
6. 当前工作状态
要求：只留关键信息，总长不超过 400 字，按 1-6 编号要点列表输出。

对话记录：
${inputText}`;
    // 2026-10-24：先走我们自己的模型通道（按 provider 鉴权），再退回 deepseek 直连。
    // 起因：别人报"压缩失败"，根因是摘要**只**走硬编码 api.deepseek.com；这条老路在 402/密钥缺失时
    // 直接失败，而配置里的摘要模型（sensenova flash-lite 等）根本没被用上。
    let summary = "";
    let dcErr = "";
    const _extract = (r) => {
      if (!r) return "";
      if (typeof r === "string") return r;
      const c = r.content ?? r.message?.content ?? r.text;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : x?.text || "")).join("\n");
      return "";
    };
    if (summaryModel && typeof _unifiedChat === "function") {
      try {
        const r = await _unifiedChat(summaryModel, [{ role: "user", content: prompt }], {});
        summary = _extract(r).trim().slice(0, 3000);
        if (!summary) dcErr = "配置通道返回空摘要";
      } catch (e) { dcErr = "配置通道失败: " + String(e?.message || e).slice(0, 160); }
    }
    // 兜底：deepseek 官方直连（老路，配置通道不可用时才走）
    try {
      if (summary) throw { __skip: true };
      const _auth2 = _readJsonFile(path.join(_getAgentDir(), "auth.json"));
      const _dk = _auth2["deepseek"]?.key || _auth2["opencode-go"]?.key || "";
      const _url = "https://api.deepseek.com/v1/chat/completions";
      const _rr = await _summaryFetch(_url, { method: "POST", timeout: 90000,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${_dk}` },
        body: JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "user", content: prompt }], max_tokens: 8000 }) });
      if (_rr.ok) {
        const _dd = await _rr.json();
        summary = String((_dd?.choices?.[0]?.message?.content) || (_dd?.choices?.[0]?.message?.reasoning_content) || "").trim().slice(0, 3000);
        if (!summary) console.log("[元枢] compact 摘要响应异常: " + JSON.stringify(_dd).slice(0, 500));
      } else {
        dcErr = "HTTP " + _rr.status + ": " + String(await _rr.text()).slice(0, 200);
      }
    } catch (e) {
      if (!e?.__skip) dcErr = dcErr || String(e?.message || e).slice(0, 200);
    }
    if (!summary) return { skip: true, reason: "摘要生成失败: " + (dcErr || "响应无 content") };
    if (!lifecycle.current(token)) return { skip: true, reason: 'conversation_gone' };
    if (sessionFileVersion(file) !== originalVersion) return { skip: true, reason: 'session_changed' };
    try { appendArchiveJsonl(archivePathFor(file), toSummarize); } catch {}
    // 构造新文件：非消息条目 + compaction + 保留消息链（parentId 重链到 compaction）
    const compId = `comp_${Date.now().toString(36)}`;
    const compEntry = {
      type: "compaction", id: compId, parentId: null,
      timestamp: new Date().toISOString(), summary, firstKeptEntryId: cutMsg.id, tokensBefore: estTok,
      details: { via: "yuanshu-auto" },
    };
    // 保留链条：从 cutMsg 沿 parentId 收集所有后代
    const byId = new Map(entries.map(e => [e.id, e]));
    const byParent = new Map();
    for (const m of msgs) {
      const p = m.parentId;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(m);
    }
    const retained = [];
    const stack = [cutMsg.id];
    while (stack.length) {
      const id = stack.pop();
      const m = byId.get(id);
      if (!m || m.type !== "message") continue;
      retained.push(m);
      for (const child of (byParent.get(id) || [])) stack.push(child.id);
    }
    retained.sort((a, b) => entries.findIndex(e => e.id === a.id) - entries.findIndex(e => e.id === b.id));
    // 新数组：非消息条目（保持原序）+ compaction + 保留消息
    const newEntries = [];
    for (const e of entries) { if (e.type !== "message") newEntries.push(e); }
    newEntries.push(compEntry);
    let first = true;
    for (const m of retained) {
      const copy = { ...m };
      if (first) { copy.parentId = compId; first = false; }
      newEntries.push(copy);
    }
    // 备份 + 重写（SessionManager 的 _rewriteFile 全量写 fileEntries）
    try { fs.copyFileSync(file, file + ".bak"); } catch {}
    sm.fileEntries = newEntries;
    sm._rewriteFile();
    console.log(`[元枢] 分层记忆: ${file.split(/[\\/]/).pop()} ${(estTok / 1000).toFixed(0)}K→摘要(${summary.length}字), 保留 ${retained.length} 条消息`);
    return { summary, retained: retained.length, before: estTok };
  } catch (e) {
    console.log(`[元枢] 分层记忆跳过: ${String(e?.message || e).slice(0, 120)}`);
    return { skip: true, reason: "异常: " + String((e && (e.stack || e.message)) || e).slice(0, 500) };
  } finally {
    compactingSessions.delete(file);
    lifecycle.end(token);
  }
  return null;
}

export async function openSession(id) {
  const pending = lifecycle.find('opening', id);
  if (pending) return pending.promise;
  if (_activeSessions.has(id)) {
    const hit = _activeSessions.get(id);
    hit.lastUsed = Date.now();
    return hit;
  }
  evictInactiveSessions();
  const found = findSession(id);
  if (!found || !fs.existsSync(found.file)) return null;
  const token = lifecycle.begin('opening', id, found.file);
  token.promise = Promise.resolve().then(async () => {
    if (!lifecycle.current(token)) return null;
    // SDK 安全化（2026-09-18）：老会话里可能躺着 {type:"file"} / {type:"image",url} 这类块，
    // pi 的 provider 适配会把用户消息里的非 text 块写成 image_url(data:;base64,undefined) →
    // 整段会话每轮 400（assistant 里的附件块则让 token 估算器在发请求前 TypeError）。
    // 必须在 _SessionManager.open **之前**修，否则 SDK 读到的还是坏数据。
    if (_repairSessionFile) { try { _repairSessionFile(found.file); } catch {} }
    // DEBUG（2026-08-22 会话不存在排查）：临时日志
    // 超大会话先瘦身（避免加载 20MB+ 历史）
    await slimSessionImages(found.file);
    if (!lifecycle.current(token)) return null;
    // 分层记忆：会话历史超阈值时压缩早期消息为摘要（pi 引擎原生支持 compaction 条目）
    try { await compactSession(found.file, _getDefaultModel()); } catch {}
    if (!lifecycle.current(token)) return null;
    const sessionCwd = found.cwd || _cwd;
    let sm;
    try {
      sm = _SessionManager.open(found.file, path.dirname(found.file), sessionCwd);
    } catch (e) {
      // 会话文件损坏（历史 bug 可能产生）→ 跳过，不阻塞其他会话
      return null;
    }
    const agent = await _agentFactory(sm, _getDefaultModel());
    if (!lifecycle.current(token)) { disposeAgent(agent); return null; }
    const entry = { agent, sm, busy: false, lastUsed: Date.now() };
    // 恢复会话级模型选择（修复 A：LRU 淘汰/服务重启后不丢用户切的模型；handleChat 检测到不一致会自动重建 agent）
    const savedKey = _loadSessionModelKey ? _loadSessionModelKey(id) : null;
    if (savedKey) entry.modelKey = savedKey;
    _activeSessions.set(id, entry);
    return entry;
  }).finally(() => lifecycle.end(token));
  return token.promise;
}

// 压缩后的上下文规模：**不能**再拿上一条 assistant 的 usage 当数——
// compaction 保留了最近的消息，那条老记录里的 totalTokens（199k）还在，照着报就成了
// "压缩后可输出 0 token"（核对时真报出过这个假数）。
// 正确做法：从最后一条 compaction 往后的内容重新估（摘要 + 保留消息），与 compactSession
// 的阈值用同一套系数。
export function lastTurnContextTokens(entry, file = "") {
  const pick = (m) => {
    const u = m?.usage;
    if (!u) return 0;
    const n = Number(u.totalTokens) || (Number(u.input) || 0) + (Number(u.output) || 0) + (Number(u.cacheRead) || 0) + (Number(u.cacheWrite) || 0);
    return Number.isFinite(n) ? n : 0;
  };
  try {
    const roots = entry?.sm?.getTree?.();
    const flat = [];
    const walk = (n) => {
      if (!n) return;
      if (n.entry) flat.push(n.entry);
      const kids = n.children instanceof Map ? [...n.children.values()] : n.children;
      if (Array.isArray(kids)) for (const c of kids) walk(c);
    };
    if (Array.isArray(roots)) for (const r of roots) walk(r);
    for (let i = flat.length - 1; i >= 0; i--) {
      const m = flat[i]?.message;
      if (m?.role !== "assistant") continue;
      return pick(m);
    }
  } catch {}
  try {
    const f = file || entry?.sm?.getSessionFile?.();
    if (!f || !fs.existsSync(f)) return 0;
    const lines = fs.readFileSync(f, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]) continue;
      let e; try { e = JSON.parse(lines[i]); } catch { continue; }
      const m = e?.message;
      if (m?.role !== "assistant") continue;
      return pick(m);
    }
  } catch {}
  return 0;
}

// 创建 agent（pi CLI 同款 services 方式：正确注册工具 + 完整 model 触发工具调用）
let searchToolDef = null;
let searchToolInit = null;
export function setOnTheSpotFixRunner(fn) { _runOnTheSpotFix = typeof fn === "function" ? fn : null; }

export async function createSessionAgent(sm, model) {
  // pi SDK 是可选适配器。缺失时给统一引擎一个轻量会话壳，保留会话文件、打断和模型切换接口，
  // 避免“创建新会话”在真正进入元枢循环前就因 SDK 缺失崩溃。
  if (!_piPackage || typeof _createAgentSessionServices !== "function" || typeof _createAgentSessionFromServices !== "function") {
    return {
      model,
      subscribe() { return () => {}; },
      async abort() {},
      dispose() {},
      async setModel(next) { this.model = next; },
    };
  }
  const cwd = (typeof sm.getCwd === "function" && sm.getCwd()) || _cwd;
  try { console.log(`[agent] cwd=${cwd} default=${_cwd}`) } catch {}
  const settingsManager = _SettingsManager.create(cwd, _getAgentDir());
  const customTools = [];
  const { createRequire: teamRequire } = await import('node:module');
  customTools.push(createPiTeamTool(teamRequire(_piPackage)('typebox').Type));
  if (computerToolFactory) customTools.push(computerToolFactory(teamRequire(_piPackage)('typebox').Type, () => sm.getSessionId()));
  if (cultivationToolFactory) customTools.push(cultivationToolFactory(teamRequire(_piPackage)('typebox').Type));
  if (memoryToolFactory) customTools.push(memoryToolFactory(teamRequire(_piPackage)('typebox').Type));
  const st = await initSearchTool();
  if (st) customTools.push(st);
  const sh = await initShareTool();
  if (sh) customTools.push(sh);
  const mediaTools = await initPiMediaTools();
  if (Array.isArray(mediaTools)) customTools.push(...mediaTools);
  const skillTool = await initActivateSkillTool();
  if (skillTool) customTools.push(skillTool);
  // 当场修：把"干活时发现问题"接到"当场做掉"（同一个核心，见 engine/reflection-exec.mjs）
  const fixTool = await initFixProblemTool();
  if (fixTool) customTools.push(fixTool);
  // 双引擎：dsh（DeepSeek Harness）作为执行臂——pi 主引擎派单，dsh 干代码/沙箱活，pi 验收
  const dt = await _initDshTool();
  if (dt) customTools.push(dt);
  // 外部思考调试开关（externalThinking）：注入 think 工具让模型把推理写进工具参数
  if (_isExternalThinking()) {
    const thinkTool = await initPiThinkTool();
    if (thinkTool) customTools.push(thinkTool);
  }
  // 两阶段引导：首轮给文件核心 + 出片/查找/分享，避免只会 bash 考古。
  // 首个文本/工具事件后 promote 恢复完整集。PI_TWO_PHASE=0 关闭。
  const MIN_BOOTSTRAP = ["read", "write", "edit", "bash"].filter(t => _tools.includes(t));
  // 2026-10-28：首轮就把联网能力给她——不然微信第一条消息里她会说"我不会联网"
  const FIRST_TURN_EXTRA = ["web_search", "search_files", "list_channels", "generate_video", "generate_image", "generate_tts", "share_project", "activate_skill", "delegate_team", "computer_use", "cultivation"];
  const bootstrap = isFirstTurn(sm) && MIN_BOOTSTRAP.length >= 2 && process.env.PI_TWO_PHASE !== "0";
  const allowedTools = bootstrap
    ? [...new Set([...MIN_BOOTSTRAP, ...customTools.map(t => t.name).filter(n => MIN_BOOTSTRAP.includes(n) || FIRST_TURN_EXTRA.includes(n))])]
    : [...new Set([..._tools, ...customTools.map(t => t.name)])];
  if (bootstrap) console.log(`[agent] 两阶段引导：首轮最小工具集 ${allowedTools.join(", ")}（首个文本/工具后自动 promote 完整集）`);
  console.log(`[agent] 工具集: ${allowedTools.join(", ")}`);
  const services = await _createAgentSessionServices({
    cwd,
    agentDir: _getAgentDir(),
    settingsManager,
    modelRuntime: _getModelRuntime(),
  });
  // 完整 model（runtime 定义，含 compat——简版 {provider,id} 会导致工具不触发）
  // ⚠️ 若目标模型不是 SDK 认识的 provider（自定义 token-plan 中转如 sensenova/volces），SDK 会报
  // 「No API key found」——chat 直发 HTTP 无感知，但真 agent 会话必须落在原生 provider 上。
  // 兑底顺序：已配 key 的 deepseek → zai-coding-cn → xiaomi-token-plan-cn → nvidia → 表内第一个。
  let fullModel = model;
  try {
    const models = _getModelRuntime().getModels();
    fullModel = models.find(m => m.provider === model?.provider && m.id === model?.id) || null;
    if (!fullModel) {
      if (model?.provider) console.log(`[agent] ⚠️ ${model.provider}/${model.id} 不在 SDK provider 表（agent 会话不可用），自动兑底`);
      try {
        const auth = _readJsonFile(path.join(_getAgentDir(), "auth.json")) || {};
        // zai 优先（用户智谱 coding plan 刚充值且实测 agent 工具链可用）；
        // deepseek 殿后——有 key 但余额状态未知，历史 402 教训
        // ⚙️ 2026-08-28：跳过已冷却的 provider（之前撞过 401/402/403/429/529），避免外层 effModel 已换备选但这套兜底又把冷却 provider 捡回来
        for (const p of ["zai-coding-cn", "xiaomi-token-plan-cn", "nvidia", "deepseek"]) {
          if (!auth[p]?.key) continue;
          const m = models.find(x => x.provider === p);
          if (m && _isModelBlocked(m)) { console.log(`[agent] 兑底候选 ${p}/${m.id} 已冷却，跳过`); continue; }
          if (m) { fullModel = m; console.log(`[agent] 兑底模型 → ${p}/${m.id}`); break; }
        }
      } catch {}
      if (!fullModel) fullModel = models.find(m => m.provider === model?.provider) || model;
    }
  } catch { fullModel = model; }
  const created = await _createAgentSessionFromServices({
    services,
    sessionManager: sm,
    model: fullModel,
    thinkingLevel: process.env.PI_REASONING_LEVEL || "high",
    tools: allowedTools,
    customTools,
  });
  return created.session;
}

// 确保 entry 的 agent 存在（直调通道后 agent 可能被销毁，从 session 文件重建以恢复记忆）
export async function ensureAgent(entry, model) {
  const id = entry?.sm?.getSessionId?.(), file = entry?.sm?.getSessionFile?.();
  if (_activeSessions.get(id) !== entry || !file || !hasSessionFile(entry.sm, file)) throw conversationGone();
  if (entry.agent) return entry.agent;
  const pending = lifecycle.find('rebuilding', id);
  if (pending?.entry === entry) return pending.promise;
  const token = lifecycle.begin('rebuilding', id, file);
  token.entry = entry;
  token.promise = Promise.resolve().then(async () => {
    if (!lifecycle.current(token, hasSessionFile(entry.sm, file)) || _activeSessions.get(id) !== entry) throw conversationGone();
    // 会话级模型优先：会话自己切过模型则用它，否则用传入的（默认全局）
    const effModel = (entry?.modelKey && _getModelList().find(m => m.provider === entry.modelKey.provider && m.id === entry.modelKey.id))
      || model || _getDefaultModel();
    const agent = await _agentFactory(entry.sm, effModel);
    if (!lifecycle.current(token, hasSessionFile(entry.sm, file)) || _activeSessions.get(id) !== entry) {
      disposeAgent(agent); throw conversationGone();
    }
    entry.agent = agent;
    entry.agentModel = effModel ? { provider: effModel.provider, id: effModel.id } : null;
    console.log(`[元枢] agent 重建（模型 ${effModel?.provider}/${effModel?.id}）`);
    return agent;
  }).finally(() => lifecycle.end(token));
  return token.promise;
}

// 判断会话是否还没有任何对话消息（新会话首轮）
export async function deleteSession(id) {
  _clearSessionModelKey(id);
  const entry = _activeSessions.get(id);
  const found = findSession(id);
  const file = found?.file || entry?.sm?.getSessionFile?.() || lifecycle.fileFor(id);
  lifecycle.cancel(id, file);
  if (entry) {
    lazySessionManagers.delete(entry.sm);
    try { entry.agent.dispose(); } catch {}
    _activeSessions.delete(id);
  }
  invalidateSessionCache();
  if (file) {
    // 软删除：移入回收站目录（.trash），误删可找回
    const trashDir = path.join(path.dirname(file), ".trash");
    try {
      fs.mkdirSync(trashDir, { recursive: true });
      fs.renameSync(file, path.join(trashDir, path.basename(file)));
      invalidateSessionCache();
      return;
    } catch {}
    try { fs.unlinkSync(file); } catch {}
  }
}

// 从会话文件中提取消息（供历史渲染）——已拆到 engine/session-utils.mjs
// 从消息 content 提取文本（type: text 的块）——已拆到 engine/session-utils.mjs

// 从会话最新 assistant 消息提取文件附件（供 SSE 实时推送）
// 扫描工作空间里最近被工具创建/修改的文件（本轮产物），供前端展示文件卡片
// 排除：隐藏目录、node_modules、.git、backups、临时文件
const SCAN_EXCLUDE = /(^|[\\/])(node_modules|\.git|\.cache|backups?|temp|tmp|\.token)([\\/]|$)/i;
