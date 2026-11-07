// engine/subagent-state.mjs —— 后台子代理的显式状态机 + 回传文案（纯函数，2026-11-07）
//
// 为什么单开一个文件：状态转移和"回传怎么写"是最容易被顺手改坏的两块，
// 而它们恰好不需要任何 I/O —— 放在这里就能用极快的单测钉住：
//   · 合法/非法转移（非法必须**报错**，不能静默把状态改掉）
//   · 成功 / 失败（含超时）/ 取消 三种终态的回传正文
//   · "下一轮给父会话看"的注入文案与未读计数
//   · 该不该打扰人（主动预算之前的最后一道判断）
//
// 本文件不 import fs、不碰定时器/网络、不 import 任何 engine 模块，测试可以直接跑。

export const SUBAGENT_STATES = Object.freeze(["queued", "running", "done", "failed", "cancelled", "interrupted"]);
export const TERMINAL_STATES = Object.freeze(["done", "failed", "cancelled", "interrupted"]);

// 状态机显式写死，不做"未知状态默认放行"：
//   queued → running → done / failed / cancelled
//   续聊 = done（或 failed/interrupted）→ queued（排队）→ running
//   cancelled 是真正的终点：用户已经让它停了，不再给续
const TRANSITIONS = Object.freeze({
  queued: Object.freeze(["running", "cancelled"]),
  running: Object.freeze(["done", "failed", "cancelled", "interrupted"]),
  done: Object.freeze(["queued", "running"]),
  failed: Object.freeze(["queued", "running"]),
  cancelled: Object.freeze([]),
  interrupted: Object.freeze(["queued", "running"]),
});

const clip = (value, max) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
};

/** 状态的中文说法；失败时可选区分"超时"（errorCode）。 */
export function statusLabel(status, { errorCode = "" } = {}) {
  switch (String(status || "")) {
    case "queued": return "排队中";
    case "running": return "在跑";
    case "done": return "已完成";
    case "failed": return String(errorCode || "") === "timeout" ? "失败（超时）" : "失败";
    case "cancelled": return "已取消";
    case "interrupted": return "已中断";
    default: return String(status || "未知");
  }
}

export function isTerminal(status) {
  return TERMINAL_STATES.includes(String(status || ""));
}

/** 这个转移合法吗？未知状态、未知目标一律 false。 */
export function canTransition(from, to) {
  const next = TRANSITIONS[String(from || "")];
  return Array.isArray(next) && next.includes(String(to || ""));
}

/** 构造一个带 code 的非法转移错误（调用方据此回 4xx，不许静默）。 */
export function transitionError(from, to) {
  const error = new Error(`子代理状态不能从「${statusLabel(from)}」转到「${statusLabel(to)}」（${from} → ${to}）`);
  error.code = "illegal_transition";
  error.from = String(from || "");
  error.to = String(to || "");
  return error;
}

/** 断言合法转移；非法就抛。返回 true，方便内联使用。 */
export function assertTransition(from, to) {
  if (!canTransition(from, to)) throw transitionError(from, to);
  return true;
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  if (total < 1000) return `${total} 毫秒`;
  const seconds = total / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
}

/**
 * 构造一条回传（写进 agent-mailbox 的那条）。
 * 成功/失败/取消都走这里——"只在成功时通知"是明确要避免的。
 * @returns {{id,status,statusLabel,kind,summary,text,title,body}}
 */
export function buildReceipt({
  id = "",
  status = "done",
  task = "",
  result = "",
  error = "",
  errorCode = "",
  evidence = [],
  durationMs = 0,
  continueCount = 0,
} = {}) {
  const label = statusLabel(status, { errorCode });
  const head = `【子代理回执】${id} ${label}（耗时 ${formatDuration(durationMs)}${continueCount > 0 ? `，第 ${continueCount + 1} 轮` : ""}）`;
  const lines = [head, `任务：${clip(task, 80)}`];
  if (status === "done") {
    const summary = clip(result, 400) || "（没有正文）";
    lines.push(`摘要：${summary}`);
    const items = (Array.isArray(evidence) ? evidence : []).map((x) => clip(x, 160)).filter(Boolean).slice(0, 3);
    if (items.length) lines.push(`证据：${items.join("；")}`);
  } else if (status === "cancelled") {
    lines.push("说明：任务在跑完之前被取消，没有结论。要它接着干可以用续聊（会保留原任务与已有结论）。");
  } else if (status === "interrupted") {
    lines.push(`说明：${clip(error, 200) || "宿主在子代理结束前重启，已恢复为中断"}`);
  } else {
    lines.push(`原因：${clip(error, 400) || "未知失败原因"}`);
    if (errorCode) lines.push(`错误码：${clip(errorCode, 60)}`);
  }
  const text = clipText(lines.join("\n"), 1200);
  const summary = status === "done" ? clip(result, 160) || "（没有正文）" : clip(error, 160) || label;
  return {
    id,
    status,
    statusLabel: label,
    // 失败用 alert，其余用 note：界面按 kind 分级，别把"取消"也标成告警
    kind: status === "failed" || status === "interrupted" ? "alert" : "note",
    summary,
    text,
    title: `元枢 · 子代理${label}`,
    body: clip(`${clip(task, 50)} → ${summary}`, 300),
  };
}

// 只按长度裁剪，保留换行（回执是多行的，压成一行没法读）
function clipText(text, max) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

/**
 * 生成"下一轮注入给父会话"的那条系统提示。
 * 模板：`【系统】子代理 X 已完成：…（未读 N 条）`；多条时后续行不再重复未读数。
 * @param {Array<{id,status,statusLabel?,summary}>} items
 * @param {number} unread 未读回执总数（包含没显示出来的那些）
 */
export function buildReceiptNote(items = [], unread = 0) {
  const rows = (Array.isArray(items) ? items : []).filter(Boolean).slice(0, 3);
  if (!rows.length) return "";
  const total = Math.max(rows.length, Number(unread) || 0);
  return rows
    .map((row, index) => {
      const label = row.statusLabel || statusLabel(row.status);
      const summary = clip(row.summary || "（无摘要）", 200);
      return `【系统】子代理 ${row.id} ${label}：${summary}${index === 0 ? `（未读 ${total} 条）` : ""}`;
    })
    .join("\n");
}

/**
 * 该不该推一条推送给人（notifier）。
 * 规则：成功只在"跑了足够久"时推（短问答不打扰）；失败必推；取消不推（用户自己按的）。
 * 这只是**纯判断**，真正的每日预算与免打扰在调用方（budgetGate）再拦一道。
 */
export function shouldPushReceipt({ status = "", durationMs = 0, minMs = 20000 } = {}) {
  const ms = Math.max(0, Number(durationMs) || 0);
  if (status === "failed") return { push: true, reason: "failed" };
  if (status === "done") {
    return ms >= Math.max(0, Number(minMs) || 0) ? { push: true, reason: "long_run" } : { push: false, reason: "short_run" };
  }
  if (status === "cancelled") return { push: false, reason: "cancelled" };
  return { push: false, reason: "not_pushable" };
}

/** 记录排序用：没有时间戳的排最后。 */
function recordTime(record = {}) {
  return Date.parse(String(record.startedAt || record.createdAt || "")) || 0;
}

/**
 * 登记表裁剪：只留最近的 keep 条；体积超限时从**最旧**的开始丢上下文
 * （任务与上一轮结论保留，续聊退化为"不带原上下文"，但不会把文件撑爆）。
 */
export function pruneRecords(items = [], { keep = 60, maxBytes = 900_000 } = {}) {
  const list = (Array.isArray(items) ? items : []).filter((item) => item && item.id).map((item) => ({ ...item }));
  const sorted = list.sort((a, b) => recordTime(b) - recordTime(a));
  const kept = sorted.slice(0, Math.max(1, Number(keep) || 60));
  let bytes = JSON.stringify(kept).length;
  for (let index = kept.length - 1; index >= 0 && bytes > maxBytes; index -= 1) {
    const row = kept[index];
    if (row.contextPruned || (!row.context?.length && !row.seed?.length && !row.lastResult)) continue;
    kept[index] = { ...row, context: [], seed: [], lastResult: "", contextPruned: true };
    bytes = JSON.stringify(kept).length;
  }
  return kept;
}

/** 列表过滤：status 支持逗号分隔多个；sessionId 只看某个父会话。 */
export function filterSubagents(rows = [], { status = "", sessionId = "", limit = 50 } = {}) {
  const wanted = String(status || "").split(",").map((item) => item.trim()).filter(Boolean);
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row.id)
    .filter((row) => !wanted.length || wanted.includes(String(row.status || "")))
    .filter((row) => !sessionId || String(row.parent?.sessionId || row.parentSessionId || "") === String(sessionId))
    .sort((a, b) => recordTime(b) - recordTime(a))
    .slice(0, Math.max(1, Number(limit) || 50));
}
