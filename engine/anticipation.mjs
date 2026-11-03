// ===== anticipation.mjs —— 预判：这次值不值得打扰（2026-11-03）=====
//
// 公式（可解释，无玄学）：
//   期望损失 = P(会出事) × 后果严重度
//   打扰成本 = (1 − engageRate) × 注意力权重
//   出手条件 = 期望损失 > 打扰成本 × 阈值
//
// 数据来源：
//   P         ← 事件流里同类任务的历史失败率
//   严重度     ← 该类失败的平均返工分钟（经验里 cost.minutes 或按失败次数估）
//   engageRate ← 推送反应台账（没有就按 0.5 中性处理，不假装知道）
import { readEvents } from "./evolution/index.mjs";
import { reactionStats } from "./notice-reactions.mjs";

export function buildHistory(events = [], { days = 30, now = Date.now() } = {}) {
  const since = now - days * 86400000;
  const by = new Map();
  for (const e of events) {
    const t = Date.parse(String(e.at || ""));
    if (Number.isFinite(t) && t < since) continue;
    const kind = e.taskType || "未分类";
    const row = by.get(kind) || { taskType: kind, total: 0, bad: 0, reworkMinutes: 0 };
    row.total += 1;
    const v = String(e.verdict || "").toLowerCase();
    if (["rollback", "red", "rejected", "failed", "rolled_back"].includes(v)) { row.bad += 1; row.reworkMinutes += 15 }
    by.set(kind, row);
  }
  return [...by.values()].map((r) => ({
    ...r,
    badRate: r.total ? Number((r.bad / r.total).toFixed(3)) : 0,
    avgRework: r.bad ? Number((r.reworkMinutes / r.bad).toFixed(0)) : 0,
  }));
}

/**
 * 判断一批候选介入点该不该出手。
 * @param {{candidates:Array<{id:string, taskType:string, kind?:string, severityMinutes?:number}>, history:Array, engageRate?:number, threshold?:number, attentionWeight?:number}} opts
 */
export function estimateAction({ candidates = [], history = [], engageRate = 0.5, threshold = 2, attentionWeight = 1 } = {}) {
  const cost = Math.max(0.1, Number((1 - engageRate).toFixed(3))) * attentionWeight;
  const hmap = new Map((history || []).map((h) => [h.taskType, h]));
  return (candidates || []).map((c) => {
    const h = hmap.get(c.taskType || "未分类");
    const p = h?.badRate ?? 0;
    const severity = Number(c.severityMinutes) || h?.avgRework || 0;
    const expectedLoss = Number((p * severity).toFixed(2));
    const shouldAct = severity > 0 && expectedLoss > cost * threshold;
    return {
      id: c.id,
      taskType: c.taskType || "未分类",
      p,
      severity,
      expectedLoss,
      cost: Number(cost.toFixed(2)),
      shouldAct,
      reason: shouldAct
        ? `同类失败率 ${(p * 100).toFixed(0)}% × 返工 ${severity} 分钟 = ${expectedLoss}，大于打扰成本 ${cost.toFixed(2)}×${threshold}`
        : `期望损失 ${expectedLoss} 不足以抵消打扰成本（${cost.toFixed(2)}×${threshold}），不动`,
    };
  }).sort((a, b) => b.expectedLoss - a.expectedLoss);
}

/** 离线回放：如果当时出手，能抓到多少真事故、误报多少次。 */
export function replay(events = [], { days = 30, now = Date.now(), engageRate = 0.5, threshold = 2 } = {}) {
  const history = buildHistory(events, { days, now });
  const since = now - days * 86400000;
  const inWindow = events.filter((e) => {
    const t = Date.parse(String(e.at || ""));
    return !Number.isFinite(t) || t >= since;
  });
  // 把每次失败当成"本该预判到"的点，看模型会不会出手
  const bads = inWindow.filter((e) => ["rollback", "red", "rejected", "failed", "rolled_back"].includes(String(e.verdict || "").toLowerCase()));
  const candidates = bads.map((e, i) => ({ id: `ev${i}`, taskType: e.taskType || "未分类" }));
  const scored = estimateAction({ candidates, history, engageRate, threshold });
  const caught = scored.filter((s) => s.shouldAct).length;
  const total = inWindow.filter((e) => ["task", "compare", "gate", "observation"].includes(e.kind)).length;
  return {
    windowDays: days,
    events: total,
    badEvents: bads.length,
    wouldAct: caught,
    missed: bads.length - caught,
    fireRate: total ? Number((caught / total).toFixed(3)) : 0,
    history,
  };
}

/** 便捷：直接读盘回放。 */
export function replayFromDisk(wsRoot, opts = {}) {
  const events = readEvents(wsRoot, { limit: 2000 });
  let engageRate = 0.5;
  try {
    const st = reactionStats(wsRoot, { days: opts.days || 30 });
    const tot = st.reduce((a, x) => a + x.sent, 0);
    const eng = st.reduce((a, x) => a + x.opened + x.replied, 0);
    if (tot >= 5) engageRate = Number((eng / tot).toFixed(2));
  } catch {}
  return replay(events, { ...opts, engageRate });
}
