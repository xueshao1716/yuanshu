// ===== engine/model/aux.mjs —— 辅助模型路由（2026-11-15）=====
//
// 背景（Alma "Tool Model" 核实结论）：主对话之外的一次性判断——记忆沉淀审核、
// 会话一句话摘要、输出质检——不需要主模型那套推理力，却一直按主模型/各调用点自带模型的
// 单价和超时在跑。这里给"辅助调用"一个统一出口：
//   · 解析顺序：记忆/运行时/模型路由.json 的 aux 配置 > flash 探测（id 命中 flash|lite|mini|small
//     里最便宜可用的）> 回退调用点原模型（多数即主模型）；
//   · 独立超时（默认 2.5s，下限 50ms、上限 5s），失败 fail-open 到调用点原模型**一次**，绝不循环重试；
//   · 每次一行 [aux] 日志 + 一行 jsonl（记忆/运行时/辅助调用.jsonl，最多 2000 行），省没省能对账；
//   · **禁止选 reasoning 模型**（声明 reasoning:true 或 id 命中 thinking|reason|r1|o3|o4 一律排除）——
//     辅助判断要的是快和便宜，不是思考。
//
// token 数只做**估算**（字符数 / 2，偏保守）：不是假装拿到真实 usage，宁可少算也不编数字。
// 记账/落盘失败一律静默：辅助判断的价值在于"绝不打扰主流程"。

import fs from "node:fs";
import path from "node:path";
import { atomicWriteText } from "../atomic-io.mjs";
import { isModelBlocked, isTextCapableModel, modelKey } from "./router.mjs";

export const AUX_TIMEOUT_DEFAULT_MS = 2500;
export const AUX_TIMEOUT_MAX_MS = 5000;
export const AUX_TIMEOUT_MIN_MS = 50;
export const AUX_LOG_MAX_LINES = 2000;
export const AUX_ROUTE_REL = path.join("记忆", "运行时", "模型路由.json");
export const AUX_LOG_REL = path.join("记忆", "运行时", "辅助调用.jsonl");
export const AUX_DEFAULT_CONFIG = Object.freeze({ enabled: true, provider: null, model: null });
export const AUX_CHARS_PER_TOKEN = 2; // 估算是"字符 / 2"，中文实际更少，这里故意保守

// 探测规则：id 命中 flash|lite|mini|small 之一
const AUX_PROBE_RE = /flash|lite|mini|small/i;
// 禁止 reasoning（deepseek-reasoner / o3-mini / xxx-thinking / r1 等）
const REASONING_ID_RE = /(?:thinking|reason|(?:^|[-_/])r1(?:[-_/.]|$)|(?:^|[-_/])o[34](?:[-_/.]|$))/i;
// 同价并列时的偏好顺序：沿用 router.mjs 的既有降级链（这些通道便宜且实测稳）
const AUX_PREFERRED_CHAIN = Object.freeze([
  ["agnes", /^(?:agnes-)?2\.5-flash$/i],
  ["agnes", /^(?:agnes-)?3\.0-flash$/i],
  ["sensenova", /flash-lite/i],
  ["stepfun-plan", /flash/i],
  ["zai-coding-cn", /flash|highspeed/i],
  ["deepseek", /flash|chat/i],
  ["xiaomi-token-plan-cn", /mimo/i],
]);

const defaultLog = (line) => { try { console.log(line); } catch {} };
let _deps = {
  getModelList: () => [],
  getDefaultModel: () => null,
  chat: null,                 // (model, messages, { tools:false, maxTokens, signal }) => { text } | { error }
  wsRoot: () => "",
  log: defaultLog,
  now: () => Date.now(),
};

/** 注入依赖（server.mjs 启动时一次；测试里换临时目录/假通道）。只覆盖传了的键。 */
export function initAuxModel(deps = {}) {
  if (!deps || typeof deps !== "object") return _deps;
  for (const key of ["getModelList", "getDefaultModel", "chat", "wsRoot", "log", "now"]) {
    if (deps[key] !== undefined && deps[key] !== null) _deps[key] = deps[key];
  }
  return _deps;
}

/** 测试/隔离用：恢复未注入状态，并清掉行数缓存。 */
export function resetAuxModel() {
  _deps = {
    getModelList: () => [],
    getDefaultModel: () => null,
    chat: null,
    wsRoot: () => "",
    log: defaultLog,
    now: () => Date.now(),
  };
  _lineCount = null;
  _lineFile = "";
}

export function auxConfigured() { return typeof _deps.chat === "function"; }

const nowMs = () => { try { const v = Number(_deps.now?.()); return Number.isFinite(v) ? v : Date.now(); } catch { return Date.now(); } };
export const estimateTokens = (chars) => Math.ceil(Math.max(0, Number(chars) || 0) / AUX_CHARS_PER_TOKEN);

function rootOf(wsRoot) {
  if (wsRoot !== null && wsRoot !== undefined && wsRoot !== "") return path.resolve(String(wsRoot));
  try {
    const r = typeof _deps.wsRoot === "function" ? _deps.wsRoot() : _deps.wsRoot;
    return r ? path.resolve(String(r)) : "";
  } catch { return ""; }
}

export function auxRoutePath(wsRoot = null) {
  const root = rootOf(wsRoot);
  return root ? path.join(root, AUX_ROUTE_REL) : "";
}

export function auxLogPath(wsRoot = null) {
  const root = rootOf(wsRoot);
  return root ? path.join(root, AUX_LOG_REL) : "";
}

// ── 配置：记忆/运行时/模型路由.json { aux: { enabled, provider, model } } ──
// 文件缺失/坏掉 = 默认 { enabled:true, provider:null, model:null }（自动探测），绝不因为配置缺失而停摆。
export function readAuxConfig(wsRoot = null) {
  const cfg = { ...AUX_DEFAULT_CONFIG };
  const file = auxRoutePath(wsRoot);
  if (!file) return cfg;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const aux = raw && typeof raw === "object" ? raw.aux : null;
    if (aux && typeof aux === "object") {
      cfg.enabled = aux.enabled !== false;
      cfg.provider = typeof aux.provider === "string" && aux.provider.trim() ? aux.provider.trim() : null;
      cfg.model = typeof aux.model === "string" && aux.model.trim() ? aux.model.trim() : null;
    }
  } catch {}
  return cfg;
}

// ── 候选筛选 ──
export function isReasoningModel(model) {
  if (!model) return false;
  if (model.reasoning === true) return true;
  return REASONING_ID_RE.test(String(model.id || ""));
}

/** 能不能当辅助模型：文本能力 + 非 reasoning + 未冷却 + 不是代理变体（价格不可比）。 */
export function isAuxEligible(model) {
  if (!model || !model.provider || !model.id) return false;
  const id = String(model.id);
  if (!isTextCapableModel(model)) return false;
  if (isReasoningModel(model)) return false;
  if (/^\[/.test(id) || /逆/.test(id)) return false;
  if (isModelBlocked(model)) return false;
  return true;
}

const auxPrice = (m) => (Number(m?.cost?.input) || 0) + (Number(m?.cost?.output) || 0);
function auxChainRank(m) {
  const id = String(m?.id || "");
  for (let i = 0; i < AUX_PREFERRED_CHAIN.length; i += 1) {
    const [provider, re] = AUX_PREFERRED_CHAIN[i];
    if (m?.provider === provider && re.test(id)) return i;
  }
  return AUX_PREFERRED_CHAIN.length;
}

// 2026-11-16：同价并列时原先靠降级链 + 字典序，agnes-2.5-flash 永远压过 3.0-flash。
// 改成通用口径：id 里第一个版本号抽掉后剩下的算"系列"，同服务商同系列同价，版本高的优先。
const VERSION_RE = /\d+(?:\.\d+)*/;
function idVersion(m) {
  const id = String(m?.id || "").toLowerCase();
  const v = id.match(VERSION_RE)?.[0];
  return v ? { family: `${m?.provider}|${id.replace(v, "#")}`, parts: v.split(".").map(Number) } : null;
}
function compareParts(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}
/** 池里有同系列、同价、版本更高的模型 → 这个算被取代，排到同价组后面 */
function supersededSet(pool) {
  const out = new Set();
  for (const m of pool) {
    const v = idVersion(m);
    if (v && pool.some((o) => o !== m && auxPrice(o) === auxPrice(m) && idVersion(o)?.family === v.family
      && compareParts(idVersion(o).parts, v.parts) > 0)) out.add(m);
  }
  return out;
}

/** flash 探测池：单价升序 → 同系列新版本优先 → 既有降级链 → id 短 → 字典序（稳定、可解释）。 */
export function rankAuxCandidates(models = []) {
  const pool = (Array.isArray(models) ? models : [])
    .filter(isAuxEligible)
    .filter((m) => AUX_PROBE_RE.test(String(m.id)));
  const superseded = supersededSet(pool);
  pool.sort((a, b) =>
    (auxPrice(a) - auxPrice(b))
    || (Number(superseded.has(a)) - Number(superseded.has(b)))
    || (auxChainRank(a) - auxChainRank(b))
    || (String(a.id).length - String(b.id).length)
    || String(a.id).localeCompare(String(b.id))
  );
  return pool;
}

// ── 解析：配置 > 探测 > 调用点原模型 ──
export function resolveAuxModel({ wsRoot = null, list = null, mainModel = null } = {}) {
  const models = Array.isArray(list) ? list : (_deps.getModelList?.() || []);
  const main = mainModel || _deps.getDefaultModel?.() || null;
  const cfg = readAuxConfig(wsRoot);
  const candidates = rankAuxCandidates(models);
  const base = {
    main,
    enabled: cfg.enabled,
    config: { enabled: cfg.enabled, provider: cfg.provider, model: cfg.model },
    candidates: candidates.slice(0, 5).map((m) => ({ model: modelKey(m), price: auxPrice(m), reasoning: isReasoningModel(m) })),
  };
  if (!cfg.enabled) {
    return { ...base, model: main, source: "disabled", reason: "模型路由.json 里 aux.enabled=false：全部走调用点原模型" };
  }
  // ① 配置指定（显式 provider+model；只给 model 时按 id 全表找）
  let pinNote = "";
  if (cfg.model) {
    const pinned = cfg.provider
      ? models.find((m) => m && m.provider === cfg.provider && String(m.id) === cfg.model)
      : models.find((m) => m && String(m.id) === cfg.model);
    if (pinned && isAuxEligible(pinned)) {
      return { ...base, model: pinned, source: "config", reason: `模型路由.json 指定 ${modelKey(pinned)}（单价 ${auxPrice(pinned)}）` };
    }
    const why = !pinned ? "不在可用模型清单里"
      : isReasoningModel(pinned) ? "是 reasoning 模型（辅助模型禁用）"
        : !isTextCapableModel(pinned) ? "不是文本模型"
          : "当前不可用（冷却中）";
    pinNote = `配置指定的 ${cfg.provider ? cfg.provider + "/" : ""}${cfg.model} ${why}`;
  }
  // ② flash 探测：最便宜的可用小模型
  if (candidates.length) {
    const chosen = candidates[0];
    return {
      ...base,
      model: chosen,
      source: "probe",
      reason: `${pinNote ? pinNote + "；" : ""}id 命中 flash|lite|mini|small 的最便宜可用模型（${candidates.length} 个候选，单价 ${auxPrice(chosen)}）`,
    };
  }
  // ③ 回退调用点原模型（多数即主模型）
  return {
    ...base,
    model: main,
    source: "main",
    reason: `${pinNote ? pinNote + "；" : ""}没有可用的 cheap flash 模型，回退调用点原模型`,
  };
}

// ── 单次调用（自带超时；上游不认 signal 也能被 race 掐断）──
function clampTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return AUX_TIMEOUT_DEFAULT_MS;
  return Math.max(AUX_TIMEOUT_MIN_MS, Math.min(AUX_TIMEOUT_MAX_MS, Math.round(n)));
}

function extractJson(text) {
  const hit = String(text || "").match(/\{[\s\S]*\}/);
  if (!hit) return null;
  try {
    const parsed = JSON.parse(hit[0]);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch { return null; }
}

function describeError(e) {
  if (!e) return "未知错误";
  const code = String(e.code || "");
  const msg = String(e.message || e);
  return code === "AUX_TIMEOUT" ? `超时（${msg.replace(/^辅助调用超时\s*/, "")}）` : `${code ? code + " " : ""}${msg}`.slice(0, 120);
}

function normalizeMessages(messages) {
  const list = Array.isArray(messages) ? messages : (messages ? [messages] : []);
  return list.filter((m) => m && typeof m === "object" && typeof m.role === "string" && m.content !== undefined);
}

function callOnce(chat, model, messages, { maxTokens, timeoutMs, json }) {
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const timer = setTimeout(() => {
      try { controller.abort(); } catch {}
      const err = new Error(`辅助调用超时 ${timeoutMs}ms`);
      err.code = "AUX_TIMEOUT";
      settle(reject, err);
    }, timeoutMs);
    // 注意：这里**不能** unref。超时定时器是"这次调用一定会结算"的唯一保证；
    // 一旦 unref，上游 promise 永不返回（挂死的连接）时事件循环会空转退出，
    // 脚本里表现为 unsettled top-level await。settle 时统一 clearTimeout，不会拖住进程。
    Promise.resolve()
      .then(() => chat(model, messages, { tools: false, maxTokens, signal: controller.signal }))
      .then((raw) => {
        try {
          if (raw == null) throw new Error("返回空");
          if (raw.error) throw new Error(String(raw.error).slice(0, 120));
          const text = String(raw.text ?? raw.content ?? "").trim();
          if (!text) throw new Error("返回空文本");
          if (!json) return settle(resolve, { text, json: null });
          const parsed = extractJson(text);
          if (!parsed) throw new Error("未返回可解析的 JSON");
          settle(resolve, { text, json: parsed });
        } catch (e) { settle(reject, e); }
      }, (e) => settle(reject, e));
  });
}

// ── 记账：一行日志 + 一行 jsonl（最多 2000 行，超出裁掉最旧的）──
let _lineCount = null;
let _lineFile = "";
function countLines(file) {
  try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length; } catch { return 0; }
}
function appendAuxLog(entry, wsRoot) {
  const file = auxLogPath(wsRoot);
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
    if (_lineCount === null || _lineFile !== file) { _lineCount = countLines(file); _lineFile = file; }
    else _lineCount += 1;
    if (_lineCount > AUX_LOG_MAX_LINES) {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      const kept = lines.slice(-AUX_LOG_MAX_LINES);
      atomicWriteText(file, kept.join("\n") + "\n");
      _lineCount = kept.length;
    }
    return true;
  } catch { return false; } // 记账失败绝不影响判断
}

/** 最近的辅助调用（新→旧），坏行跳过。 */
export function readAuxCalls({ wsRoot = null, limit = 20 } = {}) {
  const file = auxLogPath(wsRoot);
  if (!file) return [];
  let lines = [];
  try { lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean); } catch { return []; }
  const rows = [];
  for (const line of lines) {
    try { const row = JSON.parse(line); if (row && typeof row === "object") rows.push(row); } catch {}
  }
  const n = Math.max(1, Math.floor(Number(limit) || 20));
  return rows.slice(-n).reverse();
}

/** 最近 N 次统计：次数/平均耗时/失败率 + 估算 token 与模型分布。 */
export function auxCallStats({ wsRoot = null, limit = 20 } = {}) {
  const rows = readAuxCalls({ wsRoot, limit });
  const calls = rows.length;
  const ok = rows.filter((r) => r.ok === true).length;
  const failed = calls - ok;
  const failOpen = rows.filter((r) => r.failOpen === true).length;
  const totalMs = rows.reduce((n, r) => n + (Number(r.ms) || 0), 0);
  const models = {};
  for (const r of rows) {
    const key = String(r.model || "none");
    models[key] = (models[key] || 0) + 1;
  }
  return {
    window: Math.max(1, Math.floor(Number(limit) || 20)),
    calls,
    ok,
    failed,
    failureRate: calls ? Number((failed / calls).toFixed(3)) : 0,
    failOpen,
    avgMs: calls ? Math.round(totalMs / calls) : 0,
    tokens: {
      in: rows.reduce((n, r) => n + (Number(r.inTokens) || 0), 0),
      out: rows.reduce((n, r) => n + (Number(r.outTokens) || 0), 0),
    },
    models,
    lastAt: rows[0]?.at || null,
  };
}

/** 可见性用：当前解析结果 + 探测依据 + 最近 20 次统计（GET /api/model-routing）。 */
export function auxStatus({ wsRoot = null, limit = 20 } = {}) {
  const resolved = resolveAuxModel({ wsRoot });
  return {
    enabled: resolved.enabled,
    resolved: {
      model: modelKey(resolved.model) || null,
      source: resolved.source,
      reason: resolved.reason,
      config: resolved.config,
    },
    main: modelKey(resolved.main) || null,
    probe: {
      rule: "id 命中 flash|lite|mini|small、能文本、非 reasoning、未冷却，按单价升序取最便宜；同价按既有降级链",
      candidates: resolved.candidates || [],
    },
    timeouts: { defaultMs: AUX_TIMEOUT_DEFAULT_MS, maxMs: AUX_TIMEOUT_MAX_MS },
    log: { path: AUX_LOG_REL, maxLines: AUX_LOG_MAX_LINES, charsPerToken: AUX_CHARS_PER_TOKEN },
    recent: auxCallStats({ wsRoot, limit }),
  };
}

// ── 对外主入口 ──
/**
 * 一次辅助调用：便宜模型优先、独立超时、失败 fail-open 到调用点原模型一次。
 * @param {object} o
 * @param {Array} o.messages       OpenAI 形状的 messages
 * @param {number} [o.maxTokens]   输出预算（透传给注入的 chat；unifiedChat 会忽略，按模型窗口自适应）
 * @param {number} [o.timeoutMs]   单次超时，默认 2.5s，夹在 50ms..5s
 * @param {boolean} [o.json]       true 时要求返回可解析 JSON（解析失败同样触发 fail-open）
 * @param {string} [o.kind]        调用点标识（memory-judge / session-summary / output-inspector…）
 * @param {object} [o.mainModel]   fail-open 目标：调用点原本用的模型（不给就取服务默认模型）
 * @param {string} [o.wsRoot]      工作空间根（日志/配置落盘位置）
 * @param {Function} [o.chat]      自带通道（调用点已有注入通道时用；默认用 initAuxModel 注入的）
 * @param {boolean} [o.allowFailOpen] 默认 true；false 时只试一次
 * @returns {Promise<object>} { ok, text, json, model, aux, main, source, used, failOpen, ms, attempts, error, estimatedTokens }
 */
export async function callAux({
  messages = [], maxTokens = 256, timeoutMs = AUX_TIMEOUT_DEFAULT_MS, json = false,
  kind = "aux", mainModel = null, wsRoot = null, chat = null, allowFailOpen = true,
} = {}) {
  const startedAt = nowMs();
  const resolved = resolveAuxModel({ wsRoot, mainModel });
  const chatFn = typeof chat === "function" ? chat : _deps.chat;
  const msgs = normalizeMessages(messages);
  const timeout = clampTimeout(timeoutMs);
  const inChars = msgs.reduce((n, m) => n + String(m?.content ?? "").length, 0);
  const auxModel = resolved.model || null;
  const main = resolved.main || null;
  const canFailOpen = allowFailOpen && resolved.enabled && !!main && !!auxModel && modelKey(main) !== modelKey(auxModel);
  const result = {
    kind,
    ok: false,
    enabled: resolved.enabled,
    source: resolved.source,
    reason: resolved.reason,
    config: resolved.config,
    candidates: resolved.candidates,
    aux: modelKey(auxModel) || null,
    main: modelKey(main) || null,
    model: null,
    used: "none",
    failOpen: false,
    attempts: 0,
    ms: 0,
    timeoutMs: timeout,
    json: null,
    text: "",
    estimatedTokens: { in: estimateTokens(inChars), out: 0 },
    error: "",
  };
  const record = (patch) => {
    const ms = Math.max(0, nowMs() - startedAt);
    const out = { ...result, ...patch, ms };
    out.estimatedTokens = { in: estimateTokens(inChars), out: estimateTokens(String(out.text || "").length) };
    try {
      _deps.log(`[aux] model=${out.model || "none"} ms=${ms} ok=${out.ok} kind=${kind} source=${out.source}${out.failOpen ? " fallback=main" : ""}${out.error ? ` err=${String(out.error).slice(0, 60)}` : ""}`);
    } catch {}
    appendAuxLog({
      at: new Date(nowMs()).toISOString(),
      kind,
      model: out.model,
      used: out.used,
      source: out.source,
      ok: out.ok === true,
      failOpen: out.failOpen === true,
      attempts: out.attempts,
      ms,
      timeoutMs: timeout,
      inChars,
      outChars: String(out.text || "").length,
      inTokens: out.estimatedTokens.in,
      outTokens: out.estimatedTokens.out,
      json: json === true,
      ...(out.error ? { error: String(out.error).slice(0, 160) } : {}),
    }, wsRoot);
    return out;
  };

  if (!chatFn || !auxModel) {
    return record({ ok: false, error: !chatFn ? "没有注入模型通道（initAuxModel）" : "没有可用模型" });
  }
  // ① 便宜模型（或 enabled:false 时的调用点原模型）一次
  let firstError = "";
  try {
    const r = await callOnce(chatFn, auxModel, msgs, { maxTokens, timeoutMs: timeout, json });
    return record({
      ok: true,
      model: modelKey(auxModel),
      used: resolved.source === "main" || resolved.source === "disabled" ? "main" : "aux",
      attempts: 1,
      text: r.text,
      json: r.json,
    });
  } catch (e) {
    firstError = describeError(e);
  }
  // ② fail-open：只重试一次，绝不循环
  if (canFailOpen) {
    try {
      const r = await callOnce(chatFn, main, msgs, { maxTokens, timeoutMs: timeout, json });
      return record({
        ok: true,
        model: modelKey(main),
        used: "main",
        failOpen: true,
        attempts: 2,
        text: r.text,
        json: r.json,
        error: `辅助模型失败（${firstError}），已回退 ${modelKey(main)}`,
      });
    } catch (e) {
      return record({ ok: false, failOpen: true, attempts: 2, model: modelKey(auxModel), error: `辅助模型失败（${firstError}）；回退 ${modelKey(main)} 也失败（${describeError(e)}）` });
    }
  }
  return record({ ok: false, attempts: 1, model: modelKey(auxModel), error: `辅助模型失败（${firstError}）` });
}
