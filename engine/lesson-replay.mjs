// engine/lesson-replay.mjs —— 教训复习（replay，2026-11-09）
//
// 为什么要有这一层：engine/lesson-promotion.mjs 只做「记账 → 复现检测 → 提案」，
// 教训写完就再没人读过——账本越攒越厚，她在类似场景里却想不起来。曦/林心语那边是
// replay_count + last_replayed + 定时重放，这里补上"想得起来"的那一半。
//
// 设计取舍（别改成"每天的教训全塞进 prompt"）：
//   ① 一天最多念一次、最多 2 条（INJECT 走 记忆/运行时/复习状态.json 的 lastInjectedDate）。
//      教训是"别忘"的东西，不是每日箴言；一天念叨一条以上就开始像背景音，会被整段忽略。
//   ② 到期按 importance 分级：high 7 天 / medium 14 天 / low 30 天。importance 没写在账本里时
//      按**同主题出现次数**推断（≥3 次高、2 次中、1 次低）：反复复现的主题才值得常回看，
//      只出现过一次的多半是一次性事故，30 天扫一眼够了。
//   ③ 从没复习过的按**入库时间**起算，不是立刻到期：昨晚刚写的教训今早就"复习"，
//      等于把复盘再念一遍，只增加重复感。
//   ④ 同一主题一天只出一条，且**不连着两天念同一个主题**（昨天念过的主题今天先让给别人）：
//      账本里「完成判据」有 10 条近似的话，不限主题的话会连着五天都在说同一件事。
//   ⑤ 选择是纯函数（selectDueLessons），读盘/写盘只在 markReplayed / replayPromptLine 里，
//      方便测试，也方便以后换数据源。
//   ⑥ 账本坏了/不存在一律降级为零注入：教训复习挂掉不该影响开轮。
//
// 落盘：记忆/做梦/教训账.json（复习字段写回原条目）
//       记忆/运行时/复习记录.jsonl（每次复习一行，留痕）
//       记忆/运行时/复习状态.json（lastInjectedDate：一天只注入一次的闸门）
//
// 与复现检测的联动（价值点）：一条教训复习后 REPLAY_RECURRENCE_DAYS 天内又被复现，
// engine/lesson-promotion.mjs 会给它打 replayEscalated 标、把提案优先级升一档；这里只负责
// 把标翻译成一句「（复习后仍复现，已升级）」，不重算相似度。

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { atomicWriteJson } from "./atomic-io.mjs";
import { LESSON_LEDGER, loadLessonLedger } from "./lesson-promotion.mjs";

export const REPLAY_STATE_REL = path.join("记忆", "运行时", "复习状态.json");
export const REPLAY_LOG_REL = path.join("记忆", "运行时", "复习记录.jsonl");
export const PROMPT_PREFIX = "复习：";
export const DAY_MS = 24 * 60 * 60 * 1000;

// 阈值都写成常量：测试直接引用，别在别处再抄一份魔法数字。
export const SPACING_DAYS = Object.freeze({ high: 7, medium: 14, low: 30 });
export const DEFAULT_MAX_PER_DAY = 2; // 一天最多念几条
export const DEFAULT_IMPORTANCE = "medium";
export const IMPORTANCE_RANK = Object.freeze({ low: 1, medium: 2, high: 3 });
// 没写 importance 时按同主题出现次数推断的阈值
export const IMPORTANCE_BY_FREQUENCY = Object.freeze({ high: 3, medium: 2 });
export const NOTE_TEXT_MAX = 60; // 注入那句话的长度上限：一行读得动

let wsRoot = "";

/** 工作区根。服务启动时由 engine/emotion.mjs 的 init 调一次；测试里显式传 root。 */
export function init(root) {
  wsRoot = root == null ? "" : String(root);
}

// ── 小工具 ─────────────────────────────────────────────────────────────

const clean = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** 与 lesson-promotion 的 topicKey 同义：比较主题词时去掉标点和空白，别因为全半角判成两个主题。 */
function topicKey(t) {
  return clean(t, 24).toLowerCase().replace(/[\s·・,，。:：;；、/\\|()（）「」【】"'`-]+/g, "");
}

function toDate(v) {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : new Date();
  const t = Date.parse(String(v ?? ""));
  return Number.isFinite(t) ? new Date(t) : new Date();
}

const pad2 = (n) => String(n).padStart(2, "0");

/** 本地日期 YYYY-MM-DD。一天一次的"天"是人的天，不是 UTC 的天。 */
export function ymdOf(v = new Date()) {
  const d = toDate(v);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地 MM-DD：文案里的"上次 11-02"。 */
function mmddOf(v) {
  const t = Date.parse(String(v ?? ""));
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * 教训的稳定 id。真实账本里只有 text/topic/ymd/at，没有 id 字段，
 * 所以按 ymd+at+正文算一个：账本条目顺序变了、被 LESSON_CAP 截过头，也还能对上。
 */
export function lessonId(lesson) {
  const raw = `${lesson?.ymd || ""}|${lesson?.at || ""}|${lesson?.text || ""}`;
  const h = createHash("sha1").update(raw).digest("hex").slice(0, 10);
  return `L-${h}`;
}

/**
 * 重要性：账本里写了就听写的；没写就按同主题出现次数推断（≥3 高 / 2 中 / 1 低）。
 * topicCounts 传 null 表示"没有全账本可参照"，回落到 DEFAULT_IMPORTANCE。
 */
export function importanceOf(lesson, topicCounts = null) {
  const explicit = clean(lesson?.importance, 12).toLowerCase();
  if (IMPORTANCE_RANK[explicit]) return explicit;
  if (!topicCounts) return DEFAULT_IMPORTANCE;
  const key = topicKey(lesson?.topic);
  if (!key) return DEFAULT_IMPORTANCE;
  const n = Number(topicCounts instanceof Map ? topicCounts.get(key) : topicCounts[key]) || 0;
  if (n >= IMPORTANCE_BY_FREQUENCY.high) return "high";
  if (n >= IMPORTANCE_BY_FREQUENCY.medium) return "medium";
  return "low";
}

function topicCountsOf(lessons) {
  const counts = new Map();
  for (const l of lessons) {
    const key = topicKey(l?.topic);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

/** 起算点：复习过看 lastReplayed（上次回看），没复习过看入库时间（at，退回 ymd 当天）。 */
function anchorMsOf(lesson) {
  const last = Date.parse(String(lesson?.lastReplayed ?? ""));
  const replayed = Number(lesson?.replayCount) > 0 || Number.isFinite(last);
  if (replayed && Number.isFinite(last)) return { ms: last, replayed: true, lastMs: last };
  const at = Date.parse(String(lesson?.at ?? ""));
  if (Number.isFinite(at)) return { ms: at, replayed: false, lastMs: NaN };
  const m = String(lesson?.ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return { ms: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0).getTime(), replayed: false, lastMs: NaN };
  return { ms: NaN, replayed: false, lastMs: NaN };
}

// ── 选择（纯函数）──────────────────────────────────────────────────────

/**
 * 挑出今天该复习的教训。纯函数：不读盘、不写盘，账本数组进来、条目数组出去。
 *
 * 顺序：从没复习过的 → 其余按 lastReplayed 最久 → 同久时 importance 高 → 入库早的 → 账本顺序。
 * 到期：距起算点 ≥ 该条 importance 的间隔天数（high 7 / medium 14 / low 30）。
 * 一天最多 maxPerDay 条，同一主题只出一条；avoidTopics（昨天念过的主题）先让开，
 * 实在凑不满再回头补——宁可复用主题，也不要因为避让而整天不念。
 *
 * @param {{lessons?: Array, now?: Date, maxPerDay?: number, spacing?: object, avoidTopics?: string[]}} opts
 * @returns {Array} 原条目引用（最多 maxPerDay 条）
 */
export function selectDueLessons({ lessons = [], now = new Date(), maxPerDay = DEFAULT_MAX_PER_DAY, spacing = SPACING_DAYS, avoidTopics = [] } = {}) {
  const list = (Array.isArray(lessons) ? lessons : []).filter((l) => l && clean(l.text, 200));
  const limit = Number.isFinite(Number(maxPerDay)) ? Math.max(0, Math.floor(Number(maxPerDay))) : DEFAULT_MAX_PER_DAY;
  if (!list.length || limit === 0) return [];
  const nowMs = toDate(now).getTime();
  const counts = topicCountsOf(list);
  const table = spacing && typeof spacing === "object" ? spacing : SPACING_DAYS;

  const rows = [];
  list.forEach((lesson, index) => {
    const importance = importanceOf(lesson, counts);
    const days = Number(table[importance] ?? table.medium ?? SPACING_DAYS.medium);
    const anchor = anchorMsOf(lesson);
    const due = !Number.isFinite(anchor.ms) || nowMs - anchor.ms >= days * DAY_MS;
    rows.push({ lesson, index, importance, rank: IMPORTANCE_RANK[importance] || 0, anchor, due });
  });

  rows.sort((a, b) => {
    // ① 从没复习过的优先
    const ra = a.anchor.replayed ? 1 : 0;
    const rb = b.anchor.replayed ? 1 : 0;
    if (ra !== rb) return ra - rb;
    // ② 复习过的：上次回看越久越先
    if (ra === 1 && a.anchor.lastMs !== b.anchor.lastMs) return a.anchor.lastMs - b.anchor.lastMs;
    // ③ 同久（或同为没复习过）：importance 高的先
    if (a.rank !== b.rank) return b.rank - a.rank;
    // ④ 入库早的先（老教训先想起来），最后按账本顺序稳定排序
    const am = Number.isFinite(a.anchor.ms) ? a.anchor.ms : 0;
    const bm = Number.isFinite(b.anchor.ms) ? b.anchor.ms : 0;
    if (am !== bm) return am - bm;
    return a.index - b.index;
  });

  const out = [];
  const seenTopics = new Set();
  const picked = new Set();
  const avoid = new Set((Array.isArray(avoidTopics) ? avoidTopics : []).map((t) => topicKey(t)).filter(Boolean));
  const pick = (allowAvoided) => {
    for (const row of rows) {
      if (out.length >= limit) break;
      if (!row.due || picked.has(row.index)) continue;
      const key = topicKey(row.lesson.topic);
      if (key && seenTopics.has(key)) continue;
      if (!allowAvoided && key && avoid.has(key)) continue;
      if (key) seenTopics.add(key);
      picked.add(row.index);
      out.push(row.lesson);
    }
  };
  pick(false);
  if (out.length < limit) pick(true); // 避让过头就补：宁可复用主题，也别整天不念
  return out;
}

// ── 文案 ───────────────────────────────────────────────────────────────

/**
 * 注入用的一行：`复习：<一句话>（第 N 次回看，上次 11-02）`。
 * N 是"这一次是第几次回看"，所以从没复习过的是第 1 次。
 * 复习后仍复现的（lesson-promotion 打的 replayEscalated 标）后面追一句。
 */
export function dueNote(lesson) {
  const raw = clean(lesson?.text, 200);
  const text = raw.length > NOTE_TEXT_MAX ? `${raw.slice(0, NOTE_TEXT_MAX)}…` : raw;
  const n = (Number(lesson?.replayCount) || 0) + 1;
  const last = mmddOf(lesson?.lastReplayed);
  const tail = last ? `第 ${n} 次回看，上次 ${last}` : `第 ${n} 次回看，首次复习`;
  const escalated = lesson?.replayEscalated ? "（复习后仍复现，已升级）" : "";
  return `${PROMPT_PREFIX}${text}（${tail}）${escalated}`;
}

/** 历史里已经有复习块 = 同一段对话不重复注入（和反模式台账一个手法）。 */
export function alreadyInjected(history = []) {
  return (Array.isArray(history) ? history : []).some(
    (m) => m && m.role === "system" && String(m.content || "").includes(PROMPT_PREFIX),
  );
}

// ── 记账 ───────────────────────────────────────────────────────────────

function ledgerOf(root) {
  const r = String(root || "");
  return r ? path.join(r, LESSON_LEDGER) : "";
}

/**
 * 记一次复习：replayCount +1、lastReplayed 写回，原子写盘；每次一条进复习记录 jsonl。
 * 账本缺失/坏掉一律返回 {ok:false}，不抛错、也不静默重建坏文件（坏账本要人来看）。
 */
export function markReplayed(root, ids, { now = new Date(), fsMod = fs } = {}) {
  const r = String(root || "");
  if (!r) return { ok: false, error: "没有工作区根，不知道往哪记", updated: [], missing: [] };
  const want = [...new Set((Array.isArray(ids) ? ids : [ids]).map((x) => String(x ?? "").trim()).filter(Boolean))];
  if (!want.length) return { ok: true, updated: [], missing: [] };

  const file = ledgerOf(r);
  if (!fsMod.existsSync(file)) return { ok: false, error: "教训账不存在", updated: [], missing: want, file };
  let doc;
  try {
    doc = JSON.parse(fsMod.readFileSync(file, "utf8"));
  } catch (e) {
    return { ok: false, error: `教训账读不了：${String(e?.message || e)}`, updated: [], missing: want, file };
  }
  const lessons = Array.isArray(doc) ? doc : doc?.lessons;
  if (!Array.isArray(lessons)) return { ok: false, error: "教训账格式不对：没有 lessons 数组", updated: [], missing: want, file };

  const at = toDate(now).toISOString();
  const updated = [];
  const missing = [];
  for (const id of want) {
    const lesson = lessons.find((l) => l && lessonId(l) === id);
    if (!lesson) { missing.push(id); continue; }
    lesson.replayCount = (Number(lesson.replayCount) || 0) + 1;
    lesson.lastReplayed = at;
    updated.push({ id, text: clean(lesson.text, 200), topic: clean(lesson.topic, 24), replayCount: lesson.replayCount, lastReplayed: at });
  }
  if (!updated.length) return { ok: false, error: "账本里没有这些教训", updated, missing, file };

  atomicWriteJson(file, doc, fsMod);

  // 留痕：先写账本再写流水。流水写失败不影响复习本身（账已经记上了）。
  const log = path.join(r, REPLAY_LOG_REL);
  let logged = true;
  try {
    fsMod.mkdirSync(path.dirname(log), { recursive: true });
    fsMod.appendFileSync(log, updated.map((u) => JSON.stringify({ at, ...u })).join("\n") + "\n", "utf8");
  } catch { logged = false; }
  return { ok: true, updated, missing, file, log, logged };
}

// ── 开轮注入（一天最多一次）────────────────────────────────────────────

export function readReplayState(root = wsRoot) {
  const r = String(root || "");
  const blank = { lastInjectedDate: "", lastInjectedAt: "", lastIds: [], lastTopics: [] };
  if (!r) return blank;
  try {
    const d = JSON.parse(fs.readFileSync(path.join(r, REPLAY_STATE_REL), "utf8"));
    return {
      lastInjectedDate: clean(d?.lastInjectedDate, 10),
      lastInjectedAt: String(d?.lastInjectedAt || ""),
      lastIds: Array.isArray(d?.lastIds) ? d.lastIds.map((x) => String(x)) : [],
      lastTopics: Array.isArray(d?.lastTopics) ? d.lastTopics.map((x) => clean(x, 24)).filter(Boolean) : [],
    };
  } catch { return blank; }
}

/**
 * 开轮注入用的一块（IO 包装）：读账本 → 挑到期 → 记账 → 写状态 → 返回文本。
 *
 * 只在**每天第一次**进对话时真的注入；同一天再进来返回 ""（零成本）。
 * 历史里已经有「复习：」也不注入（同一段对话不重复念）。
 * 没有到期条目 → ""，且不写状态、不写记录（零注入就是零痕迹）。
 * 读盘/账本/写盘任何一步出问题都返回 ""：绝不因为复习影响开轮。
 */
export function replayPromptLine({ history = [], now = new Date(), root = wsRoot, maxPerDay = DEFAULT_MAX_PER_DAY, spacing = SPACING_DAYS } = {}) {
  try {
    const r = String(root || "");
    if (!r) return "";
    if (alreadyInjected(history)) return "";
    const day = ymdOf(now);
    const state = readReplayState(r);
    if (state.lastInjectedDate === day) return "";
    // 昨天念过的主题今天先让开（avoidTopics）：同一件事别连着两天说。
    const due = selectDueLessons({ lessons: loadLessonLedger(r).lessons, now, maxPerDay, spacing, avoidTopics: state.lastTopics });
    if (!due.length) return "";
    const lines = due.map((l) => dueNote(l));
    const ids = due.map((l) => lessonId(l));
    const marked = markReplayed(r, ids, { now });
    // 记不上账就别注入：否则这一天里每一轮都会把同样的话再念一遍。
    if (!marked.ok) return "";
    atomicWriteJson(path.join(r, REPLAY_STATE_REL), {
      lastInjectedDate: day,
      lastInjectedAt: toDate(now).toISOString(),
      lastIds: ids,
      lastTopics: [...new Set(due.map((l) => clean(l.topic, 24)).filter(Boolean))],
    });
    return lines.join("\n");
  } catch { return ""; }
}
