// ===== engine/memory-forget.mjs —— 遗忘清理器（曦 → 元枢 移植，2026-11-09）=====
//
// 移植自 D:\xinyu-zool\evolution\forgetting_manager.py（trust_score 四维打分 + 四分类），
// 但按元枢的真实记忆形态重写：
//
//   记忆单位（先摸清再定，不假设）：
//     · 记忆/记忆日志.md  —— 一条 = 一个日期标题块（### 2026-08-27 12:40 ...）
//       切分规则直接复用 engine/memory/facts.mjs 的 splitLogBlocks 语义（^#{2,4}\s+日期），
//       与元枢自己的召回/卫生口径一致；文件头说明区（首个标题前）不参与遗忘。
//     · 记忆/纠正记忆.md  —— 一条 = 一个 #/##/### 标题块（### 日期 + 触发/纠正）
//     · 记忆/关系记忆.md  —— 一条 = 一个 ## 主题段（## 称呼 / ## 雷点 ...）
//     · 记忆.md（根，固定记忆）—— 一条 = 一个 ## 段
//     · memory/memory.db（sqlite）—— 一条 = memories 表的一行（active）
//   运行时 jsonl（情绪潮汐/记忆召回/动作审计等）是遥测流水，不是记忆条目，不扫。
//
//   引用数据（refCount / lastRefAt）从哪来：
//     · sqlite：access_count / last_accessed_at（真计数，天然可用）
//     · md：记忆/运行时/记忆召回.json 的 stats（按 recall-journal 的 memoryId 匹配 injected
//       / lastInjectedAt / lastUsedAt）。该台账从 2026-10-24 才开始记，所以：
//         - 命中 → 有引用数据
//         - 未命中且条目晚于台账起点 → 真实 0 次（可下结论）
//         - 未命中且条目早于台账起点 → 拿不到，refsMissing:true，**降级只看年龄+importance**
//
//   安全边界（默认零破坏）：
//     · planForgetting 是纯函数，绝不写盘；
//     · applyForgetting 默认 dryRun=true，dry-run 连目录都不建；
//     · apply 只归档 archive 类；cleanable 只报告，删除必须显式 deleteCleanable:true，
//       且先在 backups/Forget-<时间戳>/ 里落全量备份 + 删除清单；
//     · 归档是"移动"（从热文件移到 记忆/归档/，仍可被冷召回检索），不是删除。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { atomicWriteText } from "./atomic-io.mjs";
import { memoryId } from "./recall-journal.mjs";

const DAY = 86400000;

// ---------------------------------------------------------------------------
// 权重与阈值：集中定义，CLI/调用方可覆盖
// ---------------------------------------------------------------------------

/** 四维权重：年龄 20% + 引用次数 35% + 最近引用 30% + 外部 importance 15% */
export const WEIGHTS = Object.freeze({
  age: 0.20,
  ref: 0.35,
  recency: 0.30,
  importance: 0.15,
});

/** 阈值（全部可覆盖）。数值语义见 classify。 */
export const THRESHOLDS = Object.freeze({
  keep: 0.60,             // 信任分 >= 0.60 → keep
  cleanable: 0.30,        // 分数 < 0.30 且 >= 30 天未引用 → cleanable
  archive: 0.15,          // 分数 < 0.15 → archive（比 cleanable 更狠）
  staleDays: 30,          // 超过 30 天未引用才算"过期"
  neverRefDays: 7,        // 从未引用且超过 7 天 → suggest
  ageSpanDays: 120,       // 年龄因子线性衰减：1 - 天数/120
  recencySpanDays: 60,    // 最近引用因子线性衰减：1 - 天数/60
  refSaturation: 0.5,     // 引用饱和曲线：1 - e^(-0.5 * count)
  pinBonus: 0.3,          // PIN/PERMANENT +0.3
});

const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 20000,
  maxPreview: 80,
});

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const clamp01 = (n) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
const round3 = (n) => Math.round(n * 1000) / 1000;
const round2 = (n) => Math.round(n * 100) / 100;

/** 统一时间入参：数字毫秒 / Date / ISO / 本地 "YYYY-MM-DD HH:mm"。解析不了返回 null。 */
export function toTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  const s = String(value).trim();
  if (!s) return null;
  // 带时区的 ISO 先交给 Date.parse，避免把 Z 当本地时间
  if (/[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    return new Date(
      Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      Number(m[4]), Number(m[5]), Number(m[6] || 0),
    ).getTime();
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function daysSince(now, ts) {
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, (now - ts) / DAY);
}

function shortHash(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex").slice(0, 10);
}

function previewOf(text, max = 120) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, max);
}

// ---------------------------------------------------------------------------
// 1. 信任分
// ---------------------------------------------------------------------------

/**
 * 计算一条记忆的信任分。分数越高越该保留。
 *
 * @param {object} entry 条目（createdAt / importance / refCount / lastRefAt / pinned / refsMissing）
 * @param {object} opts  now / refCount / lastRefAt / importance / pinned / weights / createdAt
 * @returns {{score:number, refsMissing:boolean, ageMissing:boolean, pinned:boolean,
 *            factors:object, weights:object, daysSinceCreated:number|null,
 *            daysSinceRef:number|null, refCount:number|null, createdAt:number|null}}
 *
 * 引用数据缺失时（refCount 拿不到，或 refCount>0 但 lastRefAt 拿不到）：
 *   refsMissing = true，权重只在 年龄 + importance 之间重新归一化，
 *   **不拿 0 冒充引用次数**，也不因此把它误判成"没人用"。
 */
export function computeTrustScore(entry = {}, opts = {}) {
  const nowMs = toTimestamp(opts.now) ?? Date.now();
  const createdAt = toTimestamp(
    opts.createdAt ?? entry.createdAt ?? entry.created_at ?? entry.at ?? entry.date,
  );
  const impRaw = opts.importance !== undefined ? opts.importance : entry.importance;
  const impNum = Number(impRaw);
  const importance = clamp01(impRaw === null || impRaw === undefined || impRaw === "" || !Number.isFinite(impNum) ? 0.5 : impNum);
  const pinned = Boolean(opts.pinned !== undefined ? opts.pinned : entry.pinned);

  const rawRefCount = opts.refCount !== undefined ? opts.refCount : entry.refCount;
  const rawLastRefAt = opts.lastRefAt !== undefined ? opts.lastRefAt : entry.lastRefAt;
  const refCountNum = rawRefCount === null || rawRefCount === undefined ? null : Number(rawRefCount);
  const lastRefMs = toTimestamp(rawLastRefAt);

  // 引用数据是否可用：显式标记优先；计数必须是有限非负数；
  // 有引用但不知道"最后一次什么时候"也算拿不到（最近引用 30% 无法算）。
  const refsMissing = Boolean(
    entry.refsMissing === true ||
    opts.refsMissing === true ||
    refCountNum === null ||
    !Number.isFinite(refCountNum) ||
    refCountNum < 0 ||
    (refCountNum > 0 && lastRefMs === null),
  );

  const ageMissing = createdAt === null;
  const daysCreated = ageMissing ? null : daysSince(nowMs, createdAt);

  // 年龄因子：越老越低（120 天线性到 0）
  const w = { ...WEIGHTS, ...(opts.weights || {}) };
  const ageFactor = ageMissing ? 0 : clamp01(1 - daysCreated / Math.max(1, Number(w.ageSpanDays) || THRESHOLDS.ageSpanDays));

  const factors = {
    age: round3(ageFactor),
    ref: 0,
    recency: 0,
    importance: round3(importance),
  };

  let score;
  if (refsMissing) {
    // 降级：只在年龄与外部 importance 之间重新归一化（默认 0.20 / 0.15 → 4/7 与 3/7）
    const base = Number(w.age) + Number(w.importance);
    const wa = base > 0 ? Number(w.age) / base : 0.5;
    const wi = base > 0 ? Number(w.importance) / base : 0.5;
    score = wa * ageFactor + wi * importance;
  } else {
    const span = Math.max(1, Number(w.ageSpanDays) || THRESHOLDS.ageSpanDays);
    const recencySpan = Math.max(1, Number(w.recencySpanDays) || THRESHOLDS.recencySpanDays);

    // 从未引用：最后引用时间按创建时间算（沿用源实现 sealed chunk 的处理）
    const daysSinceRef = refCountNum === 0 && lastRefMs === null
      ? (daysCreated ?? 0)
      : (lastRefMs === null ? null : daysSince(nowMs, lastRefMs));
    const refFactor = 1 - Math.exp(-(Number(w.refSaturation) || THRESHOLDS.refSaturation) * refCountNum);
    const recencyFactor = daysSinceRef === null ? 0 : clamp01(1 - daysSinceRef / recencySpan);
    const total = Number(w.age) + Number(w.ref) + Number(w.recency) + Number(w.importance);
    const norm = total > 0 ? total : 1;
    score = (
      Number(w.age) * (1 - (daysCreated ?? span) / span) +
      Number(w.ref) * refFactor +
      Number(w.recency) * recencyFactor +
      Number(w.importance) * importance
    ) / norm;

    factors.ref = round3(refFactor);
    factors.recency = round3(recencyFactor);
    factors.daysSinceRef = daysSinceRef === null ? null : Math.round(daysSinceRef * 10) / 10;
  }

  // PIN/PERMANENT 加成
  if (pinned) score = Math.min(1, score + (Number(w.pinBonus) || THRESHOLDS.pinBonus));

  const daysSinceRef = refsMissing
    ? null
    : (refCountNum === 0 && lastRefMs === null
      ? (daysCreated === null ? null : Math.round(daysCreated * 10) / 10)
      : (lastRefMs === null ? null : Math.round(daysSince(nowMs, lastRefMs) * 10) / 10));

  return {
    score: round3(clamp01(score)),
    refsMissing,
    ageMissing,
    pinned,
    factors,
    weights: { ...w },
    daysSinceCreated: daysCreated === null ? null : Math.round(daysCreated * 10) / 10,
    daysSinceRef,
    refCount: refsMissing ? null : refCountNum,
    createdAt,
  };
}

// ---------------------------------------------------------------------------
// 2. 四分类
// ---------------------------------------------------------------------------

/**
 * 按信任分把一条记忆分成 keep / suggest / cleanable / archive。
 *
 * 阈值阶梯（顺序即优先级，避免源实现里 archive 被 cleanable 抢先的倒挂）：
 *   1. PIN / PERMANENT            → keep（永不清理）
 *   2. score >= keep(0.60)        → keep
 *   3. 引用/年龄数据缺失           → suggest（拒绝下"可清理"结论）
 *   4. score < archive(0.15)      → archive
 *   5. 未引用 >= staleDays(30) 且 score < cleanable(0.30) → cleanable
 *   6. 从未引用 >= neverRefDays(7) → suggest
 *   7. 其余                        → suggest
 *
 * @param {number|object} input 信任分，或 computeTrustScore 的返回值
 * @param {object} opts thresholds / refCount / daysSinceRef / pinned / refsMissing / ageMissing
 */
export function classify(input, opts = {}) {
  const subject = typeof input === "number" ? { score: input } : (input || {});
  const t = { ...THRESHOLDS, ...(opts.thresholds || {}) };
  const score = Number(subject.score);
  const pinned = Boolean(opts.pinned !== undefined ? opts.pinned : subject.pinned);
  const refsMissing = Boolean(opts.refsMissing !== undefined ? opts.refsMissing : subject.refsMissing);
  const ageMissing = Boolean(opts.ageMissing !== undefined ? opts.ageMissing : subject.ageMissing);
  const daysSinceRef = opts.daysSinceRef !== undefined ? opts.daysSinceRef : subject.daysSinceRef;
  const refCount = opts.refCount !== undefined ? opts.refCount : subject.refCount;

  if (pinned) return "keep";
  if (!Number.isFinite(score)) return "suggest";     // 没分不猜
  if (score >= Number(t.keep)) return "keep";
  // 降级模式：无法证明它"没用了"，最多建议，不给 cleanable/archive
  if (refsMissing || ageMissing) return "suggest";
  if (score < Number(t.archive)) return "archive";
  if (daysSinceRef !== null && daysSinceRef !== undefined && daysSinceRef >= Number(t.staleDays) && score < Number(t.cleanable)) {
    return "cleanable";
  }
  if (Number(refCount) === 0 && daysSinceRef !== null && daysSinceRef !== undefined && daysSinceRef >= Number(t.neverRefDays)) {
    return "suggest";
  }
  return "suggest";
}

// ---------------------------------------------------------------------------
// 3. 出计划（纯函数，不写盘）
// ---------------------------------------------------------------------------

function buildReason(item) {
  const parts = [];
  if (item.pinned) parts.push("PIN/PERMANENT 保护");
  if (item.superseded) parts.push("已被同 topic 作废(status: superseded)");
  if (item.refsMissing) {
    parts.push("引用数据缺失，已降级为 年龄+importance");
  } else {
    parts.push(`引用 ${item.refCount} 次`);
    if (item.daysSinceRef !== null && item.daysSinceRef !== undefined) {
      parts.push(`${item.daysSinceRef} 天未引用`);
    }
  }
  if (item.daysSinceCreated !== null && item.daysSinceCreated !== undefined) {
    parts.push(`年龄 ${item.daysSinceCreated} 天`);
  }
  parts.push(`importance ${item.importance}`);
  return parts.join("；");
}

/**
 * 扫描结果 → 遗忘计划。纯函数：不读写磁盘、不修改入参。
 *
 * @param {Array} entries scanMemoryEntries 的输出（或同结构的手工条目）
 * @param {object} opts now / limits / thresholds / weights
 * @returns {{keep:Array, suggest:Array, cleanable:Array, archive:Array,
 *            stats:object, refsMissing:boolean, thresholds:object, weights:object,
 *            generatedAt:string}}
 */
export function planForgetting(entries = [], { now = Date.now(), limits = {}, thresholds = {}, weights = {} } = {}) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const nowMs = toTimestamp(now) ?? Date.now();
  const t = { ...THRESHOLDS, ...(thresholds || {}) };
  const list = Array.isArray(entries) ? entries.slice(0, Math.max(0, Number(lim.maxEntries) || 0)) : [];

  const buckets = { keep: [], suggest: [], cleanable: [], archive: [] };
  const stats = {
    total: 0, keep: 0, suggest: 0, cleanable: 0, archive: 0,
    refsMissing: 0,           // 真正因缺引用数据而降级的（非 PIN）
    refsMissingPinned: 0,     // 缺引用数据但被 PIN 保护，分类不依赖引用
    pinned: 0, superseded: 0, truncated: 0,
  };

  for (const entry of list) {
    const trust = computeTrustScore(entry, { now: nowMs, weights });
    const action = classify(trust, { thresholds: t });
    const text = String(entry.text ?? "");
    const preview = entry.preview || previewOf(text, lim.maxPreview);
    const item = {
      id: entry.id || `mem-${stats.total}`,
      kind: entry.kind || "unknown",
      source: entry.source || "",
      type: entry.type || "",
      file: entry.file || null,
      startLine: Number.isInteger(entry.startLine) ? entry.startLine : null,
      endLine: Number.isInteger(entry.endLine) ? entry.endLine : null,
      preview,
      score: trust.score,
      action,
      importance: trust.factors.importance,
      pinned: trust.pinned,
      superseded: Boolean(entry.superseded),
      refsMissing: trust.refsMissing,
      refCount: trust.refCount,
      daysSinceRef: trust.daysSinceRef,
      daysSinceCreated: trust.daysSinceCreated,
      createdAt: trust.createdAt,
      dateInferred: Boolean(entry.dateInferred),
      recallId: entry.recallId || null,
    };
    item.reason = buildReason(item);

    // 只有需要动盘的类别才携带全文（archive 用于搬进归档，cleanable 用于删除前备份/报告）
    if (action === "archive" || action === "cleanable") {
      item.text = text;
      if (entry.row) item.row = entry.row;
    }

    stats.total += 1;
    stats[action] = (stats[action] || 0) + 1;
    if (item.refsMissing) {
      if (item.pinned) stats.refsMissingPinned += 1;
      else stats.refsMissing += 1;
    }
    if (item.pinned) stats.pinned += 1;
    if (item.superseded) stats.superseded += 1;
    buckets[action].push(item);
  }

  if (Array.isArray(entries) && entries.length > list.length) {
    stats.truncated = entries.length - list.length;
  }

  // 危险项最小的排前面（报告先看最该处理的）
  buckets.cleanable.sort((a, b) => a.score - b.score || b.daysSinceCreated - a.daysSinceCreated);
  buckets.archive.sort((a, b) => a.score - b.score || b.daysSinceCreated - a.daysSinceCreated);
  buckets.suggest.sort((a, b) => a.score - b.score);
  buckets.keep.sort((a, b) => b.score - a.score);

  return {
    ...buckets,
    stats,
    refsMissing: (stats.refsMissing + stats.refsMissingPinned) > 0,
    thresholds: t,
    weights: { ...WEIGHTS, ...(weights || {}) },
    generatedAt: new Date(nowMs).toISOString(),
  };
}

/** 退出码语义：有 cleanable 或 archive → 2（需人看一眼）；否则 0（全 keep/仅建议）。 */
export function exitCodeFor(plan) {
  const cleanable = plan?.cleanable?.length || 0;
  const archive = plan?.archive?.length || 0;
  return (cleanable > 0 || archive > 0) ? 2 : 0;
}

// ---------------------------------------------------------------------------
// 4. 执行（默认 dry-run；只有显式 deleteCleanable 才删，且先备份）
// ---------------------------------------------------------------------------

function opSummary(op) {
  return {
    id: op.id,
    source: op.source,
    kind: op.kind,
    score: op.score,
    reason: op.reason,
    preview: op.preview,
    startLine: op.startLine ?? null,
    endLine: op.endLine ?? null,
  };
}

function normalizeEol(raw) {
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  return { eol, text: raw.replace(/\r\n/g, "\n") };
}

function stampForDir(nowMs) {
  return new Date(nowMs).toISOString().replace(/[:.]/g, "-");
}

function dateOf(nowMs) {
  // 本地日期（报告按使用者的日历天，不用 UTC 跨日）
  const d = new Date(nowMs);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function isInside(root, file) {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function archiveTargetFor(op, archiveDir, date) {
  if (op.kind === "sqlite") return path.join(archiveDir, `sqlite-memory-遗忘-${date}.md`);
  const raw = String(op.file || op.source || "memory").replace(/\\/g, "/");
  const base = path.basename(raw).replace(/\.md$/i, "") || "memory";
  return path.join(archiveDir, `${base}-遗忘-${date}.md`);
}

function mdReport(plan, result, date, nowIso) {
  const L = [];
  L.push(`# 遗忘清理报告（${date}）`);
  L.push("");
  L.push(`- 生成时间：${nowIso}`);
  L.push(`- 模式：${result.dryRun ? "dry-run（未写盘）" : "apply"}`);
  L.push(`- 扫描：${plan.stats.total} 条 · keep ${plan.stats.keep} · suggest ${plan.stats.suggest} · cleanable ${plan.stats.cleanable} · archive ${plan.stats.archive}`);
  L.push(`- 引用数据缺失：${plan.stats.refsMissing} 条（已降级为 年龄+importance，不给可清理结论）${plan.stats.refsMissingPinned ? `；另有 ${plan.stats.refsMissingPinned} 条 PIN 条目无需引用数据` : ""}`);
  L.push("");
  L.push("---");
  L.push("");
  L.push(`## 已归档（${result.archived}）`);
  L.push("");
  if (!result.archivedItems.length) {
    L.push("本次没有 archive 类条目。");
  } else {
    L.push("| ID | 来源 | 分数 | 原因 | 预览 |");
    L.push("|----|------|------|------|------|");
    for (const it of result.archivedItems) {
      L.push(`| ${String(it.id).slice(0, 28)} | ${it.source} | ${Number(it.score).toFixed(3)} | ${String(it.reason).replace(/\|/g, "\\|")} | ${String(it.preview).replace(/\|/g, "\\|")} |`);
    }
  }
  L.push("");
  L.push(`## 已删除（${result.deleted}）`);
  L.push("");
  L.push(result.deleted
    ? "> 仅因显式 `--delete-cleanable --yes` 执行；删除前已全量备份到 backups/Forget-<时间戳>/。"
    : "> cleanable 默认只报告、不删除。要删必须显式 `--delete-cleanable --yes`，且先备份。");
  L.push("");
  if (result.deletedItems.length) {
    L.push("| ID | 来源 | 分数 | 原因 | 预览 |");
    L.push("|----|------|------|------|------|");
    for (const it of result.deletedItems) {
      L.push(`| ${String(it.id).slice(0, 28)} | ${it.source} | ${Number(it.score).toFixed(3)} | ${String(it.reason).replace(/\|/g, "\\|")} | ${String(it.preview).replace(/\|/g, "\\|")} |`);
    }
  }
  if (result.skippedItems.length) {
    L.push("");
    L.push(`## 跳过（${result.skippedItems.length}）`);
    L.push("");
    for (const it of result.skippedItems) L.push(`- ${it.id}：${it.reason}`);
  }
  L.push("");
  L.push("## 说明");
  L.push("");
  L.push("- 记忆单位：md 日期/标题块、sqlite memories 行；运行时 jsonl 是遥测，不参与。");
  L.push("- archive = 移到 记忆/归档/ 并写归档日志，可被冷召回检索，不是删除。");
  L.push("- cleanable = 只报告；删除必须人工显式双开关，且已备份。");
  L.push("");
  return L.join("\n");
}

/**
 * 执行遗忘计划。**默认 dry-run，且 dry-run 不创建任何文件/目录。**
 *
 * @param {object} plan planForgetting 的返回值
 * @param {object} opts
 *   root            工作区根（默认 process.cwd()）
 *   archiveDir      归档目录（默认 <root>/记忆/归档）
 *   logPath         归档日志（默认 <root>/记忆/运行时/遗忘归档-<日期>.jsonl）
 *   reportPath      报告（默认 <root>/记忆/运行时/遗忘报告-<日期>.md）
 *   backupDir       删除前备份目录（默认 <root>/backups/Forget-<时间戳>）
 *   dryRun          默认 true
 *   deleteCleanable 默认 false；true 才会删 cleanable（调用方必须先拿到用户显式确认）
 *   now             时间
 * @returns {object} 执行结果（dry-run 只含 willArchive/willDelete，不含任何写盘动作）
 */
export function applyForgetting(plan = {}, opts = {}) {
  const root = path.resolve(opts.root || process.cwd());
  const nowMs = toTimestamp(opts.now) ?? Date.now();
  const dryRun = opts.dryRun !== false;
  const deleteCleanable = opts.deleteCleanable === true;
  const date = dateOf(nowMs);
  const archiveDir = path.resolve(root, opts.archiveDir || path.join("记忆", "归档"));
  const logPath = path.resolve(root, opts.logPath || path.join("记忆", "运行时", `遗忘归档-${date}.jsonl`));
  const reportPath = path.resolve(root, opts.reportPath || path.join("记忆", "运行时", `遗忘报告-${date}.md`));
  const backupDir = opts.backupDir
    ? path.resolve(root, opts.backupDir)
    : path.join(root, "backups", `Forget-${stampForDir(nowMs)}`);

  const archiveOps = Array.isArray(plan.archive) ? plan.archive : [];
  const deleteOps = deleteCleanable && Array.isArray(plan.cleanable) ? plan.cleanable : [];

  const base = {
    dryRun,
    archived: 0,
    deleted: 0,
    skipped: 0,
    archiveDir,
    logPath,
    reportPath,
    backupDir: deleteOps.length ? backupDir : null,
    archivedItems: [],
    deletedItems: [],
    skippedItems: [],
    archiveFiles: [],
    errors: [],
    written: [],
  };

  // ---- dry-run：只描述将要做什么，绝不落盘 ----
  if (dryRun) {
    return {
      ...base,
      willArchive: archiveOps.map(opSummary),
      willDelete: deleteOps.map(opSummary),
    };
  }

  // ---- 1. 删除前备份（先备份，后动手；备份失败就整体放弃删除） ----
  if (deleteOps.length) {
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      const deletedLines = [];
      const copied = new Set();
      for (const op of deleteOps) {
        // md：整文件复制一份，最坏情况能人工还原
        if (op.kind === "md" && op.file && fs.existsSync(op.file)) {
          const rel = path.relative(root, path.resolve(op.file));
          const dest = path.join(backupDir, rel.startsWith("..") ? path.basename(op.file) : rel);
          if (!copied.has(dest)) {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(op.file, dest);
            copied.add(dest);
          }
        }
        deletedLines.push(JSON.stringify({
          at: new Date(nowMs).toISOString(),
          mode: "delete",
          kind: op.kind,
          id: op.id,
          source: op.source,
          file: op.file || null,
          score: op.score,
          reason: op.reason,
          text: op.text || "",
          row: op.row || null,
        }));
      }
      fs.writeFileSync(path.join(backupDir, "deleted.jsonl"), deletedLines.join("\n") + (deletedLines.length ? "\n" : ""), "utf8");
      base.written.push(backupDir);
    } catch (e) {
      // 备份失败 → 不删任何东西
      base.errors.push(`备份失败，已放弃删除：${String(e?.message || e)}`);
      return base;
    }
  }

  // ---- 2. md 块：先写归档副本 → 再改源文件（copy before remove，写归档失败就保留原条目） ----
  const groups = new Map();
  const pushGroup = (op) => {
    if (!op.file) {
      base.skipped += 1;
      base.skippedItems.push({ id: op.id, reason: "缺少文件定位，无法移动/删除" });
      return;
    }
    const file = path.resolve(op.file);
    if (!isInside(root, file)) {
      base.skipped += 1;
      base.skippedItems.push({ id: op.id, reason: "文件不在工作区内，拒绝操作" });
      return;
    }
    if (!groups.has(file)) groups.set(file, []);
    groups.get(file).push(op);
  };
  for (const op of archiveOps) if (op.kind === "md") pushGroup(op);
  for (const op of deleteOps) if (op.kind === "md") pushGroup(op);

  const deleteSet = new Set(deleteOps);
  for (const [file, ops] of groups) {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (e) {
      base.errors.push(`读取失败 ${file}：${String(e?.message || e)}`);
      base.skipped += ops.length;
      continue;
    }
    const { eol, text } = normalizeEol(raw);
    const lines = text.split("\n");
    const acceptedRanges = [];
    const accepted = [];
    // 从后往前校验，行号不互相影响
    const sorted = [...ops].sort((a, b) => (b.startLine || 0) - (a.startLine || 0));
    for (const op of sorted) {
      const start = Number(op.startLine);
      const end = Number(op.endLine);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) {
        base.skipped += 1;
        base.skippedItems.push({ id: op.id, reason: "行号非法/越界，跳过" });
        continue;
      }
      // 计划后文件被人改过 → 内容对不上就跳过，绝不误删
      const current = lines.slice(start - 1, end).join("\n");
      if (current !== String(op.text || "").replace(/\r\n/g, "\n")) {
        base.skipped += 1;
        base.skippedItems.push({ id: op.id, reason: "内容已变化（计划后文件被改过），跳过" });
        continue;
      }
      if (acceptedRanges.some((r) => !(end < r.start || start > r.end))) {
        base.skipped += 1;
        base.skippedItems.push({ id: op.id, reason: "与其他条目行范围重叠，跳过" });
        continue;
      }
      acceptedRanges.push({ start, end });
      accepted.push({ op, start, end });
    }
    if (!accepted.length) continue;

    // 2a. archive 副本先落盘：正文进 记忆/归档/，成功后才从源文件移除
    const targetBodies = new Map();
    for (const a of accepted) {
      if (deleteSet.has(a.op)) continue;
      const target = archiveTargetFor(a.op, archiveDir, date);
      if (!targetBodies.has(target)) targetBodies.set(target, []);
      targetBodies.get(target).push(String(a.op.text || "").replace(/\r\n/g, "\n").trim());
    }
    const archiveOkTargets = new Set();
    if (targetBodies.size) {
      try {
        fs.mkdirSync(archiveDir, { recursive: true });
        for (const [target, bodies] of targetBodies) {
          const existed = fs.existsSync(target);
          fs.appendFileSync(target, (existed ? "\n\n" : "") + bodies.filter(Boolean).join("\n\n") + "\n", "utf8");
          archiveOkTargets.add(target);
          if (!base.archiveFiles.includes(target)) base.archiveFiles.push(target);
          base.written.push(target);
        }
      } catch (e) {
        base.errors.push(`归档副本写入失败（${file} 的 archive 条目保留原处）：${String(e?.message || e)}`);
      }
    }

    // 2b. 真正移除：delete 全做；archive 只在副本写成功后做
    const applied = [];
    for (const a of accepted) {
      if (!deleteSet.has(a.op)) {
        const target = archiveTargetFor(a.op, archiveDir, date);
        if (!archiveOkTargets.has(target)) {
          base.skipped += 1;
          base.skippedItems.push({ id: a.op.id, reason: "归档副本未写成，保留原条目" });
          continue;
        }
      }
      applied.push(a);
    }
    if (!applied.length) continue;

    const remove = new Set();
    for (const a of applied) for (let i = a.start - 1; i < a.end; i += 1) remove.add(i);
    const kept = lines.filter((_, i) => !remove.has(i)).join("\n");
    const out = kept.endsWith("\n") || kept === "" ? kept : kept + "\n";
    try {
      atomicWriteText(file, eol === "\r\n" ? out.replace(/\n/g, "\r\n") : out);
      base.written.push(file);
    } catch (e) {
      base.errors.push(`写回失败 ${file}（归档副本已写，原文件未改）：${String(e?.message || e)}`);
      base.skipped += applied.length;
      continue;
    }
    for (const a of applied) {
      if (deleteSet.has(a.op)) {
        base.deleted += 1;
        base.deletedItems.push(opSummary(a.op));
      } else {
        base.archived += 1;
        base.archivedItems.push(opSummary(a.op));
      }
    }
  }

  // ---- 3. sqlite 行：archive = 先写归档正文，再把 status 改 archived；delete = 硬删（前面已备份 JSON） ----
  const sqliteArchive = archiveOps.filter((op) => op.kind === "sqlite");
  const sqliteDelete = deleteOps.filter((op) => op.kind === "sqlite");
  if (sqliteArchive.length || sqliteDelete.length) {
    const dbFile = path.join(root, "memory", "memory.db");
    // 3a. 归档正文先落盘（正文 = id + summary）；写失败的行不归档，保留 active
    const archiveOk = new Set();
    if (sqliteArchive.length) {
      try {
        fs.mkdirSync(archiveDir, { recursive: true });
        for (const op of sqliteArchive) {
          const id = String(op.id || "").replace(/^sqlite:/, "");
          const target = archiveTargetFor(op, archiveDir, date);
          const existed = fs.existsSync(target);
          fs.appendFileSync(target, (existed ? "\n\n" : "") + `### sqlite ${id}\n${String(op.text || "").trim()}\n`, "utf8");
          archiveOk.add(op);
          if (!base.archiveFiles.includes(target)) base.archiveFiles.push(target);
          base.written.push(target);
        }
      } catch (e) {
        base.errors.push(`sqlite 归档正文写入失败（对应行保持 active）：${String(e?.message || e)}`);
      }
    }
    let db = null;
    try {
      db = new DatabaseSync(dbFile);
      db.exec("BEGIN");
      const upd = db.prepare("UPDATE memories SET status = 'archived', updated_at = ? WHERE memory_id = ? AND status = 'active'");
      const del = db.prepare("DELETE FROM memories WHERE memory_id = ?");
      for (const op of sqliteArchive) {
        const id = String(op.id || "").replace(/^sqlite:/, "");
        if (!archiveOk.has(op)) {
          base.skipped += 1;
          base.skippedItems.push({ id: op.id, reason: "归档正文未写成，保留 active" });
          continue;
        }
        const r = upd.run(nowMs, id);
        if (r.changes > 0) {
          base.archived += 1;
          base.archivedItems.push(opSummary(op));
        } else {
          base.skipped += 1;
          base.skippedItems.push({ id: op.id, reason: "sqlite 行不存在或已归档，跳过" });
        }
      }
      for (const op of sqliteDelete) {
        const id = String(op.id || "").replace(/^sqlite:/, "");
        const r = del.run(id);
        if (r.changes > 0) {
          base.deleted += 1;
          base.deletedItems.push(opSummary(op));
        } else {
          base.skipped += 1;
          base.skippedItems.push({ id: op.id, reason: "sqlite 行不存在，跳过" });
        }
      }
      db.exec("COMMIT");
    } catch (e) {
      try { db?.exec("ROLLBACK"); } catch {}
      base.errors.push(`sqlite 执行失败：${String(e?.message || e)}`);
    } finally {
      try { db?.close(); } catch {}
    }
  }

  // ---- 5. 归档日志（JSONL，只记元数据+摘要；正文在归档 md 里） ----
  const acceptedArchive = base.archivedItems;
  if (acceptedArchive.length) {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      const lines = acceptedArchive.map((it) => JSON.stringify({
        at: new Date(nowMs).toISOString(),
        mode: "archive",
        kind: it.kind,
        id: it.id,
        source: it.source,
        score: it.score,
        reason: it.reason,
        preview: it.preview,
        textSha: shortHash(it.preview),
      }));
      fs.appendFileSync(logPath, lines.join("\n") + "\n", "utf8");
      base.written.push(logPath);
    } catch (e) {
      base.errors.push(`归档日志写入失败：${String(e?.message || e)}`);
    }
  }

  // ---- 6. md 报告（apply 必写；讲清归档了什么、删了什么、跳过了什么） ----
  try {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, mdReport(plan, base, date, new Date(nowMs).toISOString()), "utf8");
    base.written.push(reportPath);
  } catch (e) {
    base.errors.push(`报告写入失败：${String(e?.message || e)}`);
  }

  base.written = [...new Set(base.written)];
  base.ok = base.errors.length === 0;
  return base;
}

// ---------------------------------------------------------------------------
// 5. 扫描元枢的真实记忆源
// ---------------------------------------------------------------------------

// 记忆源配置：unit 决定"一条记忆"的边界
export const MD_SOURCES = Object.freeze([
  { rel: "记忆/记忆日志.md", type: "log", parser: "dated", recallSource: "log", baseImportance: 0.5 },
  { rel: "记忆/纠正记忆.md", type: "correction", parser: "heading", recallSource: "correction", baseImportance: 0.8, pinned: true },
  { rel: "记忆/关系记忆.md", type: "relation", parser: "h2", recallSource: "relation", baseImportance: 0.85, pinned: true },
  { rel: "记忆.md", type: "fixed", parser: "h2", recallSource: "fixed", baseImportance: 0.9, pinned: true },
]);

// 明确不扫的，连同原因写进扫描结果（避免以后有人问"为什么不清理这些"）
export const SKIPPED_SOURCES = Object.freeze([
  { file: "记忆/自我.md", reason: "由 engine/self-model.mjs 生成，每次重写，不属于可遗忘记忆" },
  { file: "记忆/工作记忆.md", reason: "交接文档，不是记忆条目" },
  { file: "记忆/技能记忆.md", reason: "能力资产清单，不是记忆条目" },
  { file: "记忆/经验库.md", reason: "经验库有独立卫生策略（engine/memory/hygiene.mjs）" },
  { file: "记忆/Wiki/", reason: "主题 Wiki，由 engine/memory/wiki.mjs 维护，另有 .stale.json 过期机制" },
  { file: "记忆/做梦/", reason: "做梦流水/轨迹/教训账，是梦境管线产物，不是召回记忆条目" },
  { file: "记忆/心情日记/", reason: "由情绪流水生成的日记产物" },
  { file: "记忆/快照/", reason: "整库快照，用于回滚，不是现行记忆" },
  { file: "记忆/草案区/ · 人格修订/ · 进化/ · 研究/ · 知识/", reason: "草案/治理/进化/研究产物，不是召回记忆条目" },
  { file: "记忆/记忆日志.md.archive.md", reason: "已经是归档层" },
  { file: "记忆/记忆日志.md.bak-*", reason: "备份文件，不是现行记忆" },
  { file: "记忆/记忆库/", reason: "git 记忆库，当前只有空壳 MEMORY.md 与 notes，未接入召回" },
  { file: "记忆/运行时/*.jsonl", reason: "情绪潮汐/记忆召回/动作审计等是遥测流水，不是记忆条目" },
]);

const HEADING_RE = {
  dated: /^#{2,4}\s+\d{4}-\d{2}-\d{2}/,
  heading: /^#{2,4}\s/,
  h2: /^##\s/,
};

const PIN_RE = /\bPERMANENT\b|\bPIN\b|🔒|永久保留/;
const SUPERSEDED_RE = /^- status:\s*superseded\b/m;

function extractDate(text, heading) {
  // 标题里的日期优先（记忆日志的写入时间）
  const head = String(heading || "");
  let m = head.match(/(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}))?/);
  if (m) {
    return {
      ms: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0)).getTime(),
      inferred: false,
    };
  }
  // 正文里最后一个日期（关系记忆每条末尾括注日期）
  const all = [...String(text || "").matchAll(/(\d{4})-(\d{2})-(\d{2})/g)];
  if (all.length) {
    const last = all[all.length - 1];
    return {
      ms: new Date(Number(last[1]), Number(last[2]) - 1, Number(last[3])).getTime(),
      inferred: false,
    };
  }
  return { ms: null, inferred: true };
}

function heuristicImportance(text, base) {
  let imp = Number(base) || 0.5;
  if (PIN_RE.test(text)) imp = Math.max(imp, 0.9);
  if (/红线|禁止|必须|约定|教训|纠正|拍板|决定/.test(text)) imp = Math.max(imp, 0.7);
  if (/【归档】/.test(text)) imp = Math.min(imp, 0.3);
  return round2(imp);
}

/** 按标题把 md 切成条目；首个标题前的说明区不参与（与 memory/hygiene 的 preamble 口径一致）。 */
export function splitMdEntries(raw, parser = "heading") {
  const re = HEADING_RE[parser] || HEADING_RE.heading;
  const lines = String(raw || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let cur = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (re.test(line)) {
      if (cur) out.push(cur);
      cur = { startLine: i + 1, endLine: i + 1, lines: [line], heading: line };
    } else if (cur) {
      cur.lines.push(line);
      cur.endLine = i + 1;
    }
  }
  if (cur) out.push(cur);
  return out.map((b) => {
    // 行范围裁掉块尾空行：这样 text 与 lines.slice(start-1, end).join("\n") 完全一致，
    // apply 时的"内容未变"校验才不会因为空行误判。
    let endLine = b.endLine;
    while (endLine > b.startLine && String(lines[endLine - 1]).trim() === "") endLine -= 1;
    return {
      startLine: b.startLine,
      endLine,
      heading: b.heading,
      text: lines.slice(b.startLine - 1, endLine).join("\n"),
    };
  });
}

function loadRecallJournal(root) {
  const file = path.join(root, "记忆", "运行时", "记忆召回.json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const stats = raw?.stats && typeof raw.stats === "object" ? raw.stats : {};
    const ats = [];
    for (const st of Object.values(stats)) {
      if (Number(st?.lastInjectedAt) > 0) ats.push(Number(st.lastInjectedAt));
      if (Number(st?.lastUsedAt) > 0) ats.push(Number(st.lastUsedAt));
    }
    for (const r of Array.isArray(raw?.recent) ? raw.recent : []) if (Number(r?.at) > 0) ats.push(Number(r.at));
    for (const p of Array.isArray(raw?.pending) ? raw.pending : []) if (Number(p?.at) > 0) ats.push(Number(p.at));
    return {
      available: true,
      file,
      stats,
      coverageStart: ats.length ? Math.min(...ats) : null,
    };
  } catch {
    return { available: false, file, stats: {}, coverageStart: null };
  }
}

/**
 * 把引用数据接到一条记忆上。
 * 台账只从 coverageStart 起有效：早于它的条目拿不到 → refsMissing:true，明确降级。
 */
function resolveRefs(journal, recallId, createdAtMs) {
  if (!journal.available) {
    return { refsMissing: true, refCount: null, lastRefAt: null, refsFrom: "unavailable" };
  }
  const st = recallId ? journal.stats[recallId] : null;
  if (st) {
    const injected = Math.max(0, Number(st.injected) || 0);
    const lastInjected = Number(st.lastInjectedAt) || 0;
    const lastUsed = Number(st.lastUsedAt) || 0;
    const lastRefAt = Math.max(lastInjected, lastUsed) || null;
    return { refsMissing: false, refCount: injected, lastRefAt, refsFrom: "journal" };
  }
  // 台账起点之后的"查不到" = 真实没被引用过；之前的 = 台账没覆盖，不能下结论
  if (createdAtMs !== null && journal.coverageStart !== null && createdAtMs >= journal.coverageStart) {
    return { refsMissing: false, refCount: 0, lastRefAt: null, refsFrom: "journal-absence" };
  }
  return { refsMissing: true, refCount: null, lastRefAt: null, refsFrom: "uncovered" };
}

/**
 * 扫描工作区里的记忆条目（只读）。
 *
 * @returns {{entries:Array, sources:Array, skipped:Array, warnings:Array,
 *            journal:{available:boolean, coverageStart:number|null, tracked:number}}}
 */
export function scanMemoryEntries({ root = process.cwd(), now = Date.now(), includeSqlite = true, journal = true } = {}) {
  const rootAbs = path.resolve(root);
  const nowMs = toTimestamp(now) ?? Date.now();
  const entries = [];
  const sources = [];
  const warnings = [];
  const journalState = journal ? loadRecallJournal(rootAbs) : { available: false, stats: {}, coverageStart: null, file: null };

  for (const cfg of MD_SOURCES) {
    const file = path.join(rootAbs, ...cfg.rel.split("/"));
    if (!fs.existsSync(file)) {
      sources.push({ file: cfg.rel, type: cfg.type, unit: cfg.parser, entries: 0, exists: false, pinned: Boolean(cfg.pinned) });
      continue;
    }
    let raw = "";
    let mtimeMs = null;
    try {
      raw = fs.readFileSync(file, "utf8");
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch (e) {
      warnings.push(`读取 ${cfg.rel} 失败：${String(e?.message || e)}`);
      continue;
    }
    const blocks = splitMdEntries(raw, cfg.parser);
    let count = 0;
    for (const block of blocks) {
      const text = String(block.text).trim();
      if (!text) continue;
      const date = extractDate(text, block.heading);
      const createdAt = date.ms ?? mtimeMs;
      const dateInferred = date.ms === null;
      const recallId = memoryId(cfg.recallSource, text);
      const refs = resolveRefs(journalState, recallId, createdAt);
      const pinned = Boolean(cfg.pinned) || PIN_RE.test(text);
      const superseded = SUPERSEDED_RE.test(text);
      entries.push({
        id: `md:${cfg.rel}#${shortHash(text)}`,
        kind: "md",
        source: cfg.rel,
        type: cfg.type,
        file,
        startLine: block.startLine,
        endLine: block.endLine,
        text,
        preview: previewOf(text),
        createdAt,
        dateInferred,
        importance: heuristicImportance(text, cfg.baseImportance),
        pinned,
        superseded,
        recallId,
        ...refs,
      });
      count += 1;
    }
    sources.push({
      file: cfg.rel,
      type: cfg.type,
      unit: cfg.parser === "dated" ? "日期标题块" : cfg.parser === "h2" ? "## 主题段" : "标题块",
      entries: count,
      exists: true,
      pinned: Boolean(cfg.pinned),
      refs: journalState.available ? "记忆召回.json" : "无（降级）",
    });
  }

  // sqlite：一条记忆 = 一行
  if (includeSqlite) {
    const dbFile = path.join(rootAbs, "memory", "memory.db");
    if (!fs.existsSync(dbFile)) {
      sources.push({ file: "memory/memory.db", type: "sqlite", unit: "memories 行", entries: 0, exists: false });
    } else {
      let db = null;
      try {
        db = new DatabaseSync(dbFile, { readOnly: true });
        const rows = db.prepare("SELECT * FROM memories WHERE status = 'active'").all();
        let count = 0;
        for (const row of rows) {
          const created = Number(row.created_at) || null;
          const last = row.last_accessed_at === null || row.last_accessed_at === undefined
            ? null
            : Number(row.last_accessed_at) || null;
          const refCount = Math.max(0, Number(row.access_count) || 0);
          const expired = Boolean(Number(row.expire_at) > 0 && Number(row.expire_at) < nowMs);
          entries.push({
            id: `sqlite:${row.memory_id}`,
            kind: "sqlite",
            source: "memory/memory.db",
            type: String(row.memory_type || "memory"),
            file: dbFile,
            startLine: null,
            endLine: null,
            text: String(row.summary || ""),
            preview: previewOf(row.summary),
            createdAt: created,
            dateInferred: false,
            importance: Math.max(0, Math.min(1, Number(row.importance_score ?? 0.5))),
            pinned: false,
            superseded: false,
            recallId: null,
            refCount,                 // access_count 是真计数
            lastRefAt: last,           // null = 从未访问过（不是"拿不到"）
            refsMissing: false,
            refsFrom: "sqlite",
            expired,
            row: { ...row },
          });
          count += 1;
        }
        sources.push({ file: "memory/memory.db", type: "sqlite", unit: "memories 行", entries: count, exists: true });
      } catch (e) {
        warnings.push(`读取 memory/memory.db 失败：${String(e?.message || e)}`);
        sources.push({ file: "memory/memory.db", type: "sqlite", unit: "memories 行", entries: 0, exists: true, error: true });
      } finally {
        try { db?.close(); } catch {}
      }
    }
  }

  return {
    entries,
    sources,
    skipped: SKIPPED_SOURCES,
    warnings,
    journal: {
      available: journalState.available,
      coverageStart: journalState.coverageStart,
      tracked: Object.keys(journalState.stats || {}).length,
    },
  };
}
