// ===== failure-cluster.mjs —— 失败聚类（M1 切片，2026-11-03）=====
//
// 输入：统一事件流（engine/evolution 写的 events.jsonl）
// 输出：按「任务类型 + 目标 + 错误签名」聚成的短板列表，可直接喂给提案链
//
// 纪律：
//   · 只聚真实失败（rollback / red / rejected / failed / rolled_back）
//   · 签名归一化：去掉路径、数字、哈希，避免同一问题因参数不同被拆成多条
//   · 样本不足（< minCount）不输出，不做单次结论
import { readEvents } from "../evolution/index.mjs";

const FAIL = new Set(["rollback", "red", "rejected", "failed", "rolled_back", "rollback_failed"]);

/** 归一化错误签名：抽掉路径/数字/哈希，只留"哪类问题" */
export function signatureOf(ev = {}) {
  const parts = [];
  const blockers = Array.isArray(ev?.meta?.blockers) ? ev.meta.blockers : [];
  for (const b of blockers) parts.push(String(b?.message || b || ""));
  if (ev?.meta?.error) parts.push(String(ev.meta.error));
  if (!parts.length) parts.push(String(ev.verdict || ""));
  const raw = parts.join(" ").toLowerCase();
  return raw
    .replace(/[a-z]:[\\/][^\s"']+/g, "<path>")
    .replace(/\b[0-9a-f]{6,}\b/g, "<hash>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "unknown";
}

/**
 * 聚类失败。
 * @returns {{clusters:Array, scanned:number, failed:number}}
 */
export function clusterFailures(events = [], { minCount = 3, windowMs = 7 * 24 * 3600 * 1000, now = Date.now() } = {}) {
  const since = now - windowMs;
  const groups = new Map();
  let failed = 0;

  for (const ev of events) {
    const v = String(ev?.verdict || "").toLowerCase();
    if (!FAIL.has(v)) continue;
    const t = Date.parse(String(ev.at || ""));
    if (Number.isFinite(t) && t < since) continue;
    failed += 1;
    const taskType = ev.taskType || "未分类";
    const target = `${ev.target || "?"}:${ev.targetId || "?"}`;
    const sig = signatureOf(ev);
    const key = `${taskType}|${target}|${sig}`;
    const g = groups.get(key) || { key, taskType, target, targetId: ev.targetId || "", signature: sig, count: 0, samples: [], firstAt: ev.at, lastAt: ev.at };
    g.count += 1;
    if (g.samples.length < 3) g.samples.push({ at: ev.at, verdict: v, blockers: (ev?.meta?.blockers || []).slice(0, 2) });
    g.lastAt = ev.at;
    groups.set(key, g);
  }

  const clusters = [...groups.values()]
    .filter((g) => g.count >= minCount)
    .map((g) => ({
      ...g,
      // 越常发生、越近，权重越高（简单可解释，不做玄学）
      weight: Number((g.count / Math.max(1, minCount)).toFixed(2)),
      suggestion: `近 7 天「${g.taskType}」上 ${g.targetId || g.target} 同类失败 ${g.count} 次：${g.signature.slice(0, 60)}`,
    }))
    .sort((a, b) => b.count - a.count || String(b.lastAt).localeCompare(String(a.lastAt)));

  return { clusters, scanned: events.length, failed, minCount };
}

/** 把一个聚类转成进化提案的输入（交给既有 proposal 链） */
export function toProposalInput(cluster, { agentId = "xiaoyu" } = {}) {
  return {
    agentId,
    target: "skill",
    targetId: cluster.targetId || cluster.target,
    reason: cluster.suggestion,
    hypothesis: `针对「${cluster.signature.slice(0, 40)}」增加检查或改写流程，预期减少同类失败`,
    parentVersion: "current",
    candidateVersion: `candidate-${Date.now().toString(36)}`,
    datasetVersion: "sealed-v1",
    evaluatorVersion: "gate-v1",
    n: cluster.count,
    risk: cluster.count >= 5 ? "medium" : "low",
  };
}

/** 便捷：直接读事件流并聚类 */
export function clusterFromDisk(wsRoot, opts = {}) {
  const events = readEvents(wsRoot, { limit: 2000 });
  return clusterFailures(events, opts);
}
