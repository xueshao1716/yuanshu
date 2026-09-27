// engine/stats-api.mjs —— 统计/技能/导出/重命名（2026-08-20 从 server.mjs 拆出）
// 依赖：json(http-utils)、scanSessionFiles/parseSessionFile/getSessionList/readEntriesFromFile/invalidateSessionCache(session-files)、extractMessages(session-utils)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { json } from "./http-utils.mjs";
import { scanSessionFiles, parseSessionFile, getSessionList, findSession, readEntriesFromFile, invalidateSessionCache } from "./session-files.mjs";
import { extractMessages } from "./session-utils.mjs";
import { sanitizeText } from "./sanitize.mjs";

let _getAgentDir = () => "", _cwd = "", _DefaultResourceLoader = null;
// 08-29 修复：handleStats/handleCompact/handleRename 引用 openSession/ensureAgent/defaultModel 但从未注入
//（8/20 拆分裸引用漏网，三个 API 坏了 9 天：/api/sessions/:id/stats|compact|rename）
let _openSession = null, _ensureAgent = null, _getDefaultModel = () => null, _subagentHistoryProvider = null;
export function initStatsApi({ getAgentDir = null, cwd = "", DefaultResourceLoader = null, openSession = null, ensureAgent = null, getDefaultModel = null, subagentHistoryProvider = null } = {}) {
  if (getAgentDir) _getAgentDir = getAgentDir; _cwd = cwd; _DefaultResourceLoader = DefaultResourceLoader;
  if (openSession) _openSession = openSession; if (ensureAgent) _ensureAgent = ensureAgent; if (getDefaultModel) _getDefaultModel = getDefaultModel;
  if (subagentHistoryProvider) _subagentHistoryProvider = subagentHistoryProvider;
}

// ── 逐文件用量缓存（2026-09-20）────────────────────────────────────────────────
// 背景：工作台加载要打 /api/stats/providers（真机 4.3s）与 /api/run/overview（10.5s），
// 根因是这里把每个会话文件整读 + 逐行 JSON.parse，而页面每 8–60 秒还会再打一次。
// 做法：按 mtime+size 判"没变就复用上次的解析结果"，并把结果统一成 entries 供两个接口共用。
const __usageCache = new Map(); // file -> { mtimeMs, size, entries }
function sessionUsageEntries(file) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  const hit = __usageCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.entries;
  const entries = [];
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    for (const line of lines) {
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (!e || e.type !== "message" || e.message?.role !== "assistant" || !e.message?.usage) continue;
      const u = e.message.usage;
      let c = u.cost;
      if (c && typeof c === "object") c = c.total || c.input || 0;
      entries.push({
        provider: e.message.provider || "unknown",
        model: e.message.model || "unknown",
        input: u.input || 0, output: u.output || 0,
        cacheRead: u.cacheRead || 0, cacheWrite: u.cacheWrite || 0,
        cost: typeof c === "number" ? c : 0,
      });
    }
  } catch {}
  __usageCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, entries });
  return entries;
}
function pruneUsageCache(files) {
  if (__usageCache.size <= files.length * 2 + 64) return;
  const keep = new Set(files);
  for (const k of [...__usageCache.keys()]) if (!keep.has(k)) __usageCache.delete(k);
}

export async function handleGlobalStats(res) {
  const files = scanSessionFiles();
  const rows = [];
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 0 };
  for (const file of files) {
    const info = parseSessionFile(file);
    const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 0 };
    const entries = sessionUsageEntries(file) || [];
    for (const e of entries) {
      t.input += e.input; t.output += e.output;
      t.cacheRead += e.cacheRead; t.cacheWrite += e.cacheWrite;
      t.cost += e.cost; t.messages++;
    }
    if (!t.messages) continue;
    totals.input += t.input; totals.output += t.output;
    totals.cacheRead += t.cacheRead; totals.cacheWrite += t.cacheWrite;
    totals.cost += t.cost; totals.messages += t.messages;
    rows.push({ id: info.id, name: info.name || "新会话", updatedAt: info.updatedAt, tokens: t });
  }
  pruneUsageCache(files);
  rows.sort((a, b) => b.tokens.cost - a.tokens.cost);
  json(res, 200, { sessions: rows, totals, count: rows.length });
}

// GET /api/stats/providers —— 按 provider/model 聚合用量（监控各模型商消耗）
export async function handleProviderStats(res) {
  const files = scanSessionFiles();
  const provMap = new Map(); // provider -> { input, output, cacheRead, cost, messages, models: Map(model -> {input,output,cost,messages}) }
  for (const file of files) {
    const entries = sessionUsageEntries(file) || [];
    for (const e of entries) {
      const prov = e.provider, model = e.model, c = e.cost;
      const p = provMap.get(prov) || { provider: prov, input: 0, output: 0, cacheRead: 0, cost: 0, messages: 0, models: new Map() };
      p.input += e.input; p.output += e.output; p.cacheRead += e.cacheRead;
      p.cost += c; p.messages++;
      const mm = p.models.get(model) || { model, input: 0, output: 0, cost: 0, messages: 0 };
      mm.input += e.input; mm.output += e.output; mm.cost += c; mm.messages++;
      p.models.set(model, mm);
      provMap.set(prov, p);
    }
  }
  pruneUsageCache(files);
  const providers = [...provMap.values()]
    .map(p => ({
      provider: p.provider, input: p.input, output: p.output, cacheRead: p.cacheRead,
      cost: Math.round(p.cost * 10000) / 10000, messages: p.messages,
      models: [...p.models.values()].map(m => ({ ...m, cost: Math.round(m.cost * 10000) / 10000 })).sort((a, b) => b.cost - a.cost),
    }))
    .sort((a, b) => b.cost - a.cost);
  const totalCost = Math.round(providers.reduce((a, p) => a + p.cost, 0) * 10000) / 10000;
  json(res, 200, { providers, totalCost, updatedAt: new Date().toISOString() });
}

// ── 7 天用量分桶（09-03，工作台图表）：按 entry.timestamp 逐日聚合 usage，60s 内存缓存 ──
let _dailyCache = { at: 0, data: null };
export async function handleDailyStats(res) {
  const now = Date.now();
  if (_dailyCache.data && now - _dailyCache.at < 60_000) return json(res, 200, _dailyCache.data);
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now - i * 86400_000);
    days.push({
      key: d.toISOString().slice(0, 10),
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      input: 0, output: 0, cost: 0, messages: 0, sessions: new Set(),
    });
  }
  const byKey = new Map(days.map(d => [d.key, d]));
  for (const file of scanSessionFiles()) {
    try {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (!e || e.type !== "message" || e.message?.role !== "assistant" || !e.message?.usage) continue;
        const key = String(e.timestamp || "").slice(0, 10);
        const d = byKey.get(key);
        if (!d) continue;
        const u = e.message.usage;
        let c = u.cost;
        if (c && typeof c === "object") c = c.total || c.input || 0;
        d.input += u.input || 0; d.output += u.output || 0;
        d.cost += typeof c === "number" ? c : 0; d.messages++;
        if (e.id && typeof e.id === "string") d.sessions.add(e.id);
      }
    } catch {}
  }
  const out = {
    days: days.map(d => ({ day: d.key, label: d.label, input: d.input, output: d.output, cost: Math.round(d.cost * 10000) / 10000, messages: d.messages, sessions: d.sessions.size })),
    updatedAt: new Date().toISOString(),
  };
  _dailyCache = { at: now, data: out };
  json(res, 200, out);
}

// ── 子智能体工作记录（只读）：mission/run/artifact 的安全摘要 ──
// 记录由 pi-subagents 写在项目/用户目录的 missions，异步执行器写在系统临时目录。
// 这里只读 status/meta，不返回 transcript、请求正文、绝对路径或大段模型输出。
const SUBAGENT_VALID_STATES = new Set(["queued", "running", "active", "waiting", "needs_attention", "paused", "completed", "complete", "failed", "done", "stopped"]);
const SUBAGENT_LIMITS = { missions: 80, runs: 160, artifacts: 16, text: 280, list: 12 };
const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function clip(value, max = SUBAGENT_LIMITS.text) {
  const text = String(value ?? "").trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function safeClip(value, max = SUBAGENT_LIMITS.text) {
  return clip(sanitizeText(value), max);
}

function asIso(value, fallback = null) {
  if (value == null || value === "") return fallback;
  const numeric = typeof value === "number" || /^\d+(?:\.\d+)?$/.test(String(value));
  const date = new Date(numeric ? Number(value) : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function readObject(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch { return null; }
}

function uniquePaths(values) {
  const seen = new Set();
  return values.map(value => String(value || "").trim()).filter(Boolean).map(value => path.resolve(value)).filter(value => {
    if (!value || seen.has(value)) return false;
    seen.add(value); return true;
  });
}

function relativeArtifactPath(file, roots) {
  const absolute = path.resolve(String(file || ""));
  for (const root of roots) {
    const rel = path.relative(path.resolve(root), absolute);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel.replaceAll("\\", "/");
  }
  return path.basename(absolute) || "artifact";
}

function safeWorkspaceRef(value) {
  const text = String(value || "").trim();
  if (!text) return undefined;
  // A mission's cwd helps identify the project, but never expose a host path.
  const normalized = text.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length ? `…/${parts.at(-1)}` : undefined;
}

function walkFiles(root, depth = 2, out = []) {
  if (!root || depth < 0 || out.length >= 500) return out;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (out.length >= 500) break;
    const full = path.join(root, entry.name);
    if (entry.isFile()) out.push(full);
    else if (entry.isDirectory() && depth > 0) walkFiles(full, depth - 1, out);
  }
  return out;
}

function metadataIndex(artifactRoots) {
  const index = new Map();
  for (const file of artifactRoots.flatMap(root => walkFiles(root, 2))) {
    if (!/_meta\.json$/i.test(file)) continue;
    const meta = readObject(file);
    const id = String(meta?.runId || "").trim();
    if (id && !index.has(id)) index.set(id, meta);
  }
  return index;
}

function listStrings(value, max = SUBAGENT_LIMITS.list) {
  return Array.isArray(value) ? value.map(item => safeClip(item, 220)).filter(Boolean).slice(0, max) : [];
}

function enrichRun(run, { source = "mission", missionId = null, meta = null } = {}) {
  const id = String(run?.runId || run?.id || "").trim();
  const child = meta?.childReport || {};
  const state = String(run?.state || run?.status || meta?.status || "unknown");
  const normalized = {
    id: id || "unknown",
    runId: id || "unknown",
    source,
    missionId: missionId || undefined,
    agent: safeClip(run?.agent || run?.agentName || meta?.agent || meta?.agentName || run?.steps?.[0]?.agent || "子智能体", 80),
    state: SUBAGENT_VALID_STATES.has(state) ? state : "unknown",
    status: SUBAGENT_VALID_STATES.has(state) ? state : "unknown",
    task: safeClip(run?.task || run?.taskPreview || run?.label || meta?.task || "", 180),
    startedAt: asIso(run?.startedAt || run?.createdAt || meta?.startedAt),
    updatedAt: asIso(run?.updatedAt || run?.lastUpdate || run?.endedAt || run?.completedAt || meta?.lastUpdate || meta?.completedAt),
    completedAt: asIso(run?.completedAt || meta?.completedAt),
    durationMs: Number.isFinite(Number(run?.durationMs)) ? Number(run.durationMs) : (Number.isFinite(Number(meta?.durationMs)) ? Number(meta.durationMs) : null),
    model: safeClip(typeof (run?.model || meta?.model) === "string" ? (run?.model || meta?.model) : (run?.model?.id || meta?.model?.id || ""), 120) || undefined,
    toolCount: Number.isFinite(Number(run?.toolCount)) ? Number(run.toolCount) : (Number.isFinite(Number(meta?.toolCount)) ? Number(meta.toolCount) : 0),
    eventCount: Number.isFinite(Number(run?.eventCount)) ? Number(run.eventCount) : undefined,
    error: safeClip(run?.error || meta?.error || "", 280) || undefined,
    acceptanceStatus: safeClip(run?.acceptance?.status || meta?.acceptance?.status || child?.acceptance?.status || "", 80) || undefined,
    reviewFindings: listStrings(run?.reviewFindings || child?.reviewFindings),
    residualRisks: listStrings(run?.residualRisks || child?.residualRisks),
  };
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined));
}

function missionArtifacts(items, artifactRoots) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, SUBAGENT_LIMITS.artifacts).map(item => {
    const raw = typeof item === "string" ? item : item?.path;
    if (!raw) return null;
    const absolute = String(raw);
    const name = path.basename(absolute) || "artifact";
    return {
      kind: clip(item?.kind || "other", 40),
      name: clip(name, 120),
      path: clip(relativeArtifactPath(absolute, artifactRoots), 180),
      description: safeClip(item?.description || "", 180) || undefined,
    };
  }).filter(Boolean);
}

export function collectSubagentHistory({ missionRoots = [], asyncRoots = [], artifactRoots = [] } = {}) {
  const roots = uniquePaths(missionRoots);
  const asyncDirs = uniquePaths(asyncRoots);
  const artifacts = uniquePaths(artifactRoots);
  const metaByRun = metadataIndex(artifacts);
  const missions = [];
  const missionSeen = new Set();
  const allRuns = new Map();

  for (const root of roots) {
    let files = [];
    try { files = fs.readdirSync(root).filter(name => name.endsWith(".json")).map(name => path.join(root, name)); } catch {}
    for (const file of files) {
      const mission = readObject(file);
      const id = String(mission?.id || path.basename(file, ".json")).trim();
      if (!mission || missionSeen.has(id)) continue;
      missionSeen.add(id);
      const missionRuns = Array.isArray(mission.runs) ? mission.runs.slice(0, SUBAGENT_LIMITS.runs).map((run, index) => {
        const enriched = enrichRun(run, { source: "mission", missionId: id, meta: metaByRun.get(run?.runId || run?.id) });
        if (enriched.runId !== "unknown") return enriched;
        const syntheticId = `${id || "mission"}:run-${index + 1}`;
        return { ...enriched, id: syntheticId, runId: syntheticId };
      }) : [];
      for (const run of missionRuns) if (!allRuns.has(run.runId)) allRuns.set(run.runId, run);
      missions.push({
        id,
        title: safeClip(mission.title || id, 180),
        objective: safeClip(mission.objective || "", 280),
        status: clip(mission.status || "unknown", 60),
        createdAt: asIso(mission.createdAt),
        updatedAt: asIso(mission.updatedAt || mission.createdAt),
        cwd: safeWorkspaceRef(mission.cwd),
        summary: safeClip(mission.summary || "", 360) || undefined,
        acceptanceStatus: safeClip(mission.acceptance?.status || "", 80) || undefined,
        runs: missionRuns,
        artifacts: missionArtifacts(mission.artifacts, artifacts),
      });
    }
  }

  for (const root of asyncDirs) {
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(root, entry.name)); } catch {}
    for (const dir of dirs) {
      const statusPath = path.join(dir, "status.json");
      const status = readObject(statusPath);
      if (!status) continue;
      const eventPath = path.join(dir, "events.jsonl");
      let eventCount = 0;
      try { eventCount = fs.readFileSync(eventPath, "utf8").split(/\r?\n/).filter(Boolean).length; } catch {}
      const rawRun = enrichRun({ ...status, eventCount }, { source: "async", meta: status });
      const run = rawRun.runId === "unknown"
        ? { ...rawRun, id: `async:${path.basename(dir)}`, runId: `async:${path.basename(dir)}` }
        : rawRun;
      if (!allRuns.has(run.runId) || allRuns.get(run.runId).source === "async") allRuns.set(run.runId, run);
    }
  }

  const byUpdated = (a, b) => (Date.parse(b?.updatedAt || b?.createdAt || b?.startedAt || "") || 0) - (Date.parse(a?.updatedAt || a?.createdAt || a?.startedAt || "") || 0);
  missions.sort(byUpdated);
  const runs = [...allRuns.values()].sort(byUpdated).slice(0, SUBAGENT_LIMITS.runs);
  return {
    updatedAt: new Date().toISOString(),
    counts: { missions: missions.length, runs: runs.length, failed: runs.filter(run => ["failed", "stopped"].includes(run.state)).length },
    missions: missions.slice(0, SUBAGENT_LIMITS.missions),
    runs,
  };
}

function defaultSubagentHistoryRoots() {
  const home = os.homedir();
  const username = (() => { try { return os.userInfo().username; } catch { return process.env.USERNAME || process.env.USER || "user"; } })();
  const tempRoot = path.join(os.tmpdir(), `pi-subagents-user-${String(username).replace(/[^a-zA-Z0-9_-]/g, "-")}`, "async-subagent-runs");
  const missionRoots = [path.join(MODULE_ROOT, ".pi-subagents", "missions"), path.join(_cwd, ".pi-subagents", "missions"), path.join(home, ".pi-subagents", "missions")];
  const artifactRoots = [path.join(MODULE_ROOT, ".pi-subagents", "artifacts"), path.join(_cwd, ".pi-subagents", "artifacts"), path.join(home, ".pi-subagents", "artifacts")];
  return { missionRoots, artifactRoots, asyncRoots: [tempRoot, path.join(home, ".pi-subagents", "runs"), path.join(home, ".pi", "agent", "async-runs"), path.join(home, ".pi", "agent", "subagent-runs")] };
}

export async function handleSubagentHistory(res) {
  const history = collectSubagentHistory(defaultSubagentHistoryRoots());
  if (typeof _subagentHistoryProvider === "function") {
    try {
      const own = await _subagentHistoryProvider({ limit: 160 });
      if (Array.isArray(own) && own.length) {
        const runs = [...own, ...(history.runs || [])];
        const seen = new Set();
        history.runs = runs.filter(run => { const id = String(run?.runId || run?.id || ""); if (!id || seen.has(id)) return false; seen.add(id); return true; }).slice(0, 160);
        history.counts.runs = history.runs.length;
        history.counts.failed = history.runs.filter(run => ["failed", "stopped", "cancelled"].includes(run.state)).length;
        history.updatedAt = new Date().toISOString();
      }
    } catch {}
  }
  json(res, 200, history);
}

export async function handleSubagentRuns(res) {
  const history = collectSubagentHistory(defaultSubagentHistoryRoots());
  json(res, 200, { runs: history.runs.filter(run => run.source === "async").slice(0, 50) });
}

// 安全版会话统计：引擎 getSessionStats 遇到"无 usage 的 assistant 消息"会抛
// "Cannot read properties of undefined (reading 'input')"（官方 bug），导致 stats 接口 500。
// 这里自行聚合，跳过缺失 usage 的消息，保证任何会话都能拿到统计。
export function safeSessionStats(agent) {
  let userMessages = 0, assistantMessages = 0, toolResults = 0, totalMessages = 0, toolCalls = 0;
  const usageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const addUsage = (u) => {
    if (!u || typeof u.input !== "number" || typeof u.output !== "number") return;
    usageTotals.input += u.input || 0;
    usageTotals.output += u.output || 0;
    usageTotals.cacheRead += u.cacheRead || 0;
    usageTotals.cacheWrite += u.cacheWrite || 0;
    usageTotals.cost += typeof u.cost === "number" ? u.cost : (u.cost?.total || 0);
  };
  for (const entry of agent.sessionManager.getEntries()) {
    if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) addUsage(entry.usage);
    if (entry.type !== "message") continue;
    totalMessages++;
    const m = entry.message;
    if (m.role === "user") userMessages++;
    else if (m.role === "toolResult") { toolResults++; if (m.usage) addUsage(m.usage); }
    else if (m.role === "assistant") {
      assistantMessages++;
      if (Array.isArray(m.content)) toolCalls += m.content.filter(c => c.type === "toolCall").length;
      if (m.usage) addUsage(m.usage);
    }
  }
  let contextUsage;
  try { contextUsage = agent.getContextUsage(); } catch {}
  return {
    sessionFile: agent.sessionFile,
    sessionId: agent.sessionId,
    userMessages, assistantMessages, toolCalls, toolResults, totalMessages,
    tokens: {
      input: usageTotals.input, output: usageTotals.output,
      cacheRead: usageTotals.cacheRead, cacheWrite: usageTotals.cacheWrite,
      total: usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite,
    },
    cost: usageTotals.cost,
    contextUsage,
  };
}

// GET /api/sessions/:id/stats —— token/成本统计
export async function handleStats(res, id) {
  const entry = await _openSession(id);
  if (!entry) return json(res, 404, { error: "会话不存在" });
  try {
    const stats = entry.agent ? safeSessionStats(entry.agent) : {};
    json(res, 200, { stats });
  } catch (e) {
    json(res, 500, { error: String(e?.message || e) });
  }
}

// POST /api/sessions/:id/compact —— 压缩上下文
export async function handleCompact(res, id) {
  const entry = await _openSession(id);
  if (!entry) return json(res, 404, { error: "会话不存在" });
  if (entry.busy) return json(res, 409, { error: "会话正在处理中" });
  try {
    const result = await _ensureAgent(entry, _getDefaultModel()).then(ag => ag.compact());
    json(res, 200, { ok: true, summary: result?.summary || "" });
  } catch (e) {
    json(res, 500, { error: String(e?.message || e) });
  }
}

// GET /api/skills —— 技能列表（兼容适配器资源 + 元枢内置技能）
const BUILTIN_SKILLS_DIR = path.join(import.meta.dirname, "..", "skills");

// 技能分类只依赖名称和简介，避免要求每个技能都维护额外的 frontmatter。
// 有 category/tags 字段时优先使用显式值，没有时按这些稳定的关键词推导。
export const SKILL_CATEGORIES = Object.freeze([
  { id: "creative", label: "创作设计", keywords: ["design", "creative", "illustrat", "poster", "zine", "scene", "celestial", "设计", "插画", "海报", "场景", "视觉"] },
  { id: "image", label: "图像视觉", keywords: ["image", "photo", "portrait", "draw", "paint", "图片", "图像", "摄影", "人像", "出图"] },
  { id: "video", label: "视频与动效", keywords: ["video", "animation", "motion", "remotion", "短视频", "视频", "动效", "动画", "分镜"] },
  { id: "presentation", label: "演示文稿", keywords: ["ppt", "powerpoint", "slide", "presentation", "路演", "幻灯", "演示文稿"] },
  { id: "document", label: "文档与办公", keywords: ["document", "word", "pdf", "markdown", "合同", "文档", "法条", "表格", "办公"] },
  { id: "research", label: "研究与搜索", keywords: ["research", "search", "browser", "paper", "claim", "分析", "检索", "搜索", "论文", "核查"] },
  { id: "engineering", label: "开发与工程", keywords: ["code", "debug", "test", "frontend", "backend", "sdk", "api", "工程", "开发", "调试", "测试"] },
  { id: "automation", label: "自动化与系统", keywords: ["automat", "agent", "workflow", "plugin", "skill", "system", "自动", "工作流", "智能体", "系统"] },
  { id: "commerce", label: "内容营销", keywords: ["commerce", "ecommerce", "marketing", "wechat", "xiaohongshu", "shopping", "带货", "电商", "营销", "公众号", "小红书"] },
  { id: "data", label: "数据分析", keywords: ["spreadsheet", "excel", "stock", "chart", "data", "股票", "数据", "图表", "表格"] },
  { id: "general", label: "通用助手", keywords: [] },
]);

const skillCategoryById = new Map(SKILL_CATEGORIES.map(c => [c.id, c]));
const normaliseSkillText = value => String(value || "").toLowerCase().replace(/[\s_/-]+/g, " ");

/** 纯函数：给定技能名和简介，返回稳定的用途分类。 */
export function inferSkillCategory(name = "", description = "", explicit = "") {
  const requested = normaliseSkillText(explicit);
  const direct = SKILL_CATEGORIES.find(c => c.id === requested || c.label.toLowerCase() === requested);
  if (direct) return direct.id;
  const text = normaliseSkillText(`${name} ${description}`);
  let best = { id: "general", score: 0 };
  for (const category of SKILL_CATEGORIES) {
    if (!category.keywords.length) continue;
    const score = category.keywords.reduce((sum, keyword) => sum + (text.includes(normaliseSkillText(keyword)) ? 1 : 0), 0);
    if (score > best.score) best = { id: category.id, score };
  }
  return best.id;
}

/** 从 frontmatter 或简介提取最多 6 个可读标签，供界面做轻量筛选。 */
export function inferSkillTags(name = "", description = "", explicit = []) {
  const tags = Array.isArray(explicit)
    ? explicit
    : String(explicit || "").split(/[,，、|]/);
  const result = [];
  for (const tag of tags) {
    const value = String(tag || "").trim().replace(/^['\"]|['\"]$/g, "");
    if (value && !result.includes(value)) result.push(value);
  }
  const text = normaliseSkillText(`${name} ${description}`);
  for (const category of SKILL_CATEGORIES) {
    if (result.length >= 6) break;
    if (category.keywords.some(keyword => text.includes(normaliseSkillText(keyword))) && !result.includes(category.label)) result.push(category.label);
  }
  return result.slice(0, 6);
}

function pathInside(filePath, root) {
  if (!filePath || !root) return false;
  const file = path.resolve(filePath);
  const base = path.resolve(root);
  return file === base || file.startsWith(base + path.sep);
}

/** 把适配器的 location 转成用户能理解的来源分组。 */
export function classifySkillSource(filePath = "", declaredLocation = "") {
  const fp = String(filePath || "");
  const localRoots = [
    BUILTIN_SKILLS_DIR,
    _cwd ? path.join(_cwd, "skills") : "",
    path.join(process.cwd(), "skills"),
  ];
  if (localRoots.some(root => pathInside(fp, root))) return "local";
  const onlineRoots = [
    path.join(os.homedir(), ".agents", "skills"),
    path.join(os.homedir(), ".pi", "agent", "skills"),
    _getAgentDir() ? path.join(_getAgentDir(), "skills") : "",
  ];
  // 适配器把 node_modules 和用户技能目录都视为已安装资源；仓库内
  // skills/ 已在上面的 localRoots 中优先命中，避免把项目自建技能误判成线上包。
  if (onlineRoots.some(root => pathInside(fp, root)) || declaredLocation === "user" || /node_modules[\\/]/i.test(fp)) return "online";
  if (declaredLocation === "project") return "local";
  return "builtin";
}

const SKILL_SOURCE_LABELS = Object.freeze({ local: "自建 · 本地", online: "线上 · 已安装", builtin: "内置 · 只读" });

function readSkillFrontmatter(filePath) {
  if (!filePath) return {};
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) return {};
    const block = fm[1];
    const get = key => block.match(new RegExp(`^${key}:\\s*(.+)$`, "mi"))?.[1]?.trim() || "";
    let tags = get("tags");
    if (/^\[.*\]$/.test(tags)) tags = tags.slice(1, -1).split(/[,，]/);
    return { category: get("category") || get("领域"), tags };
  } catch { return {}; }
}

function enrichSkill(skill) {
  const metadata = readSkillFrontmatter(skill.path);
  const source = classifySkillSource(skill.path, skill.location);
  const category = inferSkillCategory(skill.name, skill.description, metadata.category);
  const categoryLabel = skillCategoryById.get(category)?.label || "通用助手";
  return {
    ...skill,
    source,
    sourceLabel: SKILL_SOURCE_LABELS[source],
    category,
    categoryLabel,
    tags: inferSkillTags(skill.name, skill.description, metadata.tags),
  };
}
export function listBuiltinSkills() {
  try {
    const root = BUILTIN_SKILLS_DIR;
    if (!fs.existsSync(root)) return [];
    const out = [];
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const skillDir = path.join(root, d.name);
      const skillFile = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;
      let name = d.name, desc = "";
      try {
        const content = fs.readFileSync(skillFile, "utf8");
        const nameM = content.match(/^name:\s*(.+)$/m);
        const descM = content.match(/^description:\s*(.+)$/m);
        if (nameM) name = nameM[1].trim();
        if (descM) desc = descM[1].trim();
      } catch {}
      out.push({ name, description: desc, location: "package", path: skillFile });
    }
    return out;
  } catch { return []; }
}
export async function handleSkills(res) {
  try {
    const agentDir = _getAgentDir();
    const loader = new _DefaultResourceLoader({ cwd: _cwd, agentDir });
    await loader.reload();
    const { skills, diagnostics } = loader.getSkills();
    const merged = [...(skills || []).map(s => ({
      name: s.name,
      description: s.description || "",
      location: (() => {
        const fp = s.filePath || "";
        if (fp.includes("node_modules")) return "package";
        if (fp.includes(".agents") || fp.includes(".pi")) return "user";
        return "project";
      })(),
      path: s.filePath || "",
    })), ...listBuiltinSkills()].map(enrichSkill);
    const sources = { local: 0, online: 0, builtin: 0 };
    const categories = {};
    for (const skill of merged) {
      sources[skill.source] = (sources[skill.source] || 0) + 1;
      categories[skill.category] = (categories[skill.category] || 0) + 1;
    }
    json(res, 200, {
      skills: merged,
      sources,
      categories,
      diagnostics: diagnostics || [],
    });
  } catch (e) {
    json(res, 500, { error: String(e?.message || e) });
  }
}

// GET /api/skills/read?path= —— 技能详情（SKILL.md）
export async function handleSkillRead(res, p) {
  const agentDir = _getAgentDir();
  const globalSkills = path.join(os.homedir(), ".agents", "skills");
  const roots = [agentDir, globalSkills, path.join(import.meta.dirname, "skills")];
  const resolved = path.resolve(p);
  const ok = roots.some(root => resolved === root || resolved.startsWith(root + path.sep));
  if (!ok) return json(res, 403, { error: "路径越界" });
  try {
    const content = await fs.promises.readFile(resolved, "utf8");
    json(res, 200, { path: resolved, content });
  } catch {
    json(res, 404, { error: "读取失败" });
  }
}

// POST /api/parse-file —— 解析 Office 文档（docx/xlsx/pptx）为文本
export async function handleParseFile(res, body) {
  const name = body?.name || "";
  const b64 = body?.base64 || "";
  if (!name || !b64) return json(res, 400, { error: "缺少文件" });
  const ext = path.extname(name).toLowerCase();
  if (![".docx", ".xlsx", ".pptx"].includes(ext)) return json(res, 400, { error: "不支持的格式" });
  if (b64.length > 7 * 1024 * 1024) return json(res, 413, { error: "文件过大" });
  const tmp = path.join(os.tmpdir(), "pi-web-" + Date.now() + ext);
  try {
    fs.writeFileSync(tmp, Buffer.from(b64, "base64"));
    // 路径通过 argv 传给 python（execFile 不会经过 shell），杜绝字符串拼接注入
    // 脚本内部从 sys.argv[1] 取路径，不再把路径拼进代码字符串
    let script;
    if (ext === ".docx") {
      script = `import sys, docx
d = docx.Document(sys.argv[1])
lines=[]
for p in d.paragraphs:
    if p.text.strip(): lines.append(p.text)
for t in d.tables:
    for row in t.rows:
        lines.append(" | ".join(c.text.strip() for c in row.cells))
print("\\n".join(lines))`;
    } else if (ext === ".xlsx") {
      script = `import sys, openpyxl
wb = openpyxl.load_workbook(sys.argv[1], data_only=True)
lines=[]
for ws in wb.worksheets:
    lines.append(f"=== 工作表: {ws.title} ===")
    for row in ws.iter_rows():
        vals=[str(c.value) if c.value is not None else "" for c in row]
        if any(vals): lines.append(" | ".join(vals))
print("\\n".join(lines))`;
    } else {
      script = `import sys
from pptx import Presentation
prs = Presentation(sys.argv[1])
lines=[]
for i, slide in enumerate(prs.slides, 1):
    lines.append(f"=== 幻灯片 {i} ===")
    for shape in slide.shapes:
        if shape.has_text_frame:
            for para in shape.text_frame.paragraphs:
                t="".join(r.text for r in para.runs)
                if t.strip(): lines.append(t)
print("\\n".join(lines))`;
    }
    const out = await new Promise((resolve, reject) => {
      execFile("python", ["-c", script, tmp], { encoding: "utf8", timeout: 25000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        if (err) reject(err); else resolve(stdout);
      });
    });
    json(res, 200, { text: out.slice(0, 150000), size: out.length });
  } catch (e) {
    json(res, 500, { error: "解析失败: " + String(e?.message || e).slice(0, 200) });
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// GET /api/sessions/:id/export?format=html|jsonl —— 导出会话（自动脱敏）
export function escHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// 脱敏模块（自动擦除 API key/令牌/密码）
let sanitizeContent = null;
try {
  ({ sanitizeContent } = await import("./sanitize.mjs"));
} catch {}
export async function handleExport(res, id, format) {
  const found = findSession(id);
  if (!found || !found.file || !fs.existsSync(found.file)) return json(res, 404, { error: "会话不存在" });
  const entries = readEntriesFromFile(found.file);
  const msgs = extractMessages(entries);
  const name = (found.name || "会话").replace(/[\\/:*?"<>|]/g, "_");
  const dlName = encodeURIComponent(name);
  if (format === "jsonl") {
    // JSONL 导出：整文件过脱敏（每行逐条处理，保留结构）
    const raw = fs.readFileSync(found.file, "utf8");
    const sanitized = raw.split("\n").map(line => {
      if (!line.trim()) return line;
      try {
        const obj = JSON.parse(line);
        const walk = (o) => {
          if (!o || typeof o !== "object") return;
          for (const k of Object.keys(o)) {
            const v = o[k];
            if (typeof v === "string") o[k] = sanitizeContent ? sanitizeContent(v) : v;
            else walk(v);
          }
        };
        walk(obj);
        return JSON.stringify(obj);
      } catch { return sanitizeContent ? sanitizeContent(line) : line; }
    }).join("\n");
    res.writeHead(200, {
      "Content-Type": "application/jsonl",
      "Content-Disposition": `attachment; filename="pi-session.jsonl"; filename*=UTF-8''${dlName}.jsonl`,
    });
    res.end(sanitized);
    return;
  }
  const bodyHtml = msgs.map(m => {
    const who = m.role === "user" ? "你" : "pi";
    const text = sanitizeContent ? sanitizeContent(m.text, "html") : m.text;
    return `<div class="msg ${m.role}"><div class="who">${who}</div><div class="text">${escHtml(text)}</div></div>`;
  }).join("\n");
  const html = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>${escHtml(name)}</title><style>
body{max-width:800px;margin:0 auto;padding:24px;font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;background:#0b0c0f;color:#e6e8ee}
h1{font-size:18px;color:#8b7cf6}.msg{margin-bottom:20px}.msg .who{font-size:11px;color:#8a91a5;text-transform:uppercase;letter-spacing:1px}.msg.user .who{color:#a394ff}.msg .text{white-space:pre-wrap;line-height:1.7;font-size:14px}
</style></head><body><h1>${escHtml(name)}</h1>${bodyHtml}</body></html>`;
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Disposition": `attachment; filename="pi-session.html"; filename*=UTF-8''${dlName}.html`,
  });
  res.end(html);
}

// ── 文件系统 API（受限工作目录）─────────────────────────────────────
// ⚠️ 路径基准必须用 _cwd（initStatsApi 注入的 cwd），不能用 CONFIG.cwd——本模块未定义 CONFIG，
//   引用 CONFIG.cwd 会抛 ReferenceError → 前端读/列文件一直报错「找不到文件」。
export function resolveFsPath(p) {
  const root = path.resolve(_cwd);
  const target = path.resolve(root, p || ".");
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

export async function handleFsList(res, p) {
  const dir = resolveFsPath(p);
  if (!dir) return json(res, 403, { error: "路径越界" });
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const items = entries.map(e => ({
      name: e.name,
      type: e.isDirectory() ? "dir" : "file",
      path: path.relative(_cwd, path.join(dir, e.name)).replace(/\\/g, "/"),
    })).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    json(res, 200, {
      cwd: _cwd,
      current: path.relative(_cwd, dir).replace(/\\/g, "/") || ".",
      items,
    });
  } catch (e) {
    json(res, 500, { error: String(e?.message || e) });
  }
}

export async function handleFsRead(res, p) {
  const file = resolveFsPath(p);
  if (!file) return json(res, 403, { error: "路径越界" });
  try {
    const stat = await fs.promises.stat(file);
    if (stat.isDirectory()) return json(res, 400, { error: "这是目录" });
    if (stat.size > 200 * 1024) return json(res, 413, { error: "文件过大（>200KB）" });
    const content = await fs.promises.readFile(file, "utf8");
    json(res, 200, { path: path.relative(_cwd, file).replace(/\\/g, "/"), content });
  } catch (e) {
    json(res, 404, { error: "读取失败: " + String(e?.message || e) });
  }
}

// POST /api/sessions/:id/rename
export async function handleRename(res, id, body) {
  const entry = await _openSession(id);
  if (!entry) return json(res, 404, { error: "会话不存在" });
  const name = String(body.name || "").slice(0, 60) || "新会话";
  try { entry.sm.appendSessionInfo(name); } catch {}
  invalidateSessionCache(); // 2026-08-20 修复：重命名后会话列表立即刷新（否则缓存里还是旧名）
  json(res, 200, { ok: true, name });
}
