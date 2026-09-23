// engine/session-manager.mjs —— 会话生命周期管理（2026-08-20 从 server.mjs 拆出）
// createSession/openSession/deleteSession/compactSession/slimSessionImages + agent 组装
// 依赖注入：initSessionManager({ cwd, sessionsDir, getModelList, getDefaultModel, activeSessions, SessionManager, SettingsManager, DefaultResourceLoader, getAgentDir, readJsonFile, writeJsonFile, initSearchTool, initShareTool, initDshTool, isExternalThinking, THINK_TOOL, modelCapabilities, bindOutputGuardDeps, extractMessages, createSseWriter, unifiedChat })
import fs from "node:fs";
import path from "node:path";
import { createPiTeamTool } from './team-tool-context.mjs';
import { invalidateSessionCache, getSessionList, findSession } from "./session-files.mjs";
import { appendSessionGroup } from "./session-groups.mjs";
import { appendArchiveJsonl, archivePathFor } from "./yuanshu-compact.mjs";
import { headroomCheck, estimateTokensFromText } from "./context-headroom.mjs";
import { execActivateSkill } from "./context-loader.mjs";
import { httpJsonFetch } from "./http.mjs";
import { wsSafePath } from "./workspace-api.mjs";
import { env } from "./env.mjs";

let _cwd = "", _sessionsDir = "", _tools = [], _getModelList = () => [], _getDefaultModel = () => null, _activeSessions = null, _createAgentSessionServices = null, _createAgentSessionFromServices = null, _getModelRuntime = () => null,
    _SessionManager = null, _SettingsManager = null, _DefaultResourceLoader = null, _getAgentDir = () => "", _readJsonFile = null, _writeJsonFile = null, _piPackage = "", _isModelBlocked = () => false,
    _initSearchTool = async () => null, _initShareTool = async () => null, _initDshTool = async () => null, _isExternalThinking = () => false, _THINK_TOOL = null,
    _generateMediaAsync = null,
    _modelCapabilities = null, _bindOutputGuardDeps = null, _extractMessages = null, _createSseWriter = null, _unifiedChat = null, _loadSessionModelKey = null, _onSessionCreated = null,
    _repairSessionFile = null;
export function initSessionManager({ cwd = "", sessionsDir = "", tools = [], piPackage = "", isModelBlocked = null, getModelList = null, getDefaultModel = null, activeSessions = null, SessionManager = null, SettingsManager = null, DefaultResourceLoader = null, getAgentDir = null, readJsonFile = null, writeJsonFile = null, initSearchTool = null, initShareTool = null, initDshTool = null, isExternalThinking = null, THINK_TOOL = null, modelCapabilities = null, bindOutputGuardDeps = null, extractMessages = null, createSseWriter = null, unifiedChat = null, createAgentSessionServices = null, createAgentSessionFromServices = null, getModelRuntime = null, loadSessionModelKey = null, generateMediaAsync = null, onSessionCreated = null, repairSessionFile = null } = {}) {
  _cwd = cwd; _sessionsDir = sessionsDir; _tools = tools; _piPackage = piPackage; if (isModelBlocked) _isModelBlocked = isModelBlocked; _activeSessions = activeSessions; _SessionManager = SessionManager; _SettingsManager = SettingsManager; _DefaultResourceLoader = DefaultResourceLoader; _readJsonFile = readJsonFile; _writeJsonFile = writeJsonFile;
  if (createAgentSessionServices) _createAgentSessionServices = createAgentSessionServices; if (createAgentSessionFromServices) _createAgentSessionFromServices = createAgentSessionFromServices; if (getModelRuntime) _getModelRuntime = getModelRuntime; if (loadSessionModelKey) _loadSessionModelKey = loadSessionModelKey;
  if (getModelList) _getModelList = getModelList; if (getDefaultModel) _getDefaultModel = getDefaultModel; if (getAgentDir) _getAgentDir = getAgentDir;
  if (initSearchTool) _initSearchTool = initSearchTool; if (initShareTool) _initShareTool = initShareTool; if (initDshTool) _initDshTool = initDshTool; if (isExternalThinking) _isExternalThinking = isExternalThinking; if (THINK_TOOL) _THINK_TOOL = THINK_TOOL;
  if (generateMediaAsync) _generateMediaAsync = generateMediaAsync;
  if (typeof onSessionCreated === "function") _onSessionCreated = onSessionCreated;
  if (typeof repairSessionFile === "function") _repairSessionFile = repairSessionFile;
  if (modelCapabilities) _modelCapabilities = modelCapabilities; if (bindOutputGuardDeps) _bindOutputGuardDeps = bindOutputGuardDeps; if (extractMessages) _extractMessages = extractMessages; if (createSseWriter) _createSseWriter = createSseWriter; if (unifiedChat) _unifiedChat = unifiedChat;
}

export async function createSession(name, { group } = {}) {
  const sm = _SessionManager.create(_cwd, _sessionsDir);
  const id = sm.getSessionId();
  const file = sm.getSessionFile();
  const g = group === "test" || group === "terminal" ? group : "workspace";
  // 2026-08-19 收敛：新会话一律用默认模型（千问）。不再继承 lastModelKey——
  //   否则用户切过的 nvidia/deepseek 残留会污染新会话默认（“后端不是千问”死循环根源）。
  //   用户切模型只锁当前会话（session-model-keys 持久化），新会话永远回到默认。
  let agent = null;
  let modelKey = null;
  agent = await createSessionAgent(sm, _getDefaultModel());
  _activeSessions.set(id, { agent, sm, busy: false, lastUsed: Date.now(), modelKey: _getDefaultModel() && _getDefaultModel().provider ? { provider: _getDefaultModel().provider, id: _getDefaultModel().id } : null, agentModel: _getDefaultModel() && _getDefaultModel().provider ? { provider: _getDefaultModel().provider, id: _getDefaultModel().id } : null });
  invalidateSessionCache(); // 新增会话 → 列表缓存失效
  if (name) { try { sm.appendSessionInfo(name); } catch {} }
  try { appendSessionGroup(file, g, name); } catch {}
  // 会话数据库编号在创建时立即落盘，避免必须手动点击“重建索引”才出现编号。
  try { await _onSessionCreated?.({ id, file, name: name || "新会话", group: g }); } catch {}
  return id;
}

// ── 活动会话 LRU 淘汰（防止长跑内存只增不减）──
const MAX_ACTIVE_SESSIONS = 30; // 保留上限；超过后淘汰最久未用且不忙的会话
export function evictInactiveSessions() {
  if (_activeSessions.size <= MAX_ACTIVE_SESSIONS) return;
  const idle = [..._activeSessions.entries()]
    .filter(([, e]) => !e.busy)
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
  let sm = null;
  try {
    const st = fs.statSync(file);
    // 只有超大会话（>3MB 或估算超阈值）才压缩，避免小会话频繁触发
    if (!force && st.size < 3 * 1024 * 1024) return;
    // 用引擎打开会话（pi-coding-agent 的 SessionManager，fileEntries 公开且完整）
    sm = _SessionManager.open(file, path.dirname(file), _cwd);
    const entries = sm.fileEntries || [];
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
    // 内联 deepseek 官方直连生成摘要（curl 已验证 200；directChat/unifiedChat 均存在中间层 400/回 null 问题，不再依赖）
    let summary = "";
    let dcErr = "";
    try {
      const _auth2 = _readJsonFile(path.join(_getAgentDir(), "auth.json"));
      const _dk = _auth2["deepseek"]?.key || _auth2["opencode-go"]?.key || "";
      const _url = "https://api.deepseek.com/v1/chat/completions";
      const _rr = await httpJsonFetch(_url, { method: "POST", timeout: 90000,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${_dk}` },
        body: JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "user", content: prompt }], max_tokens: 8000 }) });
      if (_rr.ok) {
        const _dd = await _rr.json();
        summary = String((_dd?.choices?.[0]?.message?.content) || (_dd?.choices?.[0]?.message?.reasoning_content) || "").trim().slice(0, 3000);
        if (!summary) console.log("[元枢] compact 摘要响应异常: " + JSON.stringify(_dd).slice(0, 500));
      } else {
        dcErr = "HTTP " + _rr.status + ": " + String(await _rr.text()).slice(0, 200);
      }
    } catch (e) { dcErr = String(e?.message || e).slice(0, 200); }
    if (!summary) return { skip: true, reason: "摘要生成失败: " + (dcErr || "响应无 content") };
    try { appendArchiveJsonl(archivePathFor(file), toSummarize); } catch {}
    // 构造新文件：非消息条目 + compaction + 保留消息链（parentId 重链到 compaction）
    const compId = `comp_${Date.now().toString(36)}`;
    const compEntry = {
      type: "compaction", id: compId, parentId: null,
      timestamp: new Date().toISOString(), summary, firstKeptEntryId: cutMsg.id, tokensBefore: estTok,
      details: { via: "pi-web-auto" },
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
  }
  return null;
}

export async function openSession(id) {
  if (_activeSessions.has(id)) {
    const hit = _activeSessions.get(id);
    hit.lastUsed = Date.now();
    return hit;
  }
  evictInactiveSessions();
  const found = findSession(id);
  if (!found) return null; // 08-29 修复：不存在的 id 直接 null（原来 found.file 直接炸 TypeError，调用方 404 分支永远走不到）
  // SDK 安全化（2026-09-18）：老会话里可能躺着 {type:"file"} / {type:"image",url} 这类块，
  // pi 的 provider 适配会把用户消息里的非 text 块写成 image_url(data:;base64,undefined) →
  // 整段会话每轮 400（assistant 里的附件块则让 token 估算器在发请求前 TypeError）。
  // 必须在 _SessionManager.open **之前**修，否则 SDK 读到的还是坏数据。
  if (_repairSessionFile) { try { _repairSessionFile(found.file); } catch {} }
  // DEBUG（2026-08-22 会话不存在排查）：临时日志
  // 超大会话先瘦身（避免加载 20MB+ 历史）
  await slimSessionImages(found.file);
  // 分层记忆：会话历史超阈值时压缩早期消息为摘要（pi 引擎原生支持 compaction 条目）
  try { await compactSession(found.file, _getDefaultModel()); } catch {}
  const sessionCwd = found.cwd || _cwd;
  let sm;
  try {
    sm = _SessionManager.open(found.file, path.dirname(found.file), sessionCwd);
  } catch (e) {
    // 会话文件损坏（历史 bug 可能产生）→ 跳过，不阻塞其他会话
      return null;
  }
  const agent = await createSessionAgent(sm, _getDefaultModel());
  const entry = { agent, sm, busy: false, lastUsed: Date.now() };
  // 恢复会话级模型选择（修复 A：LRU 淘汰/服务重启后不丢用户切的模型；handleChat 检测到不一致会自动重建 agent）
  const savedKey = _loadSessionModelKey ? _loadSessionModelKey(id) : null;
  if (savedKey) entry.modelKey = savedKey;
  _activeSessions.set(id, entry);
  return entry;
}

// 压缩后的上下文规模：**不能**再拿上一条 assistant 的 usage 当数——
// compaction 保留了最近的消息，那条老记录里的 totalTokens（199k）还在，照着报就成了
// "压缩后可输出 0 token"（核对时真报出过这个假数）。
// 正确做法：从最后一条 compaction 往后的内容重新估（摘要 + 保留消息），与 compactSession
// 的阈值用同一套系数。
export function estimateCompactedTokens(file) {
  try {
    if (!file || !fs.existsSync(file)) return 0;
    const entries = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    let cut = -1;
    for (let i = entries.length - 1; i >= 0; i--) if (entries[i].type === "compaction") { cut = i; break; }
    const from = cut >= 0 ? entries.slice(cut) : entries;
    let n = 0;
    for (const e of from) {
      if (e.type === "compaction") { n += estimateTokensFromText(String(e.summary || "")); continue; }
      if (e.type !== "message") continue;
      const m = e.message || {};
      const c = m.content;
      if (typeof c === "string") n += estimateTokensFromText(c);
      else if (Array.isArray(c)) for (const b of c) n += estimateTokensFromText(typeof b === "string" ? b : (b?.text || b?.thinking || ""));
    }
    return Math.round(n);
  } catch { return 0; }
}

// ══ 上下文余量闸门（2026-09-18）══════════════════════════════════════
// 真机事故：会话涨到 195k/200k 时，兼容适配器给模型的输出预算只剩 ~400 token，
// 答案在 387 token 被 length 截断，SDK 又把半截答案删掉重试（重试只吐 1 token）——
// 用户看到"说到一半被打断"。
// 这里在**开跑前**把会话压到有输出余量为止，然后重开会话让 SDK 读到压缩后的历史
// （压缩是改文件，内存里的 SessionManager 树不会自己刷新，必须重新 open）。
// 返回 { entry, before, after, compacted, reason }：entry 可能换成新的那个。
export async function ensureContextHeadroom(id, entry, model, { minOutput = 8192 } = {}) {
  const out = { entry, before: null, after: null, compacted: false, reason: "" };
  try {
    const found = findSession(id);
    const file = entry?.sm?.getSessionFile?.() || found?.file;
    if (!file || !fs.existsSync(file)) return out;
    const ctx = Number(model?.contextWindow) || 0;
    if (ctx <= 0) return out;                             // 不知道窗口就别乱压
    const used = lastTurnContextTokens(entry, file);
    out.before = { contextWindow: ctx, usedTokens: used };
    const before = headroomCheck({ contextWindow: ctx, usedTokens: used, declaredMaxTokens: model?.maxTokens, minOutput });
    if (!before.tight) return out;
    console.log(`[headroom] ${id}: 上下文 ${used}/${ctx}（占 ${Math.round(before.ratio * 100)}%），输出余量仅 ${before.room} token → 先压缩`);
    const r = await compactSession(file, model, true);
    out.compacted = !r?.skip;
    if (r?.skip) out.reason = r.reason || "compact-skip";
    // 压缩后重开会话：否则内存里的历史还是旧的，SDK 照样按满上下文发请求
    try { entry?.agent?.dispose?.(); } catch {}
    _activeSessions.delete(id);
    const reopened = await openSession(id);
    if (reopened) out.entry = reopened;
    const est = out.compacted ? estimateCompactedTokens(file) : 0;
    const used2 = out.compacted && est > 0 ? est : lastTurnContextTokens(out.entry, file);
    out.after = { contextWindow: ctx, usedTokens: used2 };
    out.freed = Math.max(0, (out.before?.usedTokens || 0) - used2);
    const after = headroomCheck({ contextWindow: ctx, usedTokens: used2, declaredMaxTokens: model?.maxTokens, minOutput });
    out.roomAfter = after.room;
    if (!out.compacted && !r?.skip) out.reason = "compact-null";
    console.log(`[headroom] ${id}: 压缩${out.compacted ? "完成" : "跳过(" + out.reason + ")"} → 上下文 ${used2}/${ctx}，输出余量 ${after.room} token`);
  } catch (e) {
    out.reason = String(e?.message || e).slice(0, 120);
    console.log(`[headroom] 余量闸门异常（不阻断本轮）: ${out.reason}`);
  }
  return out;
}

// 会话最后一条 assistant 记录的上下文规模（provider 的 totalTokens，含 cacheRead）
// 内存树优先（刚跑完的那轮就在里面），读不到再退回文件尾部。
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
export async function initSearchTool() {
  if (searchToolDef) return searchToolDef;
  try {
    // typebox 在 pi 引擎的依赖里，用 createRequire 从引擎路径解析
    const { createRequire } = await import("node:module");
    // 用 _piPackage（引擎入口路径，server 顶部已验证可用）解析 typebox
    const req2 = createRequire(_piPackage);
    const { Type } = req2("typebox");
    const fb = await import("./filebox.mjs");
    searchToolDef = {
      name: "search_files",
      label: "搜索工作空间文件",
      description: "在本地工作空间搜索文件（按关键词/类型）。当用户要求发送/查看/交付某个文件、或不确定文件在哪时使用。搜索是本地执行的，速度快、结果准确。",
      promptSnippet: "用户要文件时，先用 search_files 找到准确路径，再用 📎 交付 标记交付",
      promptGuidelines: [
        "Use search_files when the user asks to send/deliver/find a file, or when you need a specific file's path.",
        "Pass the user's words as query (e.g. '酒店的ppt'), optionally types=['.ppt','.pptx'].",
        "After search, deliver the chosen file(s) with 📎 交付: <path> at the end of your reply.",
      ],
      parameters: Type.Object({
        query: Type.String({ description: "搜索关键词（用户原话或提取的关键词）" }),
        types: Type.Optional(Type.Array(Type.String({ description: "文件扩展名过滤，如 ['.png','.jpg']" }))),
      }),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const wsRoot = _cwd || process.cwd();
        const files = fb.findFiles(wsRoot, { query: params.query || "", types: params.types || null, max: 10 });
        return {
          content: [{ type: "text", text: fb.findResultText(files, wsRoot) }],
          details: { files: files.map(f => ({ name: f.name, path: f.path })) },
        };
      },
    };
  } catch (e) {
    console.log(`[元枢] search_files 工具初始化失败: ${String(e?.message || e).slice(0, 80)}`);
  }
  return searchToolDef;
}

// 技能渐进式披露工具：统一引擎已有 activate_skill，Pi SDK 会话也必须注册同一能力。
// 之前只把技能摘要写进 system prompt，却没有把工具传给 AgentSession，模型于是把
// <tool_call> 当普通文本吐出，PPT 等需要技能正文的任务会停在计划阶段。
let activateSkillToolDef = null;
// 当场修（fix_problem）：执行器由 server 注入（它才知道用哪个模型、哪套工具跑执行轮）。
let fixProblemToolDef = null;
let _runOnTheSpotFix = null;
export function setOnTheSpotFixRunner(fn) { _runOnTheSpotFix = typeof fn === "function" ? fn : null; }

export async function initActivateSkillTool() {
  if (activateSkillToolDef) return activateSkillToolDef;
  try {
    const { createRequire } = await import("node:module");
    const req2 = createRequire(_piPackage);
    const { Type } = req2("typebox");
    activateSkillToolDef = {
      name: "activate_skill",
      label: "加载技能",
      description: "加载技能全文和资源清单。用户任务匹配技能库摘要时调用；参数优先传 name，也兼容旧格式 skill。",
      promptSnippet: "匹配到技能时先调用 activate_skill 加载全文，再按技能执行",
      promptGuidelines: [
        "When a task matches a skill in the skill catalog, call activate_skill with its exact name before doing the work.",
        "For PPT requests, load ppt-generator or ppt-html, then execute the complete generation workflow and deliver the actual file.",
      ],
      parameters: Type.Object({
        name: Type.Optional(Type.String({ description: "技能名称，如 ppt-generator 或 ppt-html" })),
        skill: Type.Optional(Type.String({ description: "兼容旧调用：技能名称" })),
      }),
      async execute(toolCallId, params) {
        const name = String(params?.name || params?.skill || "").trim();
        if (!name) return { content: [{ type: "text", text: "缺少技能名称（请传 name）" }], isError: true };
        const result = execActivateSkill(name);
        return { content: [{ type: "text", text: result.text }], isError: !!result.isError };
      },
    };
  } catch (e) {
    console.log(`[元枢] activate_skill 工具初始化失败: ${String(e?.message || e).slice(0, 100)}`);
  }
  return activateSkillToolDef;
}

// 外部思考调试工具的 SDK 形态。server 里的 THINK_TOOL 是 OpenAI schema，不能直接
// 放进 Pi SDK customTools；转换后只在开启调试开关时注册，避免定义格式不匹配导致 agent 启动崩溃。
let piThinkToolDef = null;
async function initPiThinkTool() {
  if (piThinkToolDef) return piThinkToolDef;
  try {
    const { createRequire } = await import("node:module");
    const req2 = createRequire(_piPackage);
    const { Type } = req2("typebox");
    piThinkToolDef = {
      name: "think",
      label: "思考草稿",
      description: "调试用草稿工具，把动手前的分析写进 content；不会展示给用户或写入会话文件。",
      promptSnippet: "需要调试推理时调用 think 写下分析草稿",
      parameters: Type.Object({ content: Type.String({ description: "推理草稿" }) }),
      async execute(toolCallId, params) {
        return { content: [{ type: "text", text: "思考草稿已记录（仅调试，不展示给用户）" }], details: { thinking: String(params?.content || "") } };
      },
    };
  } catch (e) {
    console.log(`[元枢] think 工具初始化失败: ${String(e?.message || e).slice(0, 100)}`);
  }
  return piThinkToolDef;
}

// 外网分享工具：模型只需传项目路径，本地系统复制到外网分享目录并返回链接
// 模型永远不需要碰 cloudflared/隧道/端口——分享是自动的
let shareToolDef = null;
export async function initShareTool() {
  if (shareToolDef) return shareToolDef;
  try {
    const { createRequire } = await import("node:module");
    const req2 = createRequire(_piPackage);
    const { Type } = req2("typebox");
    shareToolDef = {
      name: "share_project",
      label: "外网分享项目",
      description: "把项目/网页分享到外网。当用户要求分享链接、外网访问、上线预览、给别人看时使用。只需传入项目路径，本地系统自动处理（复制到分享目录 + 返回公网链接），不需要也不应该手动操作 cloudflared/隧道/端口/DNS。",
      promptSnippet: "用户要分享/外链时，用 share_project 传入项目目录即可，勿动隧道",
      promptGuidelines: [
        "Use share_project when the user asks to share a project online, get a public link, or preview externally.",
        "Pass the project directory path (e.g. 工程/项目名 or 交付/xxx). Never touch cloudflared/config.yml/ports/DNS manually.",
        "The tool returns a public URL — show it to the user directly.",
      ],
      parameters: Type.Object({
        path: Type.String({ description: "要分享的项目目录或文件（工作空间相对路径），如 工程/贪吃蛇" }),
      }),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const src = params.path || "";
        const wsRoot = _cwd;
        const safe = wsSafePath(src);
        if (!safe || !fs.existsSync(safe)) {
          return { content: [{ type: "text", text: `项目不存在: ${src}。请先用 search_files 找到正确路径。` }] };
        }
        const shareDir = path.join(wsRoot, "外网分享");
        fs.mkdirSync(shareDir, { recursive: true });
        const base = path.basename(safe);
        const target = path.join(shareDir, base);
        // 复制到分享目录（目录递归复制，文件直接复制）
        try {
          if (fs.statSync(safe).isDirectory()) {
            fs.cpSync(safe, target, { recursive: true, force: true });
          } else {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(safe, target);
          }
        } catch (e) {
          return { content: [{ type: "text", text: `复制失败: ${String(e?.message || e).slice(0, 80)}` }] };
        }
        const host = env("SHARE_HOST") || "share.myxinyu.xin";
        const isHtml = fs.existsSync(path.join(target, "index.html"));
        const url = `https://${host}/${encodeURIComponent(base)}${isHtml ? "/" : ""}`;
        return {
          content: [{ type: "text", text: `✅ 已分享到外网：${url}\n（项目已复制到 外网分享/${base}）` }],
          details: { url, path: `外网分享/${base}` },
        };
      },
    };
  } catch (e) {
    console.log(`[元枢] share_project 工具初始化失败: ${String(e?.message || e).slice(0, 80)}`);
  }
  return shareToolDef;
}

let piMediaTools = null;
export async function initPiMediaTools() {
  if (piMediaTools) return piMediaTools;
  try {
    const { createRequire } = await import("node:module");
    const req2 = createRequire(_piPackage);
    const { Type } = req2("typebox");
    const { createPiMediaTools } = await import("./pi-media-tools.mjs");
    piMediaTools = createPiMediaTools({
      Type,
      generateMediaAsync: _generateMediaAsync,
      getModelList: _getModelList,
    });
  } catch (e) {
    console.log(`[元枢] 宿主媒体工具初始化失败: ${String(e?.message || e).slice(0, 80)}`);
    piMediaTools = [];
  }
  return piMediaTools;
}

export async function initFixProblemTool() {
  if (fixProblemToolDef) return fixProblemToolDef;
  if (typeof _runOnTheSpotFix !== "function") return null; // 没注入执行器就不注册（fail-closed）
  try {
    const { createRequire } = await import("node:module");
    const req2 = createRequire(_piPackage);
    const { Type } = req2("typebox");
    fixProblemToolDef = {
      name: "fix_problem",
      label: "当场修",
      description: "干活时发现一个当场能修的问题（代码/测试/配置/文档/脚本的小毛病），调它当场派一轮去修并拿回证据。需要人拍板的事（权限/密钥/部署/推送/删数据/花钱）不要用它——写进结论交给用户。同一会话 10 分钟内最多 3 次。",
      promptSnippet: "发现问题就当场修（fix_problem），别只在结论里列一条建议",
      promptGuidelines: [
        "When you notice a problem you can fix right now in this workspace, call fix_problem once with a concrete one-line description instead of only listing it in your answer.",
        "Never use fix_problem for things needing human approval (permissions, secrets, deploys, pushes, deleting data, spending money) — report those instead.",
      ],
      parameters: Type.Object({
        problem: Type.String({ description: "要修什么，一句话，具体到可核查（≤60 字）" }),
      }),
      async execute(toolCallId, params, ctx) {
        const out = await _runOnTheSpotFix({
          problem: params?.problem,
          sessionKey: ctx?.sessionKey || ctx?.sessionId || "anon",
        });
        return { content: [{ type: "text", text: String(out?.text || "（没有结果）") }], isError: !out?.ok };
      },
    };
    return fixProblemToolDef;
  } catch (e) {
    console.log(`[元枢] fix_problem 工具初始化失败: ${String(e?.message || e).slice(0, 80)}`);
    return null;
  }
}

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
  const settingsManager = _SettingsManager.create(cwd, _getAgentDir());
  const customTools = [];
  const { createRequire: teamRequire } = await import('node:module');
  customTools.push(createPiTeamTool(teamRequire(_piPackage)('typebox').Type));
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
  const FIRST_TURN_EXTRA = ["search_files", "list_channels", "generate_video", "generate_image", "generate_tts", "share_project", "activate_skill", "delegate_team"];
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
  if (entry.agent) return entry.agent;
  // 会话级模型优先：会话自己切过模型则用它，否则用传入的（默认全局）
  const effModel = (entry?.modelKey && _getModelList().find(m => m.provider === entry.modelKey.provider && m.id === entry.modelKey.id))
    || model || _getDefaultModel();
  const agent = await createSessionAgent(entry.sm, effModel);
  entry.agent = agent;
  entry.agentModel = effModel ? { provider: effModel.provider, id: effModel.id } : null;
  console.log(`[元枢] agent 重建（模型 ${effModel?.provider}/${effModel?.id}）`);
  return agent;
}

// 判断会话是否还没有任何对话消息（新会话首轮）
export function isFirstTurn(sm) {
  try {
    const roots = sm.getTree() || [];
    const hasMsg = roots.some(n => n.entry?.type === "message" && ["user", "assistant"].includes(n.entry?.message?.role));
    return !hasMsg;
  } catch { return false; }
}

function _clearSessionModelKey(sid) {
  try {
    const p = path.join(_getAgentDir(), "session-model-keys.json");
    const d = _readJsonFile(p) || {};
    if (d[sid]) { delete d[sid]; _writeJsonFile(p, d); }
  } catch {}
}

export async function deleteSession(id) {
  _clearSessionModelKey(id);
  const entry = _activeSessions.get(id);
  if (entry) {
    try { entry.agent.dispose(); } catch {}
    _activeSessions.delete(id);
  }
  const found = findSession(id);
  if (found?.file) {
    // 软删除：移入回收站目录（.trash），误删可找回
    const trashDir = path.join(path.dirname(found.file), ".trash");
    try {
      fs.mkdirSync(trashDir, { recursive: true });
      fs.renameSync(found.file, path.join(trashDir, path.basename(found.file)));
      invalidateSessionCache();
      return;
    } catch {}
    try { fs.unlinkSync(found.file); } catch {}
  }
}

// 从会话文件中提取消息（供历史渲染）——已拆到 engine/session-utils.mjs
// 从消息 content 提取文本（type: text 的块）——已拆到 engine/session-utils.mjs

// 从会话最新 assistant 消息提取文件附件（供 SSE 实时推送）
// 扫描工作空间里最近被工具创建/修改的文件（本轮产物），供前端展示文件卡片
// 排除：隐藏目录、node_modules、.git、backups、临时文件
const SCAN_EXCLUDE = /(^|[\\/])(node_modules|\.git|\.cache|backups?|temp|tmp|\.token)([\\/]|$)/i;
