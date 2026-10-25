// ===== feedback-job.mjs —— 收件箱也要能被"看见"（2026-10-26）=====
//
// 用户要求：把反馈工单接进 job_status，别等人想起来才去看。
// 判断标准（都是客观数得出来的）：
//   · 有 open 且**还没有任何回信** 超过 48h → stalled（有人报回来，我们没理）
//   · 有 open 且已回信，但还没定论 → running
//   · 全都有回信且已处理 → done
import fs from "node:fs";
import path from "node:path";

const INBOX = path.join("feedback", "inbox.json");
const REPLY_OVERDUE_MS = 48 * 3600 * 1000;

function readInbox(wsRoot) {
  try {
    const box = JSON.parse(fs.readFileSync(path.join(String(wsRoot || "."), INBOX), "utf8"));
    return Array.isArray(box.items) ? box.items : [];
  } catch { return []; }
}

/**
 * @param {{wsRoot:string, now?:number, overdueMs?:number}} input
 * @returns {{id,kind,label,state,step,startedAt,updatedAt,elapsedMs,error}}
 */
export function feedbackJob({ wsRoot, now = Date.now(), overdueMs = REPLY_OVERDUE_MS } = {}) {
  const items = readInbox(wsRoot);
  const open = items.filter((i) => i.status === "open");
  const silent = open.filter((i) => !Array.isArray(i.replies) || i.replies.length === 0);
  const oldest = (list) => list.reduce((min, i) => (min === null || i.at < min ? i.at : min), null);
  const oldestSilent = oldest(silent);

  let state = "done";
  let error = "";
  if (silent.length) {
    const age = oldestSilent ? now - oldestSilent : 0;
    state = age > overdueMs ? "stalled" : "running";
    if (state === "stalled") error = `${silent.length} 条超过 ${Math.round(overdueMs / 3600000)} 小时没回信`;
  } else if (open.length) {
    state = "running";
  }

  const days = oldestSilent ? Math.floor((now - oldestSilent) / 86400000) : 0;
  const step = items.length
    ? `收到 ${items.length} 条，待处理 ${open.length}，其中 ${silent.length} 条没回信${silent.length ? `（最早 ${days} 天前）` : ""}`
    : "收件箱是空的";

  return {
    id: "feedback:inbox",
    kind: "feedback",
    label: "反馈收件箱（外部报回来的）",
    state,
    step,
    startedAt: oldest(items) || null,
    updatedAt: items.reduce((max, i) => Math.max(max, i.at || 0), 0) || null,
    elapsedMs: 0,
    error,
  };
}
