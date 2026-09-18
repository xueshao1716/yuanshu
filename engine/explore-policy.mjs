// engine/explore-policy.mjs —— "该怎么探索"的运行时旋钮（2026-09-18）
//
// 为什么需要它：轨迹与回放器建好了，但**没有消费者**——回放出来的"更省成本的策略"改了也没用，
// 因为运行时没有哪个开关听它的。这类"上线了但没人用"的假动作，比不做更糟：它会让人以为进化在发生。
//
// 所以这里只做一件事：把探索策略做成**真的被读的配置**，并给它一个真实的执行点——
// 当场修失败之后要不要再试、再试几次。于是闭环成立：
//   旋钮(policy) → 真执行(执行轮重试) → 每个尝试落成轨迹节点 → 回放比较 → 做梦 → A/B 级自决改旋钮
//
// 存储：工作区 记忆/做梦/现役探索策略.json。代码里的默认值永远是出厂默认，
// "退回"只改这份存档，源码不会被改脏（与技能权重同一个规矩）。
import fs from "node:fs";
import path from "node:path";
import { atomicWriteText } from "./atomic-io.mjs";

export const DEFAULT_EXPLORE_POLICY = Object.freeze({
  id: "recorded",
  retryOnFailure: 1,        // 一次执行轮失败后，再给几次机会（0 = 不重试）
  order: "recorded",
  stopAfterFailures: 0,     // 0 = 不因连败提前收手
});

export function explorePolicyPath(wsRoot) {
  return path.join(wsRoot, "记忆", "做梦", "现役探索策略.json");
}

export function currentExplorePolicy(wsRoot, fsMod = fs) {
  try {
    const j = JSON.parse(fsMod.readFileSync(explorePolicyPath(wsRoot), "utf8"));
    if (j && typeof j === "object") return { ...DEFAULT_EXPLORE_POLICY, ...j };
  } catch { /* 没有存档 = 出厂默认 */ }
  return { ...DEFAULT_EXPLORE_POLICY };
}

export function promoteExplorePolicy(wsRoot, id, policy = {}, { now = new Date(), fsMod = fs } = {}) {
  try {
    const merged = { ...DEFAULT_EXPLORE_POLICY, ...policy, id: String(id || "custom") };
    fsMod.mkdirSync(path.dirname(explorePolicyPath(wsRoot)), { recursive: true });
    atomicWriteText(explorePolicyPath(wsRoot), JSON.stringify({ ...merged, at: new Date(now).toISOString() }, null, 2));
    return { ok: true, id: merged.id, policy: merged };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) } }
}

export function resetExplorePolicy(wsRoot, { fsMod = fs } = {}) {
  try { fsMod.unlinkSync(explorePolicyPath(wsRoot)); } catch { /* 本来就没有 */ }
  return { ok: true, id: DEFAULT_EXPLORE_POLICY.id, policy: { ...DEFAULT_EXPLORE_POLICY } };
}

/** 候选策略：现役 + 几个"少试/多试"的替代做法。回放时现役必须在内（赢家不可能更差）。 */
export function exploreCandidates() {
  return [
    { id: "no-retry", retryOnFailure: 0 },
    { id: "retry-1", retryOnFailure: 1 },
    { id: "retry-2", retryOnFailure: 2 },
    { id: "retry-3", retryOnFailure: 3 },
  ];
}

/**
 * 跨轨迹比较探索策略：与做梦同一套规矩 —— 现役在候选里，
 * **只有"每条轨迹都不更差（分数不更低、成本不更高）、且至少一条更好"才算赢**。
 */
export function replayExploreAcross(traces, { incumbentId = "recorded", candidates = exploreCandidates(), incumbent } = {}) {
  const list = (Array.isArray(traces) ? traces : []).filter((t) => t?.nodes?.length);
  if (!list.length) return { ok: false, reason: "没有可用轨迹（先积累记录）", traces: 0 };
  const all = [incumbentId, ...candidates.map((c) => c.id)].filter((v, i, a) => a.indexOf(v) === i);
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const table = all.map((id) => {
    const policy = id === incumbentId ? { id, ...(incumbent || {}) } : (byId.get(id) || { id });
    const rows = list.map((t) => replayExplore(t, policy));
    return {
      id,
      score: Number(rows.reduce((s, r) => s + r.score, 0).toFixed(3)),
      cost: Number(rows.reduce((s, r) => s + r.cost, 0).toFixed(3)),
      attempts: rows.reduce((s, r) => s + r.attempts, 0),
      rows,
    };
  });
  const inc = table.find((t) => t.id === incumbentId);
  const scored = table.map((t) => {
    if (t.id === incumbentId) return { ...t, role: "incumbent", decision: "keep" };
    const worse = t.rows.filter((r, i) => r.score < inc.rows[i].score || r.cost > inc.rows[i].cost).length;
    const better = t.rows.filter((r, i) => r.score >= inc.rows[i].score && r.cost < inc.rows[i].cost).length;
    return {
      ...t, role: "challenger", worse, better,
      decision: worse === 0 && better > 0 ? "promote" : worse === 0 ? "tie" : "reject",
      reason: worse === 0 ? (better > 0 ? `每条轨迹都不更差，其中 ${better} 条更省成本` : "与现役打平") : `有 ${worse} 条丢了成绩或花了更多成本`,
    };
  });
  const winners = scored.filter((s) => s.decision === "promote").sort((a, b) => a.cost - b.cost || b.score - a.score);
  const winner = winners[0] || null;
  return {
    ok: true, traces: list.length, table: scored, winner: winner?.id || null,
    proposal: winner ? { kind: "config", text: `探索策略从「${incumbentId}」换成「${winner.id}」（${list.length} 条轨迹回放：都不更差、${winner.better} 条更省）` } : null,
  };
}

/**
 * 在**轨迹**上回放"重试几次"这类策略。
 * 口径：每条轨迹看成一次"修一个问题"的过程，节点按发生顺序；
 *   成功 → 拿到 1 分并停；失败 → 记一次成本，够 retryOnFailure+1 次就收手。
 * 返回每棵树的 {score, cost, attempts}，跨树比较由调用方做（与 dream 同一套"都不更差"规矩）。
 */
export function replayExplore(trace, policy = {}) {
  const retry = Math.max(0, Number(policy.retryOnFailure ?? DEFAULT_EXPLORE_POLICY.retryOnFailure));
  const nodes = Array.isArray(trace?.nodes) ? trace.nodes : [];
  let cost = 0, attempts = 0, score = 0;
  for (const n of nodes) {
    if (attempts >= retry + 1) break;
    attempts++;
    cost += Number(n.cost) || 0;
    if (Number(n.score) > 0) { score = 1; break }
  }
  return { traceId: trace?.id || "", policyId: policy.id || `retry-${retry}`, score, cost: Number(cost.toFixed(3)), attempts };
}
