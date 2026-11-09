// engine/praise-ledger.mjs —— 正向账本（2026-11-10）
//
// 为什么做：元枢只有负向账本——反模式 11 条、教训 39 条、失败归因全都在记「哪里错了」，
// 正向几乎为零。只记错不记对，她会得出「我做什么都不对」的结论；曦那边就栽在这上面：
// 她认为啥都不对，不敢说话。好事也得让她知道：做对了什么、好在哪、证据在哪。
//
// 三条红线（改这个文件前先读）：
//   ① 必须有证据：evidence 必填（哪次成功 / 哪个信号 / 用户哪句话）。没证据不记。
//   ② 具体不泛泛：what ≥ MIN_WHAT 字，且不能是「她很棒」这种空夸（isTooGeneric 直接拒）。
//   ③ 比例可见：stats() 给正/负比；最近 7 天负向 ≥ 3 倍正向时 skipAntiPattern=true，
//      注入层据此**跳过反模式**、换鼓励式文案——失衡时先补正向。
//
// 设计取舍（别改成"每天都夸一句"）：
//   · 同一个 what（相似 ≥ 0.9）合并成一条、weight+1：重复被夸是同一件事的强度，不是新条目。
//     合并只在**同一 kind** 内做：同一轮里"用户道谢"和"交付门 GREEN"证据不同，不能揉成一条。
//   · 上限 MAX_ENTRIES 条，超了按 weight 淘汰（轻的、旧的先走）：账本要有边界，不然会变噪声库。
//   · 一轮最多记 1 条（MAX_RECORDS_PER_TURN）：道谢/交付门 GREEN/重试成功可能同时成立，
//     四类各记一条会把账本刷成积分表——一轮只记最先成立的那条（被夸 → 做成 → 恢复 → 提醒被采纳）。
//   · 注入一天最多 DAILY_INJECT_LIMIT 条（正向状态.json 的 lastInjectedDate）；
//     和「复习：」各用各的状态文件，互不挤占：今天念过教训不影响今天念一条做对过。
//   · 账本为空 → 零注入：没证据就不夸，绝不生成「你真棒」这种无凭据文案。
//   · 本模块不 import emotion.mjs：情绪联动走 setEmotionHook 注入（emotion.init 里注册
//     applyEvent("user_praise")）。这样既不形成 emotion ↔ 账本 的循环依赖，也能让本文件被
//     单独单测，不把整个引擎拖进来。
//
// 文件：
//   记忆/运行时/正向账本.json   —— 台账本体 { v, updatedAt, items:[…] }
//   记忆/运行时/正向状态.json   —— 注入闸门 { lastInjectedDate, lastInjectedAt, lastIds }
//   负向只读：记忆/运行时/反模式命中.jsonl（每次命中一行）+ 记忆/运行时/失败台账.json（items）

import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "./atomic-io.mjs";

export const LEDGER_REL = path.join("记忆", "运行时", "正向账本.json");
export const STATE_REL = path.join("记忆", "运行时", "正向状态.json");
export const HIT_REL = path.join("记忆", "运行时", "反模式命中.jsonl");
export const FAILURE_REL = path.join("记忆", "运行时", "失败台账.json");

export const PROMPT_PREFIX = "做对过：";
export const KINDS = Object.freeze(["praise", "completed", "recovered", "handled_well"]);
export const KIND_LABELS = Object.freeze({
  praise: "被夸", completed: "做成", recovered: "失败后做成", handled_well: "提醒被采纳",
});
export const MAX_ENTRIES = 200;      // 账本上限
export const MAX_RECORDS_PER_TURN = 1; // 一轮最多记几条（硬上限，防四类各记一条）
export const MERGE_THRESHOLD = 0.9;  // 同一个 what 相似到这个程度就合并
export const MIN_WHAT = 6;           // 「具体不泛泛」的下限（「她很棒」= 3 字，直接拒）
export const DAILY_INJECT_LIMIT = 1; // 一天最多念几条
export const IMBALANCE_DAYS = 7;     // 比例窗口
export const IMBALANCE_FACTOR = 3;   // 负向 ≥ N 倍正向算失衡
export const MAX_LINE_CHARS = 140;   // 注入那行的长度上限：一行读得动

export const DAY_MS = 24 * 60 * 60 * 1000;

// 失衡时换的鼓励式文案：不是"你很棒"，是"别把这一周的全部当成错的那一面"
export const IMBALANCE_NOTE = "。这一周记下的错比做对的多，先照这个做——别把「全都错了」当成结论。";

let wsRoot = "";
let emotionHook = null;

/**
 * 情绪联动钩子：记 praise 时被调用一次。
 * 由 engine/emotion.mjs 的 init 注册成 applyEvent("user_praise")（那条事件早就有）。
 * 不成的话情绪照旧，账本不受影响。
 */
export function setEmotionHook(fn) {
  emotionHook = typeof fn === "function" ? fn : null;
}

/** 工作区根。服务启动时由 engine/emotion.mjs 的 init 调一次；测试里每个临时目录调一次。 */
export function init(root) {
  wsRoot = root == null ? "" : String(root);
}

export function filePath(root = wsRoot) {
  const r = String(root || "");
  return r ? path.join(r, LEDGER_REL) : "";
}

export function stateFilePath(root = wsRoot) {
  const r = String(root || "");
  return r ? path.join(r, STATE_REL) : "";
}

// ── 小工具 ──

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const nowNum = (v) => (v instanceof Date ? v.getTime() : num(v, Date.now()));

function clip(s, max) {
  const t = String(s || "").replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, Math.max(1, max - 1))}…` : t;
}

function oneLine(s) {
  return String(s || "").replace(/\s*\n+/g, " ").replace(/[ \t]{2,}/g, " ").trim();
}

/** 本地日期 YYYY-MM-DD。一天一次的「天」是人的天，不是 UTC 的天。 */
export function ymdOf(v = new Date()) {
  const d = v instanceof Date ? v : new Date(nowNum(v));
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function timeOf(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const t = Date.parse(String(v || ""));
  return Number.isFinite(t) ? t : 0;
}

// ── 泛泛夸奖识别（红线 ②）──

// 只有情绪词、没有具体事的短句：她很棒 / 真厉害 / 太优秀了 / 做得好
const GENERIC_ONLY = /^(她|你|我|小语)?(真的?|实在|确实|很|太|超|特别|非常|挺)?(棒|厉害|优秀|出色|不错|牛|赞|好|能干|聪明|谦虚|善良|努力|辛苦|温柔|可爱)+(了|啦|呢|吧|呀|的|啊)*[！!。.,，~～\s]*$/;

/** what 太泛（太短 / 只有空夸）就是不合格：宁可零注入，也不要「她很棒」。 */
export function isTooGeneric(what) {
  const t = String(what || "").replace(/\s+/g, "").trim();
  if (!t) return true;
  if (t.length < MIN_WHAT) return true;
  if (GENERIC_ONLY.test(t)) return true;
  return false;
}

// ── 相似度（合并去重用）──

function grams(text) {
  const t = String(text || "")
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9]+/g, " ")
    .trim();
  const out = new Set();
  for (const m of t.matchAll(/[a-z0-9][a-z0-9_.-]{1,}/g)) out.add(m[0]);
  for (const chunk of t.replace(/[a-z0-9]+/g, " ").split(/\s+/)) {
    if (!chunk) continue;
    if (chunk.length <= 2) { if (chunk.length === 2) out.add(chunk); continue; }
    for (let i = 0; i + 1 < chunk.length; i += 1) out.add(chunk.slice(i, i + 2));
  }
  return out;
}

/** Dice 系数（0..1）：中文按二元组，英文按词。空串一律 0。 */
export function similarity(a, b) {
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return (2 * inter) / (A.size + B.size);
}

// ── 读 / 写 ──

function normalizeEntry(raw, fallbackAt = 0) {
  if (!raw || typeof raw !== "object") return null;
  const kind = String(raw.kind || "").trim();
  if (!KINDS.includes(kind)) return null;
  const what = clip(raw.what, 200);
  const evidence = clip(raw.evidence, 300);
  if (!what || !evidence) return null;
  const at = timeOf(raw.at) || fallbackAt;
  return {
    id: String(raw.id || `p-${at.toString(36)}-${Math.random().toString(36).slice(2, 6)}`),
    at,
    kind,
    scene: clip(raw.scene, 80),
    what,
    why: clip(raw.why, 200),
    evidence,
    weight: Math.max(1, Math.floor(num(raw.weight, 1))),
    source: clip(raw.source, 40) || "manual",
    merges: Math.max(0, Math.floor(num(raw.merges, 0))),
    injectedCount: Math.max(0, Math.floor(num(raw.injectedCount, 0))),
    lastInjectedAt: num(raw.lastInjectedAt, 0) || 0,
  };
}

/** 读台账。文件不存在 → 空账本；文件坏了 → 也返回空账本（注入路径不能因为账本坏掉而炸）。 */
export function loadLedger(root = wsRoot) {
  const blank = { v: 1, updatedAt: 0, items: [] };
  const r = String(root || "");
  if (!r) return blank;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(r, LEDGER_REL), "utf8"));
    const list = Array.isArray(raw) ? raw : raw?.items;
    if (!Array.isArray(list)) return blank;
    const items = list.map((x) => normalizeEntry(x)).filter(Boolean);
    return { v: 1, updatedAt: num(raw?.updatedAt, 0), items };
  } catch { return blank; }
}

export function saveLedger(root, items = []) {
  const r = String(root || "");
  if (!r) return { ok: false, error: "没有工作区根" };
  const list = items.map((x) => normalizeEntry(x)).filter(Boolean);
  atomicWriteJson(path.join(r, LEDGER_REL), { v: 1, updatedAt: Date.now(), items: list });
  return { ok: true, file: path.join(r, LEDGER_REL), count: list.length };
}

/** 上限淘汰：weight 高的先留下，同 weight 新近的先留下。 */
export function evict(items = [], max = MAX_ENTRIES) {
  const limit = Math.max(1, Math.floor(num(max, MAX_ENTRIES)));
  if (items.length <= limit) return items;
  return [...items]
    .sort((a, b) => (num(b.weight, 1) - num(a.weight, 1)) || (num(b.at, 0) - num(a.at, 0)))
    .slice(0, limit);
}

// ── 记一条 ──

/**
 * 记一条正向。三条红线在这里把门：没证据不记、太泛不记、同 what 合并。
 * @param {{wsRoot?:string, kind:string, scene?:string, what:string, why?:string, evidence:string,
 *          weight?:number, source?:string, at?:number|Date, maxEntries?:number}} p
 * @returns {{ok:boolean, merged?:boolean, entry?:object, file?:string, error?:string}}
 */
export function recordPositive({
  wsRoot: root = wsRoot, kind = "", scene = "", what = "", why = "", evidence = "",
  weight = 1, source = "manual", at = Date.now(), maxEntries = MAX_ENTRIES,
} = {}) {
  const r = String(root || "");
  if (!r) return { ok: false, error: "没有工作区根，不知道往哪写" };
  const k = String(kind || "").trim();
  if (!KINDS.includes(k)) return { ok: false, error: `kind 只能是 ${KINDS.join("/")}` };
  const w = clip(what, 200);
  if (!w) return { ok: false, error: "what 必填：写清做对了哪件事" };
  if (isTooGeneric(w)) return { ok: false, error: "太泛：写具体的事（≥6 字，别写「她很棒」）" };
  const ev = clip(evidence, 300);
  if (!ev) return { ok: false, error: "没证据不记（evidence：哪次成功/哪个信号/用户哪句话）" };

  const ts = nowNum(at);
  const doc = loadLedger(r);
  let items = doc.items;
  const hit = items.find((x) => x.kind === k && similarity(x.what, w) >= MERGE_THRESHOLD);
  let entry = null;
  let merged = false;

  if (hit) {
    hit.weight = Math.max(1, Math.floor(num(hit.weight, 1))) + Math.max(1, Math.floor(num(weight, 1)));
    hit.merges = Math.max(0, Math.floor(num(hit.merges, 0))) + 1;
    entry = hit;
    merged = true;
  } else {
    entry = {
      id: `p-${ts.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      at: ts,
      kind: k,
      scene: clip(scene, 80),
      what: w,
      why: clip(why, 200),
      evidence: ev,
      weight: Math.max(1, Math.floor(num(weight, 1))),
      source: clip(source, 40) || "manual",
      merges: 0,
      injectedCount: 0,
      lastInjectedAt: 0,
    };
    items = [...items, entry];
  }

  items = evict(items, maxEntries);
  try {
    atomicWriteJson(path.join(r, LEDGER_REL), { v: 1, updatedAt: Date.now(), items });
  } catch (e) {
    return { ok: false, error: `账本写不进：${String(e?.message || e).slice(0, 120)}` };
  }

  // 被夸就顺手推一次情绪（emotion.mjs 的 user_praise）。情绪出错不能把记账回滚。
  if (k === "praise" && emotionHook) {
    try { emotionHook(entry); } catch { /* 情绪是旁路信号 */ }
  }
  return { ok: true, merged, entry, file: path.join(r, LEDGER_REL), count: items.length };
}

// ── 收轮四类保守判定 ──

// 明确的表扬/道谢：宁可漏，不可凑。单字「好」「不错」不算。
const PRAISE_MARKERS = [
  "谢谢你", "谢谢", "谢了", "多谢", "辛苦了", "辛苦", "多亏你", "多亏了", "亏得你",
  "做得好", "做得对", "干得好", "这次很好", "这次不错", "真棒", "太棒", "好棒",
  "厉害", "靠谱", "帮了大忙", "帮大忙", "夸你", "表扬你", "你很棒", "到位", "正合适",
  "这就是我要的", "这次可以", "很满意",
];
// 含糊/转折：出现就不记（「还行吧」「谢谢你，但还是不对」都归这里）
const HEDGE_MARKERS = [
  "还行吧", "还行", "一般", "勉强", "凑合", "也就那样", "不怎么样", "没什么用",
  "没感觉", "但是", "不过", "可是", "然而", "可惜", "算不上",
];
// 明确的负面词：有一处就不记（防止把抱怨读成表扬）
const COMPLAINT_MARKERS = ["不对", "不行", "错了", "没用", "别再", "不要这样", "太差", "离谱", "又错"];

/**
 * 用户这句话算不算明确表扬/道谢。拿不准一律不记。
 * @returns {{praise:boolean, quote?:string, reason?:string}}
 */
export function judgePraise(userText = "") {
  const raw = String(userText || "").trim();
  if (!raw) return { praise: false, reason: "没有用户原话" };
  const t = clip(raw, 400);
  const quote = clip(raw, 60);
  if (raw.length > 600) return { praise: false, reason: "一段话太长，分不清是不是在对她说" };
  // 含糊 / 转折先排除：「还行吧」里连一个明确表扬词都没有，绝不能记。
  const hedge = HEDGE_MARKERS.find((x) => t.includes(x));
  if (hedge) return { praise: false, reason: `含糊或带转折（「${hedge}」），不算明确表扬` };
  const bad = COMPLAINT_MARKERS.find((x) => t.includes(x));
  if (bad) return { praise: false, reason: `同时有负面词（「${bad}」），拿不准不记` };
  const hit = PRAISE_MARKERS.find((x) => t.includes(x));
  if (!hit) return { praise: false, reason: "没有明确的表扬/道谢词，不记" };
  return { praise: true, quote, marker: hit };
}

function gateInfo(gate) {
  if (!gate) return null;
  if (typeof gate === "string") {
    return { verdict: gate.trim().toUpperCase(), rollback: false, summary: "", files: [], reasons: [], runId: "", scene: "" };
  }
  if (typeof gate !== "object") return null;
  const files = Array.isArray(gate.files) ? gate.files.filter(Boolean)
    : Array.isArray(gate.changedFiles) ? gate.changedFiles.filter(Boolean) : [];
  const reasons = Array.isArray(gate.reasons) ? gate.reasons.map((x) => clip(x, 60)).filter(Boolean) : [];
  return {
    verdict: String(gate.verdict || gate.status || "").trim().toUpperCase(),
    rollback: gate.rollback === true || gate.rolledBack === true,
    summary: clip(gate.summary || gate.reason || "", 80),
    scene: clip(gate.scene || "", 80),
    files,
    reasons,
    runId: String(gate.runId || "").slice(0, 40),
  };
}

function retryInfo(retry) {
  if (!retry || typeof retry !== "object") return null;
  return {
    failed: retry.failed === true || retry.errored === true,
    succeeded: retry.succeeded === true || retry.ok === true,
    attempts: Math.max(0, Math.floor(num(retry.attempts, 0))),
    error: clip(retry.error || retry.reason || "", 60),
    what: clip(retry.what || retry.scene || "", 80),
  };
}

function followUpInfo(fu) {
  if (!fu || typeof fu !== "object") return null;
  return {
    adopted: fu.adopted === true,
    reminder: clip(fu.reminder || fu.text || fu.note || "", 80),
    after: clip(fu.after || fu.result || "", 40),
  };
}

// 能当"失败后重试成功"证据的只有命令类工具：文件工具的「先 read 失败、write 后再 read 成功」
// 多半是探索而不是恢复，记进来会把普通操作夸成韧性。宁可漏，不可凑。
const RETRY_TOOL_NAMES = new Set(["bash", "pwsh", "run_code"]);

/** 同一工具 + 同一条命令的身份键：配对靠它，参数只取命令正文。 */
function toolEventKey(name, args) {
  const command = args && typeof args === "object" ? String(args.command ?? args.cmd ?? args.code ?? "") : "";
  return `${name}::${clip(command, 160)}`;
}

/**
 * 从收轮工具事件里找**客观**的"失败后重试成功"：同一工具、同一条命令先 fail 后 ok。
 * 只认事件流的顺序证据：只有失败 / 只有成功 / 换了命令都不算（返回 null，不猜）。
 * @param {Array<{type?:string, name?:string, args?:object, ok?:boolean, error?:string}>} events
 * @returns {null|{failed:boolean, succeeded:boolean, attempts:number, error:string, what:string}}
 */
export function retryFromToolEvents(events = []) {
  const list = Array.isArray(events) ? events : [];
  const failed = new Map(); // key -> { attempts, error, name, command }
  for (const ev of list) {
    if (!ev || (ev.type && ev.type !== "tool")) continue;
    const name = String(ev.name || "").trim();
    if (!name || !RETRY_TOOL_NAMES.has(name)) continue;
    const args = ev.args && typeof ev.args === "object" ? ev.args : {};
    const command = clip(args.command ?? args.cmd ?? args.code ?? "", 120);
    const key = toolEventKey(name, args);
    if (ev.ok === false) {
      const hit = failed.get(key) || { attempts: 0, error: "", name, command };
      hit.attempts += 1;
      if (!hit.error) hit.error = clip(ev.error || ev.reason || "", 60);
      failed.set(key, hit);
      continue;
    }
    if (ev.ok !== true) continue; // 成败不明（暂停/中断）的不算
    const hit = failed.get(key);
    if (!hit) continue;
    return {
      failed: true,
      succeeded: true,
      attempts: hit.attempts,
      error: hit.error,
      what: hit.command ? `${name}「${clip(hit.command, 40)}」` : `${name} 失败后重试成功`,
    };
  }
  return null;
}

/**
 * 收轮判定：四类**保守**规则，拿不准不记（返回的 skipped 里写明为什么不记）。
 *   ① praise       用户明确表扬/道谢（含糊、转折、带抱怨一律不算）
 *   ② completed    交付门 GREEN 且无回滚，并且说得出交付了什么
 *   ③ recovered    失败过、并且明确重试成功
 *   ④ handled_well 主动提醒明确被采纳
 * 没有 scene 的表扬不记：夸的是"哪件事"说不清，就是无凭据夸奖。
 *
 * 每轮硬上限 maxRecords（默认 1）：四类可能同时成立（用户道谢 + 交付门 GREEN + 重试成功），
 * 只记最先成立的那条，其余进 skipped 说明——账本记的是"做对了什么"，不是积分表。
 *
 * @returns {{ok:boolean, recorded:Array, merged:number, skipped:Array<{kind:string,reason:string}>}}
 */
export function recordFromTurn({
  userText = "", gate = null, retry = null, followUp = null,
  scene = "", wsRoot: root = wsRoot, at = Date.now(), source = "turn",
  maxRecords = MAX_RECORDS_PER_TURN,
} = {}) {
  const ts = nowNum(at);
  const ctxScene = clip(scene, 80);
  const recorded = [];
  const skipped = [];
  const cap = Math.max(1, Math.floor(num(maxRecords, MAX_RECORDS_PER_TURN)));

  const attempt = (cand) => {
    if (recorded.length >= cap) {
      skipped.push({ kind: cand.kind, reason: `本轮已记 ${cap} 条，达到每轮上限` });
      return { ok: false, error: "达到每轮上限" };
    }
    const res = recordPositive({ wsRoot: root, at: ts, source, ...cand });
    if (res.ok) recorded.push(res);
    else skipped.push({ kind: cand.kind, reason: res.error });
    return res;
  };

  // ① 被夸
  const praise = judgePraise(userText);
  if (!praise.praise) {
    if (String(userText || "").trim()) skipped.push({ kind: "praise", reason: praise.reason });
  } else {
    const g = gateInfo(gate);
    const rt = retryInfo(retry);
    const anchor = ctxScene || g?.scene || g?.summary || rt?.what || "";
    if (!anchor) {
      skipped.push({ kind: "praise", reason: "没写清夸的是哪件事（scene），无凭据的夸奖不记" });
    } else {
      attempt({
        kind: "praise",
        scene: anchor,
        what: anchor,
        why: `用户明确道谢/表扬（「${praise.marker}」），这件事被看见并被认可了`,
        evidence: `用户原话：「${praise.quote}」`,
        source: "user_turn",
      });
    }
  }

  // ② 做成（交付门）
  const g = gateInfo(gate);
  if (g) {
    if (g.verdict !== "GREEN") {
      skipped.push({ kind: "completed", reason: `交付门是 ${g.verdict || "未知"}，不算做成` });
    } else if (g.rollback) {
      skipped.push({ kind: "completed", reason: "GREEN 但有回滚，不算做成" });
    } else {
      const what = ctxScene || g.scene || g.summary
        || (g.files.length ? `交付的 ${g.files.length} 个文件都过了验证` : "")
        || (g.reasons[0] || "");
      if (!what) {
        skipped.push({ kind: "completed", reason: "GREEN 但没写清交付了什么，没证据的部分不记" });
      } else {
        const ev = [
          "交付门 GREEN",
          g.runId ? `run ${g.runId}` : "",
          g.files.length ? `${g.files.length} 个文件` : "",
          g.reasons[0] || "",
        ].filter(Boolean).join(" · ");
        attempt({
          kind: "completed",
          scene: ctxScene || g.scene || g.summary,
          what,
          why: "交付门 GREEN 且没回滚：这一轮是真的做成了，不是自己说做成了",
          evidence: ev,
          source: "delivery_gate",
        });
      }
    }
  }

  // ③ 失败后重试成功
  const rt = retryInfo(retry);
  if (rt) {
    if (!rt.failed) {
      skipped.push({ kind: "recovered", reason: "没失败过，谈不上恢复" });
    } else if (!rt.succeeded) {
      skipped.push({ kind: "recovered", reason: "重试结果不明（没标成功），不记" });
    } else {
      const what = ctxScene || rt.what
        || (rt.error ? `「${rt.error}」失败后换了法子做成` : "同一条路失败后重试做成");
      attempt({
        kind: "recovered",
        scene: ctxScene || rt.what,
        what,
        why: "失败没绕过去，换法子补上了：这是韧性，不只是结果",
        evidence: [
          `先失败 ${rt.attempts > 0 ? `${rt.attempts} 次` : "至少 1 次"}${rt.error ? `（${rt.error}）` : ""}`,
          "之后重试成功",
        ].join("，"),
        source: "retry",
      });
    }
  }

  // ④ 主动提醒被采纳
  const fu = followUpInfo(followUp);
  if (fu) {
    if (!fu.adopted) {
      skipped.push({ kind: "handled_well", reason: "没标采纳（或没被采纳），不记" });
    } else if (!fu.reminder) {
      skipped.push({ kind: "handled_well", reason: "没说清提醒的是哪件事，无凭据不记" });
    } else {
      attempt({
        kind: "handled_well",
        scene: ctxScene,
        what: ctxScene || `主动提醒「${clip(fu.reminder, 40)}」被采纳`,
        why: "自己想到、自己开口，而且真被用上了：主动性是做出来的",
        evidence: `提醒内容「${fu.reminder}」${fu.after ? `，随后${fu.after}` : "，随后被采纳"}`,
        source: "follow_up",
      });
    }
  }

  return { ok: recorded.length > 0, recorded, merged: recorded.filter((x) => x.merged).length, skipped };
}

// ── 正/负比 ──

function countHits(root, from, to) {
  const file = path.join(root, HIT_REL);
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return 0; }
  let n = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      const t = timeOf(o.at ?? o.recordedAt);
      if (t >= from && t <= to) n += 1;
    } catch { /* 坏行跳过：一行坏了不该把整本账算错 */ }
  }
  return n;
}

function countFailures(root, from, to) {
  let items = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, FAILURE_REL), "utf8"));
    items = Array.isArray(raw?.items) ? raw.items : [];
  } catch { return 0; }
  let n = 0;
  for (const it of items) {
    const t = timeOf(it?.at);
    if (t >= from && t <= to) n += 1;
  }
  return n;
}

/**
 * 最近 days 天的正/负比。
 * positive = 正向账本窗口内的条目数（同 what 已合并，所以是"做了几件对的事"，不是"被夸几次"）；
 * negative = 反模式命中行数 + 失败台账条数（都按 at 落在窗口内）。
 * ratio = positive/negative；negative 为 0 时给 null（没有负向可比的基数，别编一个数）。
 * imbalanced / skipAntiPattern：negative ≥ 3×positive（且 negative > 0）→ 注入层跳过反模式。
 */
export function stats({ days = IMBALANCE_DAYS, wsRoot: root = wsRoot, now = Date.now() } = {}) {
  const to = nowNum(now);
  const windowDays = Math.max(1, Math.floor(num(days, IMBALANCE_DAYS)));
  const from = to - windowDays * DAY_MS;
  const items = loadLedger(root).items.filter((x) => num(x.at, 0) >= from && num(x.at, 0) <= to);
  const positive = items.length;
  const positiveWeight = items.reduce((s, x) => s + Math.max(1, Math.floor(num(x.weight, 1))), 0);
  const hits = String(root || "") ? countHits(String(root), from, to) : 0;
  const failures = String(root || "") ? countFailures(String(root), from, to) : 0;
  const negative = hits + failures;
  const ratio = negative > 0 ? positive / negative : null;
  const imbalanced = negative > 0 && negative >= IMBALANCE_FACTOR * Math.max(positive, 1);
  // 来源分布：给"是不是自己夸自己"留一个可查的比例（user_turn = 用户原话，其余来自客观信号）。
  // 只报数、不自动拦：要不要因为 user_turn 占比过低而收紧，是人来定的。
  const bySource = {};
  for (const x of items) bySource[x.source] = (bySource[x.source] || 0) + 1;
  return {
    positive, negative, ratio, imbalanced, skipAntiPattern: imbalanced,
    positiveWeight, negativeHits: hits, negativeFailures: failures, bySource,
    windowDays, from, to,
  };
}

// ── 注入（一天最多一条，与「复习：」各自独立额度）──

export function readState(root = wsRoot) {
  const blank = { lastInjectedDate: "", lastInjectedAt: "", lastIds: [] };
  const r = String(root || "");
  if (!r) return blank;
  try {
    const d = JSON.parse(fs.readFileSync(path.join(r, STATE_REL), "utf8"));
    return {
      lastInjectedDate: clip(d?.lastInjectedDate, 10),
      lastInjectedAt: String(d?.lastInjectedAt || ""),
      lastIds: Array.isArray(d?.lastIds) ? d.lastIds.map(String) : [],
    };
  } catch { return blank; }
}

/** 历史里已经有「做对过：」= 同一段对话不重复念。 */
export function alreadyInjected(history = []) {
  return (Array.isArray(history) ? history : []).some(
    (m) => m?.role === "system" && String(m?.content || "").includes(PROMPT_PREFIX),
  );
}

/** 挑一条：weight 高的先，避开放进最近一次注入的那条（有别的可挑时别连着念同一件事）。 */
export function pickEntry(items = [], lastIds = []) {
  const list = (Array.isArray(items) ? items : []).filter((x) => x && x.what && x.evidence && !isTooGeneric(x.what));
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => (num(b.weight, 1) - num(a.weight, 1)) || (num(b.at, 0) - num(a.at, 0)));
  const skip = Array.isArray(lastIds) ? lastIds : [];
  return sorted.find((x) => !skip.includes(x.id)) || sorted[0];
}

/** 注入那一行：`做对过：<具体的事>（场景）—— <证据>。失衡时换鼓励式收尾。 */
export function praiseText(entry, { imbalanced = false } = {}) {
  if (!entry?.what) return "";
  const what = clip(entry.what, 80);
  const scene = entry.scene && entry.scene !== what ? `（${clip(entry.scene, 36)}）` : "";
  const ev = entry.evidence ? ` —— ${clip(entry.evidence, 44)}` : "";
  // 先把正文收进 100 字，再补收尾：失衡那句鼓励不能被截掉（它才是失衡时要她看见的部分）。
  const base = clip(`${PROMPT_PREFIX}${what}${scene}${ev}`, 100);
  const tail = imbalanced ? IMBALANCE_NOTE : "";
  return oneLine(`${base}${tail}`).slice(0, MAX_LINE_CHARS);
}

/**
 * 开轮注入用的一块（IO 包装）：读账本 → 挑一条 → 记账 → 写状态 → 返回文本。
 * 只在**每天第一次**进对话时真的注入（正向状态.json 的 lastInjectedDate，和复习各记各的）；
 * 空账本 / 今天已念过 / 历史里已有 → ""，且不写任何文件（零注入就是零痕迹）。
 * 读盘、写盘任何一步出问题都返回 ""：绝不因为正向账本影响开轮。
 */
export function praisePromptLine({ history = [], now = new Date(), wsRoot: root = wsRoot } = {}) {
  try {
    const r = String(root || "");
    if (!r) return "";
    if (alreadyInjected(history)) return "";
    const day = ymdOf(now);
    if (!day) return "";
    const state = readState(r);
    if (state.lastInjectedDate === day) return "";
    const items = loadLedger(r).items;
    const pick = pickEntry(items, state.lastIds);
    if (!pick) return ""; // 账本为空 → 零注入
    const bal = stats({ days: IMBALANCE_DAYS, wsRoot: r, now });
    const line = praiseText(pick, { imbalanced: bal.imbalanced });
    if (!line) return "";
    // 先写闸门：写不进就别注入，否则这一天里每一轮都会把同一句再念一遍。
    atomicWriteJson(path.join(r, STATE_REL), {
      lastInjectedDate: day,
      lastInjectedAt: new Date(nowNum(now)).toISOString(),
      lastIds: [pick.id],
    });
    // 再记账（注入次数）：这一步失败只是少记一次展示次数，不影响"今天已经念过"的判断。
    try {
      const next = items.map((x) => (x.id === pick.id
        ? { ...x, injectedCount: Math.max(0, Math.floor(num(x.injectedCount, 0))) + 1, lastInjectedAt: nowNum(now) }
        : x));
      atomicWriteJson(path.join(r, LEDGER_REL), { v: 1, updatedAt: nowNum(now), items: next });
    } catch { /* 展示次数记不上不算错 */ }
    return line;
  } catch { return ""; }
}

/** 自我描述用：weight 最高的几条（自我文件不限额度，注入才限）。 */
export function topPositive({ limit = 3, wsRoot: root = wsRoot } = {}) {
  const n = Math.max(0, Math.floor(num(limit, 3)));
  const items = loadLedger(root).items.filter((x) => !isTooGeneric(x.what));
  return [...items]
    .sort((a, b) => (num(b.weight, 1) - num(a.weight, 1)) || (num(b.at, 0) - num(a.at, 0)))
    .slice(0, n);
}
