// ===== goals.mjs —— 跨轮目标的持久化 + 三重闸门（借 dsh-goal-round-driver）=====
//
// 元枢原先没有"目标跨轮推进"这个概念：任务看板是给人看的，时间引擎是按点触发的，
// 都不是"一个目标自己往下走"。dsh 的实现（dsh-goal / -round-driver / -tool-goal）
// 值得借的不是"自动跑"，而是它围绕自动跑立的三重闸门——那三条才是让这个能力
// 不变成烧钱自转的东西，所以这里一条不落全搬：
//
//   闸门① 回合上限：`round >= maxRounds` 自动转 blocked（dsh 默认 256，元枢取小值，
//          见下）。到顶了就停，不会"再来一轮"。
//   闸门② 单轮预约：一轮只驱动一次，且预约要核对 goalId + revision + round 完全一致；
//          对不上就拒绝（防止重放/并发把同一轮驱动两次）。
//   闸门③ 错误即解除：一轮出错就 disarm，不带着错误继续往下转。
//
// 另外两条 dsh 的规矩照搬：
//   · **complete / blocked 只接受人类输入**。模型自己说"我做完了"不算数——它是
//     不可验证的说法，而元枢的价值观是"没被观测的说法不算证据"。
//   · **会话恢复后回到未武装态**，必须人类说"继续"才重新武装。重启不该自动续跑。
//
// 与 dsh 的一处**刻意分歧**：dsh 的 round-driver 默认就自动推进；元枢把自动推进
// 做成显式开关 `autoAdvance`，**默认 false**。默认只注入轮次上下文、不自己起轮次；
// 想要真自动的人才去打开。个人伙伴跑无人看管的 256 轮是成本隐患，不该是默认值。
import fs from "node:fs";
import path from "node:path";
import { atomicWriteText } from "./atomic-io.mjs";

/** 元枢的默认回合上限。dsh 取 256（无人值守批处理），元枢是个人伙伴，取小值。 */
export const DEFAULT_MAX_ROUNDS = 20;
export const GOAL_STATUSES = ["paused", "active", "complete", "blocked"];

export function goalPaths(wsRoot) {
  return { dir: path.join(wsRoot, "记忆"), file: path.join(wsRoot, "记忆", "目标.json") };
}

export function loadGoals(wsRoot, fsMod = fs) {
  try {
    const f = goalPaths(wsRoot).file;
    if (!fsMod.existsSync(f)) return [];
    const parsed = JSON.parse(fsMod.readFileSync(f, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((g) => g && typeof g === "object" && g.objective) : [];
  } catch { return []; }
}

function saveGoals(wsRoot, list, fsMod = fs) {
  try {
    fsMod.mkdirSync(goalPaths(wsRoot).dir, { recursive: true });
    atomicWriteText(goalPaths(wsRoot).file, JSON.stringify(list, null, 2));
    return { ok: true, count: list.length };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 80) }; }
}

const nowIso = (now) => (now instanceof Date ? now : new Date()).toISOString();

function bound(n, fallback, max) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) return fallback;
  return Math.min(v, max);
}

/** 新建目标。**默认 paused（未武装）**——建了不等于开始跑。 */
export function createGoal(wsRoot, { objective = "", maxRounds = DEFAULT_MAX_ROUNDS, autoAdvance = false } = {}, { fsMod = fs, now } = {}) {
  const text = String(objective || "").trim();
  if (text.length < 4) return { ok: false, reason: "目标太短，至少要 4 个字" };
  const list = loadGoals(wsRoot, fsMod);
  const goal = {
    id: `g_${Date.now().toString(36)}_${list.length}`,
    objective: text.slice(0, 300),
    status: "paused",
    autoAdvance: autoAdvance === true,
    round: 0,
    maxRounds: bound(maxRounds, DEFAULT_MAX_ROUNDS, 200),
    revision: 1,
    claimedRound: null,       // 闸门②：本轮已预约的轮号
    blockedReason: null,
    createdAt: nowIso(now),
    updatedAt: nowIso(now),
  };
  saveGoals(wsRoot, [...list, goal], fsMod);
  return { ok: true, goal };
}

function patchGoal(wsRoot, id, patch, fsMod = fs) {
  const list = loadGoals(wsRoot, fsMod);
  const hit = list.find((g) => g.id === id);
  if (!hit) return { ok: false, reason: "目标不存在" };
  Object.assign(hit, patch);
  saveGoals(wsRoot, list, fsMod);
  return { ok: true, goal: hit };
}

const HUMAN_ONLY = "只有人类能给这个结论（模型自述不算证据）";

/** 武装 / 重新武装。`origin` 必须是 human——恢复会话后也要人类说"继续"。 */
export function armGoal(wsRoot, id, { origin = "model", autoAdvance = null } = {}, opts = {}) {
  if (origin !== "human") return { ok: false, reason: HUMAN_ONLY };
  const list = loadGoals(wsRoot, opts.fsMod);
  const hit = list.find((g) => g.id === id);
  if (!hit) return { ok: false, reason: "目标不存在" };
  if (hit.status === "complete") return { ok: false, reason: "目标已完成，先建新的" };
  const patch = { status: "active", blockedReason: null, claimedRound: null, revision: (hit.revision || 1) + 1, updatedAt: nowIso(opts.now) };
  if (autoAdvance !== null) patch.autoAdvance = autoAdvance === true;
  return patchGoal(wsRoot, id, patch, opts.fsMod);
}

/** 暂停：人类或系统都可（错误即解除走这里）。 */
export function pauseGoal(wsRoot, id, { reason = null, origin = "model" } = {}, opts = {}) {
  if (origin === "model" && !reason) return { ok: false, reason: "系统暂停必须给出原因（失败要可见）" };
  return patchGoal(wsRoot, id, { status: "paused", claimedRound: null, blockedReason: reason ? String(reason).slice(0, 120) : null, updatedAt: nowIso(opts.now) }, opts.fsMod);
}

/** 闸门③：本轮出错 → 立刻解除，不带着错误继续转。 */
export function noteGoalError(wsRoot, id, error, opts = {}) {
  return pauseGoal(wsRoot, id, { reason: `本轮出错已停止：${String(error || "未知错误").slice(0, 80)}`, origin: "system" }, opts);
}

/** 完成 / 受阻。**只接受人类输入**（闸门：模型自述不算证据）。 */
export function settleGoal(wsRoot, id, { status = "complete", origin = "model", evidence = "", reason = "" } = {}, opts = {}) {
  if (origin !== "human") return { ok: false, reason: HUMAN_ONLY };
  if (!["complete", "blocked"].includes(status)) return { ok: false, reason: "只能标 complete 或 blocked" };
  const patch = { status, claimedRound: null, updatedAt: nowIso(opts.now) };
  if (status === "complete") {
    // dsh 的做法：complete 必须带证据。这里不强制非空，但空证据要留痕，便于台前显示"无证据"。
    patch.evidence = String(evidence || "").trim().slice(0, 200) || null;
    patch.blockedReason = null;
  } else {
    patch.blockedReason = String(reason || "").trim().slice(0, 200) || "人类判定受阻";
    patch.evidence = String(evidence || "").trim().slice(0, 200) || null;
  }
  return patchGoal(wsRoot, id, patch, opts.fsMod);
}

/** 会话恢复 / 重启：所有活动目标回到未武装态，必须人类重新武装。 */
export function disarmAllGoals(wsRoot, { reason = "会话恢复后需人类重新确认" } = {}, opts = {}) {
  const list = loadGoals(wsRoot, opts.fsMod);
  let n = 0;
  for (const g of list) {
    if (g.status !== "active") continue;
    g.status = "paused";
    g.claimedRound = null;
    g.blockedReason = reason;
    g.updatedAt = nowIso(opts.now);
    n++;
  }
  if (n) saveGoals(wsRoot, list, opts.fsMod);
  return { ok: true, disarmed: n };
}

export function listGoals(wsRoot, { fsMod = fs, status = null } = {}) {
  const all = loadGoals(wsRoot, fsMod);
  return status ? all.filter((g) => g.status === status) : all;
}

/** 当前在跑的目标（至多一个——多个目标同时自动推进无法解释它在完成什么）。 */
export function activeGoal(wsRoot, opts = {}) {
  return listGoals(wsRoot, { ...opts, status: "active" })[0] || null;
}

/**
 * 闸门②：为本轮预约一个轮号。同一 (id, revision, round) 只驱动一次。
 * 返回 {ok, round} 或 {ok:false, reason}。
 */
export function claimGoalRound(wsRoot, id, { revision = null, round = null, fsMod = fs, now } = {}) {
  const list = loadGoals(wsRoot, fsMod);
  const hit = list.find((g) => g.id === id);
  if (!hit) return { ok: false, reason: "目标不存在" };
  if (hit.status !== "active") return { ok: false, reason: `目标不在活动态（${hit.status}）` };
  // 闸门①：到顶就停，自动转 blocked，不再"再来一轮"
  if (hit.round >= hit.maxRounds) {
    patchGoal(wsRoot, id, { status: "blocked", blockedReason: `已达回合上限 ${hit.maxRounds}`, claimedRound: null, updatedAt: nowIso(now) }, fsMod);
    return { ok: false, reason: "round-limit" };
  }
  if (revision !== null && Number(revision) !== hit.revision) return { ok: false, reason: "revision 不匹配（目标已被改动，本轮作废）" };
  const want = round === null || round === undefined ? null : Number(round);
  // 闸门②：同一个轮号只能驱动一次。显式指定已预约过的轮号 = 重放，直接拒。
  if (want !== null && want === hit.round && hit.claimedRound === hit.round) {
    return { ok: false, reason: `第 ${want} 轮已预约过（不重复驱动）` };
  }
  const nextRound = hit.round + 1;
  if (want !== null && want !== nextRound) {
    return { ok: false, reason: `轮号不连续（期望第 ${nextRound} 轮，收到第 ${want} 轮）` };
  }
  if (hit.claimedRound === nextRound) {
    return { ok: false, reason: `第 ${nextRound} 轮已预约过（不重复驱动）` };
  }
  patchGoal(wsRoot, id, { round: nextRound, claimedRound: nextRound, updatedAt: nowIso(now) }, fsMod);
  return { ok: true, round: nextRound, goal: { ...hit, round: nextRound } };
}

/**
 * 每轮推进一步：认领本轮轮号并把要注入的文本一起给出。
 * 没有活动目标、或闸门挡下（到顶 / 重放 / revision 不匹配）时 prompt 为空——不占上下文。
 * 调用点应在**分支之前**调一次，这样 pi 与 yuanshu 两条路径看到的是同一个轮号。
 */
export function advanceGoalTurn(wsRoot, { fsMod = fs, now } = {}) {
  const g = activeGoal(wsRoot, { fsMod });
  if (!g) return { ok: false, reason: "无活动目标", prompt: "" };
  const claim = claimGoalRound(wsRoot, g.id, { revision: g.revision, fsMod, now });
  if (!claim.ok) return { ...claim, prompt: "" };
  return { ok: true, round: claim.round, goal: claim.goal, prompt: goalPrompt(wsRoot, { fsMod }) };
}

/**
 * 注入提示词的目标区段。只有活动目标才有内容；未武装/没有目标时返回空串（不占上下文）。
 * 沿用 dsh 那条"不要相信早前叙述"的纪律——元枢把它写得更直白。
 */
export function goalPrompt(wsRoot, { fsMod = fs } = {}) {
  const g = activeGoal(wsRoot, { fsMod });
  if (!g) return "";
  return [
    "【进行中的目标】",
    `目标：${g.objective}`,
    `进度：第 ${g.round}/${g.maxRounds} 轮${g.autoAdvance ? "（自动推进已开）" : "（自动推进未开，需人类示意继续）"}`,
    "以当前工作区与持久会话状态为准，不要相信早前叙述；只报告本轮与工具结果实际确立的事，没做成就说没做，不要编。",
    "做完或受阻时要人类确认才算结清——你自己宣布完成不算数。",
  ].join("\n");
}
