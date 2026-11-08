// ===== knowledge-backlog.mjs —— 卡死的积压要有出口（2026-10-26）=====
//
// 真机：blocked 24 条最老等 433 小时（18 天）、review_required 19 条最老 446 小时。
// 它们不在队列里排队，速率再快也不会动——因为它们卡在"等人"或"等策略"。
//
// 处理原则（不假装能自动解决所有问题）：
//   · blocked 的原因如果是"够不着/没钱/外网不通"这类**环境性**问题 → 重排一次（可能环境已经好了）
//   · blocked 超过 7 天仍失败 → skip，并写清原因（占着队列才是真损失）
//   · review_required 超过 7 天没人看 → skip（宁可少一条，也不要一条"待审"挂半个月）
//   · 其它 → 原样保留，报出来让人看
import fs from "node:fs";
import path from "node:path";

export const STALE_MS = 7 * 86400 * 1000;
const RETRYABLE = /budget|quota|network|fetch|timeout|unavailable|rate/i;

/** 单条积压怎么处理（纯函数）。 */
export function classifyJob(job = {}, { now = Date.now(), staleMs = STALE_MS } = {}) {
  const age = now - (Number(job.createdAt) || now);
  const stale = age > staleMs;
  if (job.state === "blocked") {
    const retryable = RETRYABLE.test(String(job.reason || ""));
    if (stale) return { action: "skip", reason: "blocked_stale", note: `卡了 ${Math.round(age / 86400000)} 天：${job.reason || "无原因"}` };
    if (retryable) return { action: "requeue", reason: "blocked_retry", note: `环境性失败，重排一次：${job.reason}` };
    return { action: "keep", reason: "blocked_other", note: `需人看：${job.reason || "无原因"}` };
  }
  if (job.state === "review_required") {
    if (stale) return { action: "skip", reason: "review_stale", note: `待审 ${Math.round(age / 86400000)} 天没人看，标过期` };
    return { action: "keep", reason: "review_waiting", note: "还在等复核窗口内" };
  }
  return { action: "keep", reason: "other", note: "" };
}

/** 扫一遍积压，给出计划；apply=true 才真的改状态。 */
export function drainBacklog({ wsRoot, apply = false, now = Date.now(), staleMs = STALE_MS } = {}) {
  const file = path.join(String(wsRoot || "."), "记忆", "知识", "state.json");
  let data;
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { ok: false, error: "state_unreadable" }; }
  const jobs = data.jobs && typeof data.jobs === "object" ? data.jobs : {};
  const plan = [];
  for (const [id, job] of Object.entries(jobs)) {
    if (!["blocked", "review_required"].includes(job.state)) continue;
    const v = classifyJob(job, { now, staleMs });
    plan.push({ id, state: job.state, ...v });
  }
  const counts = plan.reduce((a, p) => { a[p.action] = (a[p.action] || 0) + 1; return a; }, {});

  if (apply) {
    for (const p of plan) {
      const job = jobs[p.id];
      if (!job) continue;
      if (p.action === "skip") {
        Object.assign(job, { state: "skipped", stage: job.stage, reason: p.reason, lease: null, updatedAt: now, revision: (job.revision || 0) + 1 });
      } else if (p.action === "requeue") {
        Object.assign(job, { state: "queued", stage: "collecting", reason: p.reason, lease: null, attempts: (job.attempts || 0) + 1, updatedAt: now, revision: (job.revision || 0) + 1 });
      }
    }
    fs.writeFileSync(file, JSON.stringify(data), "utf8");
  }
  return { ok: true, applied: apply, total: plan.length, counts, plan: plan.slice(0, 20) };
}
