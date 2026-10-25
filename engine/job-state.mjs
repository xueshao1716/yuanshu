// ===== job-state.mjs —— 后台作业的状态机（2026-10-25）=====
//
// 要解决的问题（用户原话）："说的好好的，我先忙，她做完汇报，结果没有汇报"。
// 也就是：活派出去以后，**没有人在盯着它结束**——
//   · 脱链长任务（run_detached）跑完了，没人记得回来汇报；
//   · 会话 run 失败了，只写进日志，没人主动说"这一步坏了"；
//   · 定时任务跑完/跑挂，也没人汇总。
//
// 这里做三件事：
//   1. 把三类来源（脱链作业 / 会话 run / 定时任务）收成统一的状态机：
//        queued → running → (done | failed | stalled)
//      `stalled` = 还在 running 但超过阈值没有任何新事件（这是"卡住了"和"慢"的分界）；
//   2. 每次状态变化记一笔"待汇报"（记忆/运行时/待汇报.json），只有模型明确 ack 才算报过；
//   3. 下一轮开始把"有 N 条做完没汇报"注入环境事实，并把 job_status 工具交给它自己查细节。
//
// 设计上刻意**不**猜"她会不会记得"——只回答"有没有做完、坏在哪一步、有没有汇报过"。
import fs from "node:fs";
import path from "node:path";

export const REPORT_FILE = path.join("记忆", "运行时", "待汇报.json");
/** 超过这么久没有新事件，就算"卡住"而不是"还在跑"。 */
export const STALL_MS = Number(process.env.YUANSHU_JOB_STALL_MS) || 10 * 60 * 1000;
/**
 * 只关心这个时间窗内的作业（默认 24 小时）。
 * 2026-10-25 真机教训：不设窗口时把历史上 300 多个作业全算进来，
 * 一开轮就是"有 200 条未汇报"——那不是提醒，是淹人。
 */
export const REPORT_WINDOW_MS = Number(process.env.YUANSHU_JOB_WINDOW_MS) || 24 * 60 * 60 * 1000;
/** 台账最多留这么多条未汇报（再多也不往提示词里塞）。 */
const MAX_PENDING = 20;
/** 台账只留最近这么多条。 */
const MAX_REPORTS = 200;

function reportPath(wsRoot) { return path.join(String(wsRoot || "."), REPORT_FILE); }

export function readReports(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(reportPath(wsRoot), "utf8"));
    return Array.isArray(raw?.items) ? raw.items : [];
  } catch { return []; }
}

function writeReports(wsRoot, items) {
  const file = reportPath(wsRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ items: items.slice(-MAX_REPORTS) }, null, 2), "utf8");
}

/**
 * 记一条"该汇报了"。同一个 id 重复调用只更新末端状态，不刷屏。
 * @returns {boolean} 是否新建
 */
export function enqueueReport(wsRoot, { id, kind, label, state, step, at = Date.now() }) {
  if (!id) return false;
  const items = readReports(wsRoot);
  const hit = items.find((x) => x.id === id && !x.ackedAt);
  if (hit) {
    hit.state = state || hit.state;
    hit.step = step || hit.step;
    hit.updatedAt = at;
    writeReports(wsRoot, items);
    return false;
  }
  items.push({ id, kind: kind || "job", label: label || id, state: state || "done", step: step || "", at, updatedAt: at, ackedAt: null });
  writeReports(wsRoot, items);
  return true;
}

/** 模型汇报过了：ack 掉（汇报内容写进 note 备查）。 */
export function ackReports(wsRoot, ids, { note = "", at = Date.now() } = {}) {
  const wanted = new Set(Array.isArray(ids) ? ids : [ids].filter(Boolean));
  const items = readReports(wsRoot);
  let n = 0;
  for (const it of items) {
    if (!wanted.has(it.id) || it.ackedAt) continue;
    it.ackedAt = at;
    it.note = String(note || "").slice(0, 300);
    n += 1;
  }
  writeReports(wsRoot, items);
  return { ok: true, acked: n };
}

/** 还没汇报的（按时间正序，最老的先报；只取时间窗内的）。 */
export function pendingReports(wsRoot, { now = Date.now(), windowMs = REPORT_WINDOW_MS } = {}) {
  return readReports(wsRoot)
    .filter((x) => !x.ackedAt)
    .filter((x) => now - (Number(x.updatedAt) || 0) <= windowMs)
    .slice(-MAX_PENDING);
}

/** 给环境事实用的一句话；没有待汇报就返回空串（不占提示词）。 */export function pendingReportsLine(wsRoot, { limit = 5, now = Date.now() } = {}) {
  const pend = pendingReports(wsRoot, { now });
  if (!pend.length) return "";
  const head = pend.slice(0, limit).map((x) => `${x.label}（${x.state === "failed" ? "失败" : "完成"}${x.step ? ` · ${x.step}` : ""}）`).join("；");
  return `【未汇报】有 ${pend.length} 个后台作业已经跑完/跑挂了，你还没告诉${"对方"}：${head}。这一轮开头先用一两句话交代结果；细节用 job_status 查，报完记得 ack。`;
}

/**
 * 「汇报完自动 ack」（2026-10-25）：靠**她说出来的话**判断报没报，而不是靠她自己记得调工具。
 *
 * 判定刻意保守：只有回复里**出现了这个作业的名字**（标签整体，或标签里 ≥4 字的片段）才 ack。
 * 因为"提醒了一句就全 ack"会把没报的也当成报过——那比不提醒更糟（以后再也不提醒了）。
 * @returns {{acked:string[], skipped:string[]}}
 */
export function autoAckByText(wsRoot, text, { now = Date.now() } = {}) {
  const said = String(text || "").replace(/\s+/g, " ").trim();
  if (said.length < 12) return { acked: [], skipped: [] };   // 太短（"好的"）不算汇报
  const pend = pendingReports(wsRoot, { now });
  const acked = [];
  const skipped = [];
  for (const it of pend) {
    const label = String(it.label || "").trim();
    if (!label) { skipped.push(it.id); continue; }
    const hit = said.includes(label)
      || (label.length >= 8 && said.includes(label.slice(0, Math.max(8, Math.floor(label.length * 0.6)))))
      || (it.step && it.step.length >= 4 && said.includes(it.step) && label.length >= 6);
    if (hit) acked.push(it.id); else skipped.push(it.id);
  }
  if (acked.length) ackReports(wsRoot, acked, { note: "回复里提到了该作业，自动标记已汇报", at: now });
  return { acked, skipped };
}

/**
 * 把三类来源统一成作业条目。
 * @param {{wsRoot:string, detached?:object[], runs?:object[], tasks?:object[], now?:number}} input
 */
export function collectJobs({ wsRoot, detached = [], runs = [], tasks = [], now = Date.now() } = {}) {
  const jobs = [];

  for (const d of detached || []) {
    if (!d?.id) continue;
    const startedAt = Number(d.startedAt) || null;
    const updatedAt = Number(d.updatedAt) || (startedAt ? startedAt + (Number(d.elapsedMs) || 0) : null);
    const state = d.done ? (Number(d.exitCode) === 0 ? "done" : "failed")
      : d.alive ? (updatedAt && now - updatedAt > STALL_MS ? "stalled" : "running")
      : "failed";
    jobs.push({
      id: d.id, kind: "detached", label: d.label || d.id, state,
      step: d.done ? `退出码 ${d.exitCode}` : d.alive ? "进程在跑" : "进程没了但没写完成标记",
      startedAt, updatedAt, elapsedMs: Number(d.elapsedMs) || 0,
      error: state === "failed" ? (d.done ? `exit ${d.exitCode}` : "异常退出") : "",
    });
  }

  for (const r of runs || []) {
    if (!r?.id) continue;
    const status = String(r.status || r.state || "").toLowerCase();
    const terminal = ["completed", "failed", "stopped", "interrupted", "done"].includes(status);
    const startedAt = Number(r.startedAt) || null;
    const updatedAt = Number(r.updatedAt || r.endedAt || r.startedAt) || null;
    const elapsedMs = startedAt ? now - startedAt : (Number(r.totalMs) || 0);
    // 2026-10-25：run 记录里绝大多数是**普通对话轮**，不是后台作业。
    // 全算进来会得到"303 个作业、200 条未汇报"这种噪声。只保留真的算"后台活"的：
    // 明确标了 background，或者单轮跑过 2 分钟（那种才是"我先忙，等它跑完"）。
    const looksBackground = r.background === true || r.kind === "task" || r.kind === "team" || !!r.workflow;
    if (!looksBackground && elapsedMs < 120000) continue;
    const state = status === "completed" || status === "done" ? "done"
      : ["failed", "interrupted", "stopped"].includes(status) ? "failed"
      : terminal ? "done"
      : (updatedAt && now - updatedAt > STALL_MS ? "stalled" : "running");
    jobs.push({
      id: r.id, kind: "run",
      // 标签优先用用户能认出来的话（title/goal/messagePreview），别拿 session UUID 糊人
      label: String(r.title || r.goal || r.messagePreview || r.label || r.id).slice(0, 60),
      state,
      step: String(r.stage || r.phase || r.lastStep || status || "").slice(0, 60),
      startedAt, updatedAt, elapsedMs,
      error: state === "failed" ? String(r.error || status || "").slice(0, 120) : "",
    });
  }

  for (const t of tasks || []) {
    if (!t?.id) continue;
    const h = Array.isArray(t.history) && t.history.length ? t.history[t.history.length - 1] : null;
    if (!h) continue;   // 从没跑过的不算作业
    const lastAt = Number(h.startedAt) || null;
    const dur = Number(h.durationMs) || 0;
    const ok = String(h.status || "").toLowerCase();
    const failed = /fail|error/.test(ok);
    const state = lastAt && !dur && now - lastAt > STALL_MS ? "stalled" : failed ? "failed" : "done";
    jobs.push({
      id: `task:${t.id}`, kind: "task", label: String(t.label || t.prompt || t.id).slice(0, 60), state,
      step: ok ? `定时任务 ${ok}` : "最近一次运行",
      startedAt: lastAt, updatedAt: lastAt ? lastAt + dur : lastAt, elapsedMs: dur,
      error: failed ? String(h.error || ok).slice(0, 120) : "",
    });
  }

  jobs.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return jobs;
}

/** 一句话总览（给工具输出开头用）。 */
export function summarizeJobs(jobs = []) {
  const count = (s) => jobs.filter((j) => j.state === s).length;
  return { done: count("done"), failed: count("failed"), running: count("running"), stalled: count("stalled"), total: jobs.length };
}

/** 把"需要汇报"的作业写进台账（done/failed 且未报过，且只记时间窗内的）。 */
export function syncReports(wsRoot, jobs = [], { now = Date.now(), windowMs = REPORT_WINDOW_MS } = {}) {
  const known = new Set(readReports(wsRoot).map((x) => x.id));
  const added = [];
  for (const j of jobs) {
    if (known.has(j.id)) continue;
    if (j.state !== "done" && j.state !== "failed") continue;
    // 老账不记：昨天以前跑完的作业没有"现在汇报"的价值
    if (j.updatedAt && now - j.updatedAt > windowMs) continue;
    if (enqueueReport(wsRoot, { id: j.id, kind: j.kind, label: j.label, state: j.state, step: j.step || j.error, at: j.updatedAt || now })) added.push(j.id);
  }
  return added;
}
