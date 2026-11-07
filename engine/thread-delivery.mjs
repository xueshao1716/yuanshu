// ===== thread-delivery.mjs —— 直通投递（2026-11-07）=====
//
// thread-router 只回答「归谁」；这里回答「怎么交出去」。
// 元枢没有可 steer 的常驻 run，所以只有两种结局：
//   direct → 进该话题的收件箱（不打扰主会话），等话题自己的下一次任务合并消费
//   main   → 照旧进路由器判断
// 不在这一层做任何模型调用，也不写台账（调用方负责）。
import { route, threadKeyOf } from "./thread-router.mjs";
import { enqueue, size, drain } from "./thread-inbox.mjs";

// 哪些话题可以「闷声直通」——收件箱吞掉之后不会有人等着回复的那种。
// 微信不在里面是故意的：那边每一条消息背后都有一个正在等回话的人，
// 直通等于已读不回。要开得显式传 allowWechat（或走 relay 通道之后）。
export const SAFE_DIRECT_PREFIXES = Object.freeze(["task:", "run:", "mail:"]);

/** 这个话题能不能闷声直通。 */
export function canDirectSilently(threadKey, { allowWechat = false } = {}) {
  const key = String(threadKey || "");
  if (!key) return false;
  if (key.startsWith("wechat:")) return !!allowWechat;
  return SAFE_DIRECT_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * 判定一条事件该走哪条路。
 * @returns {{ mode:'direct'|'main', threadKey:string, targets:Array, reason:string }}
 */
export function planDelivery(event = {}, { allowWechat = false } = {}) {
  const r = route(event);
  if (r.route !== "direct") return { mode: "main", threadKey: r.threadKey, targets: [], reason: "没有订阅" };
  if (!canDirectSilently(r.threadKey, { allowWechat })) {
    return { mode: "main", threadKey: r.threadKey, targets: r.targets || [], reason: "这个话题需要回话，不能闷声直通" };
  }
  return { mode: "direct", threadKey: r.threadKey, targets: r.targets || [], reason: "已订阅且可闷声直通" };
}

/**
 * 直通：落进话题收件箱，返回可记账的摘要。
 * @returns {{ ok:boolean, threadKey:string, queued:number, targets:Array, reason:string }}
 */
export function acceptDirect(wsRoot, event = {}, { now = Date.now(), persist = true, allowWechat = false } = {}) {
  const plan = planDelivery(event, { allowWechat });
  if (plan.mode !== "direct") return { ok: false, threadKey: plan.threadKey, queued: 0, targets: [], reason: plan.reason };
  const queued = enqueue(wsRoot, plan.threadKey, event, { now, persist });
  return { ok: queued > 0, threadKey: plan.threadKey, queued, targets: plan.targets, reason: plan.reason };
}

/**
 * 取走某话题的积压，拼成一段可注入的上下文。
 * 没有积压时返回空串——调用方据此决定不加段。
 */
export function takePendingBlock(wsRoot, threadKey, { limit = 20, now = Date.now() } = {}) {
  const rows = drain(wsRoot, threadKey, { limit });
  if (!rows.length) return { count: 0, text: "" };
  const lines = rows.map((r) => {
    const when = new Date(Number(r.at) || now).toISOString().slice(5, 16).replace("T", " ");
    const who = r.source ? `[${r.source}]` : "";
    return `- ${when} ${who} ${String(r.text || "").replace(/\s+/g, " ").slice(0, 300)}`;
  });
  return {
    count: rows.length,
    text: [
      `## 这个话题下积压的 ${rows.length} 条后续（订阅直通，合并处理）`,
      "它们是同一话题里在你上一次动手之后进来的新消息，按时间正序；先看有没有改变结论或范围，再决定继续还是收尾。",
      "",
      ...lines,
    ].join("\n"),
  };
}

/** 话题当前积压（给接口与测试用）。 */
export function pendingCount(wsRoot, event = {}) {
  const key = threadKeyOf(event);
  return key ? size(wsRoot, key) : 0;
}

// ── 派活标签 ⇄ 话题键 ──
// 派活走定时任务，任务记录里没有 threadKey 字段；把话题键编进 label 是最小改动，
// 也让界面上能一眼看出这张活属于哪条话题。
export const ROUTER_LABEL_PREFIX = "路由派活·";

/** 话题键 → 任务标签。没有话题键时退回固定的「路由派活」。 */
export function taskLabelFor(threadKey = "") {
  const key = String(threadKey || "").trim();
  return key ? `${ROUTER_LABEL_PREFIX}${key}` : "路由派活";
}

/** 任务标签 → 话题键。不是派活标签就返回空串。 */
export function threadKeyOfLabel(label = "") {
  const s = String(label || "");
  return s.startsWith(ROUTER_LABEL_PREFIX) ? s.slice(ROUTER_LABEL_PREFIX.length) : "";
}
