// engine/trace.mjs —— 探索轨迹：把"试了哪些路、花了多少、结果如何"记成树
// （2026-09-18，用户："你继续做"——上一版做梦只能回放"选哪个技能"，因为探索过程没有结构化轨迹）
//
// ── 为什么要树，不要日志 ────────────────────────────────────────────────
// Dream-RSI 能"做梦"的前提是历史里有**发现树**：每个节点是一次尝试，带着它真实的执行结果与成本。
// 有了这棵树，换一个探索策略（先试哪条、并行几条、试几次就放弃）不用重跑，在旧树上重走即可。
// 纯文本日志做不到这件事——它能读，不能回放。所以这里要的是**结构化**：
//   node = { id, parent, action, input, cost, outcome, score, at }
//
// ── 记什么（元枢今天真实存在的探索）──────────────────────────────────────
//   kind='fix-attempt'     当场修：一次"尝试→验证"就是一条链
//   kind='reflect-action'  复盘行动：一条行动的执行尝试与结局
//   kind='skill-match'     （已有）选技能
// 以后接子智能体/分镜重跑时，用同一个 addNode 就行——形状不变，回放器不用改。
//
// ── 回放什么（这一版能算的）──────────────────────────────────────────────
// `replayTrace(trace, policy)`：策略 = { order: 'recorded'|'dfs'|'bfs', maxAttempts, stopAfterFailures }。
// 在**已记录的结果**上重走：算出"如果当时最多试 k 次就停、或换个展开顺序，会花多少成本、拿到什么最好分"。
// 边界写清楚：只能算"结果已记录"的那些节点——没走过的分支算不出来，也不会瞎猜（那正是做梦的边界）。
import fs from "node:fs";
import path from "node:path";
import { atomicWriteText } from "./atomic-io.mjs";

const DIR = () => ["记忆", "做梦", "轨迹"];
export const MAX_TRACES = 300;

export function traceDir(wsRoot) {
  return path.join(wsRoot, ...DIR());
}
export function tracePath(wsRoot, id) {
  return path.join(traceDir(wsRoot), `${id}.json`);
}

const safeId = (id) => String(id || "").replace(/[^\w.-]/g, "_").slice(0, 80);

export function openTrace(wsRoot, { kind, goal = "", id = "", now = new Date(), fsMod = fs } = {}) {
  const tid = safeId(id) || `${kind || "trace"}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const trace = { id: tid, kind: kind || "generic", goal: String(goal).slice(0, 300), at: new Date(now).toISOString(), nodes: [], closed: null };
  try {
    fsMod.mkdirSync(traceDir(wsRoot), { recursive: true });
    atomicWriteText(tracePath(wsRoot, tid), JSON.stringify(trace, null, 2));
    return { ok: true, trace };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) } }
}

export function loadTrace(wsRoot, id, fsMod = fs) {
  try { return JSON.parse(fsMod.readFileSync(tracePath(wsRoot, safeId(id)), "utf8")); } catch { return null }
}

export function listTraces(wsRoot, { kind = "", limit = 50, fsMod = fs } = {}) {
  let files = [];
  try { files = fsMod.readdirSync(traceDir(wsRoot)).filter((f) => f.endsWith(".json")); } catch { return [] }
  const out = [];
  for (const f of files) {
    const t = loadTrace(wsRoot, f.replace(/\.json$/, ""), fsMod);
    if (!t?.id) continue;
    if (kind && t.kind !== kind) continue;
    out.push({ id: t.id, kind: t.kind, goal: t.goal, at: t.at, nodes: t.nodes?.length || 0, closed: t.closed });
  }
  out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return limit > 0 ? out.slice(0, limit) : out;
}

/** 加一个节点。`parent` 为空即根；cost 用秒或"回合数"都行（同一棵树里口径要一致）。 */
export function addNode(wsRoot, id, node, { now = new Date(), fsMod = fs } = {}) {
  const t = loadTrace(wsRoot, id, fsMod);
  if (!t) return { ok: false, error: "轨迹不存在" };
  const n = {
    id: `n${(t.nodes?.length || 0) + 1}`,
    parent: node?.parent || null,
    action: String(node?.action || "").slice(0, 200),
    input: String(node?.input || "").slice(0, 500),
    cost: Number(node?.cost) || 0,
    outcome: String(node?.outcome || "unknown"),
    score: node?.score === undefined || node?.score === null ? null : Number(node.score),
    at: new Date(now).toISOString(),
  };
  t.nodes = [...(t.nodes || []), n];
  try {
    atomicWriteText(tracePath(wsRoot, t.id), JSON.stringify(t, null, 2));
    return { ok: true, node: n, trace: t };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) } }
}

export function closeTrace(wsRoot, id, { result = "", score = null, cost = null, now = new Date(), fsMod = fs } = {}) {
  const t = loadTrace(wsRoot, id, fsMod);
  if (!t) return { ok: false, error: "轨迹不存在" };
  t.closed = { at: new Date(now).toISOString(), result: String(result).slice(0, 300), score: score === null ? null : Number(score), cost: cost === null ? null : Number(cost) };
  try { atomicWriteText(tracePath(wsRoot, t.id), JSON.stringify(t, null, 2)); return { ok: true, trace: t }; }
  catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) } }
}

// ── 回放 ────────────────────────────────────────────────────────────────

/** 一次尝试是否算"成功"：outcome 认 ok/success/done/kept/true；分数有值且 >0 也算。 */
export function nodeSucceeded(n) {
  if (typeof n?.score === "number") return n.score > 0;
  return /^(ok|success|done|kept|true|pass)$/i.test(String(n?.outcome || ""));
}

/** 记录的展开顺序（节点是按发生顺序落的，父指针只是个标记）。 */
function recordedOrder(trace) {
  return [...(trace?.nodes || [])];
}

function orderNodes(trace, order) {
  const nodes = recordedOrder(trace);
  if (order === "bfs") {
    const byDepth = new Map();
    const depth = (n) => { let d = 0, cur = n; const seen = new Set(); while (cur?.parent && !seen.has(cur.parent)) { seen.add(cur.parent); cur = nodes.find((x) => x.id === cur.parent); d++ } return d };
    for (const n of nodes) { const d = depth(n); byDepth.set(d, [...(byDepth.get(d) || []), n]) }
    return [...byDepth.keys()].sort((a, b) => a - b).flatMap((d) => byDepth.get(d));
  }
  if (order === "dfs") {
    const kids = (id) => nodes.filter((n) => (n.parent || null) === id);
    const out = [];
    const walk = (id) => { for (const k of kids(id)) { out.push(k); walk(k.id) } };
    walk(null);
    return out.length ? out : nodes;
  }
  return nodes;   // recorded
}

/**
 * 在**已记录的结果**上回放一个策略。
 * policy = { order: 'recorded'|'dfs'|'bfs', maxAttempts, stopAfterFailures }
 * 返回：跑了几个节点、总成本、最好成绩、何时停下。
 * 再强调一次边界：只能算历史真走过的节点；没走过的分支这里**不算**（做梦的边界就在这）。
 */
export function replayTrace(trace, policy = {}) {
  const order = policy.order || "recorded";
  const nodes = orderNodes(trace, order);
  const maxAttempts = Number(policy.maxAttempts) > 0 ? Number(policy.maxAttempts) : Infinity;
  const stopAfter = Number(policy.stopAfterFailures) > 0 ? Number(policy.stopAfterFailures) : Infinity;

  let cost = 0, best = null, fails = 0, used = 0, stopped = null;
  for (const n of nodes) {
    if (used >= maxAttempts) { stopped = "maxAttempts"; break }
    cost += Number(n.cost) || 0;
    used++;
    if (nodeSucceeded(n)) {
      const s = typeof n.score === "number" ? n.score : 1;
      best = best === null ? s : Math.max(best, s);
      fails = 0;                                  // 成功一次就重置连败计数
    } else {
      fails++;
      if (fails >= stopAfter) { stopped = "stopAfterFailures"; break }
    }
  }
  return { policyId: policy.id || `${order}/max${policy.maxAttempts ?? "∞"}/stop${policy.stopAfterFailures ?? "∞"}`, nodes: used, cost: Number(cost.toFixed(3)), best, stopped };
}

/**
 * 记一次**派活**（delegate_task / delegate_fork / 分镜重跑这类"多路探索"）。
 *
 * 当场修那条链是单线的（试一次→验证）；真正有"分支"的是派活：一次派几个子任务、
 * 哪个失败了、花了多久。这些正是"该怎么探索"要回放的对象，所以形状还是同一棵树：
 * 一次派活 = 一个节点，cost = 秒，outcome = ok/error，score = 结果摘要长度（有产出才好过空手）。
 */
export function recordDelegation(wsRoot, { kind = "delegate", task = "", durationMs = 0, ok = false, digest = "", now = new Date(), fsMod = fs } = {}) {
  const opened = openTrace(wsRoot, { kind, goal: String(task).slice(0, 300) || "(未写任务)", now, fsMod });
  if (!opened?.ok) return opened;
  const cost = Number((Number(durationMs) / 1000).toFixed(2));
  const node = addNode(wsRoot, opened.trace.id, {
    action: kind,
    input: String(task).slice(0, 500),
    cost,
    outcome: ok ? "ok" : "error",
    score: ok ? Math.min(1, String(digest).length / 400) : 0,
  }, { now, fsMod });
  closeTrace(wsRoot, opened.trace.id, { result: String(digest).slice(0, 200), score: node?.node?.score ?? 0, cost, now, fsMod });
  return { ok: true, id: opened.trace.id, cost };
}

/** 常用策略集：把"当时的做法"和几个替代做法放在一起比（现役必须在候选里）。 */
export function candidatePolicies(extra = []) {
  return [
    { id: "recorded", order: "recorded" },                     // 当时真这么做的
    { id: "stop-after-1-fail", order: "recorded", stopAfterFailures: 1 },
    { id: "stop-after-2-fail", order: "recorded", stopAfterFailures: 2 },
    { id: "max-3-attempts", order: "recorded", maxAttempts: 3 },
    { id: "breadth-first", order: "bfs" },
    ...extra,
  ];
}

/**
 * 做梦（探索策略版）：在**多棵**轨迹上回放候选策略。
 * 规矩与技能那版一致：现役在候选里；只有"每棵树都不更差（不丢最好成绩、成本不更高）、
 * 且至少一棵更好"才算赢。
 */
export function replayAcrossTraces(traces, policies = candidatePolicies(), { incumbentId = "recorded" } = {}) {
  const list = (Array.isArray(traces) ? traces : []).filter((t) => t?.nodes?.length);
  if (!list.length) return { ok: false, reason: "没有可用轨迹（先积累记录，别急着做梦）", traces: 0 };
  const all = [incumbentId, ...policies.map((p) => p.id)].filter((v, i, a) => v && a.indexOf(v) === i);
  const byId = new Map(policies.map((p) => [p.id, p]));
  const table = all.map((id) => {
    const policy = byId.get(id) || { id, order: "recorded" };
    const rows = list.map((t) => replayTrace(t, policy));
    return {
      id,
      cost: Number(rows.reduce((s, r) => s + r.cost, 0).toFixed(3)),
      bestSum: Number(rows.reduce((s, r) => s + (r.best || 0), 0).toFixed(3)),
      rows,
    };
  });
  const inc = table.find((t) => t.id === incumbentId);
  const scored = table.map((t) => {
    if (t.id === incumbentId) return { ...t, role: "incumbent", decision: "keep" };
    const worse = t.rows.filter((r, i) => (r.best || 0) < (inc.rows[i].best || 0) || r.cost > inc.rows[i].cost).length;
    const better = t.rows.filter((r, i) => (r.best || 0) >= (inc.rows[i].best || 0) && r.cost < inc.rows[i].cost).length;
    return {
      ...t, role: "challenger", worse, better,
      decision: worse === 0 && better > 0 ? "promote" : worse === 0 ? "tie" : "reject",
      reason: worse === 0
        ? (better > 0 ? `每条轨迹都不更差，其中 ${better} 条更省成本` : "与现役打平")
        : `有 ${worse} 条丢了成绩或花了更多成本`,
    };
  });
  // 赢家按"省得最多"排，而不是按候选表的书写顺序——否则候选顺序就成了事实上的决策者。
  const winners = scored.filter((s) => s.decision === "promote")
    .sort((a, b) => (a.cost - b.cost) || (b.bestSum - a.bestSum));
  const winner = winners[0] || null;
  return {
    ok: true, traces: list.length, table: scored, winner: winner?.id || null,
    proposal: winner ? { kind: "config", text: `探索策略从「${incumbentId}」换成「${winner.id}」（${list.length} 棵轨迹回放：都不更差、${winner.better} 条更省）` } : null,
  };
}
