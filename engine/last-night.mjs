// engine/last-night.mjs —— 灵魂页「昨夜」卡的数据（2026-10-07）
//
// 每晚 0 点的复盘 + 自动执行 + 教训晋升 + 每 6h 的做梦，结果散在四个文件里，
// 伙伴早上想知道「昨晚她干了什么、有什么等我点」要翻日志。这里只读、只汇总，不判断、不改任何账。
import fs from "node:fs";
import path from "node:path";
import { listTraces } from "./trace.mjs";
import { legacyLessons, parseReflectionLessons } from "./lesson-promotion.mjs";
import { loadPromises, PROMISE_STALE_DAYS } from "./promises.mjs";

const LOG = path.join("文档", "时间引擎日志.md");
const LEDGER = path.join("记忆", "承诺兑现.json");
const clip = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

/** 日志里某任务的最后一条：标题行、正文首个一级标题、自动执行小节。 */
export function lastLogEntry(text, taskId) {
  const re = new RegExp(`^### (\\S+) \\[${taskId}\\/[^\\]]*\\][^\\n]*$`, "gm");
  let m, last = null;
  while ((m = re.exec(text))) last = m;
  if (!last) return null;
  const start = last.index + last[0].length;
  const next = text.slice(start).search(/^### \d{4}-\d\d-\d\dT/m);
  const body = next < 0 ? text.slice(start) : text.slice(start, start + next);
  const title = (body.match(/^# (.+)$/m) || [])[1] || "";
  const exec = body.match(/^#### 自动执行（([^）\n]*)）\s*\n([\s\S]*?)(?=^#{1,4} |\s*$(?![\s\S]))/m);
  const rows = exec ? [...exec[2].matchAll(/^- \[([a-z]+)(\/已结清)?\] (.+)$/gm)].map((r) => ({ status: r[1], closed: !!r[2], text: clip(r[3], 80) })) : [];
  const lessons = parseReflectionLessons(body);
  return { at: last[1], title: clip(title, 80), execSummary: exec ? exec[1] : "", execRows: rows, lessons: (lessons.length ? lessons : legacyLessons(body)).slice(0, 4).map((l) => clip(l.text, 90)) };
}

/**
 * @param {object} o
 * @param {string} o.wsRoot
 * @param {Array}  [o.tasks]      timeEngine.list()
 * @param {Array}  [o.nudges]     listMemoryNudges()
 * @param {object} [o.dream]      { eligible, observed }（skill-match 合格样本/观测）
 */
export function buildLastNight({ wsRoot, tasks = [], nudges = [], dream = {}, fsMod = fs } = {}) {
  // 2026-11-03：账本读取代 loadPromises——它已兼容「数组 / 对象（按序号键）」两种格式。
  // 旧写法只认数组，账本一旦回退成对象格式，下面所有承诺统计会静默变 0（页面看着像"没有挂账"）。
  const ledger = loadPromises(wsRoot, fsMod).filter((p) => p?.sessionId === "reflect");
  const taskId = ledger.at(-1)?.taskId || tasks.find((t) => /复盘|反思/.test(String(t.prompt || "")))?.id || null;
  const task = tasks.find((t) => t.id === taskId) || null;
  const hist = task?.history?.[0] || null;
  let log = "";
  try { log = fsMod.readFileSync(path.join(wsRoot, LOG), "utf8"); } catch {}
  const entry = taskId && log ? lastLogEntry(log, taskId) : null;

  const pending = ledger.filter((p) => p.status === "pending");
  // 2026-11-03：旧代码 p.kind || "fix" 把 kind 缺省的条目也计进 fix，修复数是虚高的。
  // 只统计真实命中的；缺省就是缺省，显示 0 比显示假数字诚实。
  const byKind = (k) => pending.filter((p) => p.kind === k).length;
  const batchAt = ledger.at(-1)?.at || null;
  const fresh = batchAt ? ledger.filter((p) => p.at === batchAt).length : 0;
  const now = Date.now();
  // 2026-11-03：阈值与 expireStalePromises 的保鲜期对齐（PROMISE_STALE_DAYS = 3 天）。
  // 原来写 7 天是死代码——pending 满 3 天就转 expired，pending 里活不到第 7 天，stale 恒为 0。
  const stale = pending.filter((p) => now - Date.parse(p.at) > PROMISE_STALE_DAYS * 86400e3).length;

  const lessonOpen = nudges.filter((n) => n.subtype === "lesson" && (n.state || "open") === "open");
  let fixTraces = 0;
  try { fixTraces = listTraces(wsRoot, { kind: "fix-attempt", limit: 500 }).length; } catch {}
  const eligible = Number(dream.eligible || 0), observed = Number(dream.observed || 0);

  return {
    ran: !!(task?.lastRun || entry),
    task: task ? { id: task.id, lastRun: task.lastRun || null, lastStart: task.lastStart || null, status: hist?.status || null, durationMs: hist?.durationMs ?? null } : null,
    entry,
    commitments: { fresh, pending: pending.length, fix: byKind("fix"), track: byKind("track"), ask: byKind("ask"), stale },
    proposals: { lesson: lessonOpen.length, lessonItems: lessonOpen.slice(0, 3).map((n) => clip(n.draft, 100)) },
    dream: {
      fixTraces,
      skillEligible: eligible,
      skillObserved: observed,
      // 饥饿要说出来，不粉饰：没核验样本，技能匹配那条回放永远在空转。
      hint: eligible ? "" : observed ? `有 ${observed} 条观测，但 0 条经人工核验，回放没法比。` : "技能匹配还没有观测样本。",
    },
  };
}
