// engine/notifier.mjs —— 主动通知中枢：长任务做完 / 智能体想主动告诉用户时，统一从这里发。
// 扇出：全局 SSE（网页、桌面客户端、手机客户端各自订阅后弹系统通知）+ 微信（面板里打开了「通知发到微信」才会真发）+ 落盘（离线补读）。
// 为什么要有：会话 SSE 只有“正在看这个会话”的页面才收得到，任务在没人看的时候做完，用户永远不知道。
import fs from "node:fs";
import { formatWechatPush } from './wechat-push-format.mjs';
import path from "node:path";
import { randomUUID } from "node:crypto";

const RING = 100;
const LONG_RUN_MS = Number(process.env.YUANSHU_NOTIFY_LONG_RUN_MS) || 45_000;

export function createNotifier({ file, wechat = null, now = Date.now, log = console } = {}) {
  let seq = 0;
  let events = [];
  const subs = new Set();

  try {
    if (file && fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(saved?.events)) { events = saved.events.slice(-RING); seq = Number(saved.seq) || events.reduce((m, e) => Math.max(m, e.seq || 0), 0); }
    }
  } catch { /* 坏文件当空处理，通知不是关键数据 */ }

  const persist = () => {
    if (!file) return;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ seq, events })); }
    catch (e) { log.warn?.(`[notifier] 落盘失败: ${String(e?.message || e).slice(0, 80)}`); }
  };

  const send = (sub, ev) => { try { sub.write(`event: notify\ndata: ${JSON.stringify(ev)}\n\n`); } catch { /* 订阅端已断开 */ } };

  async function notify({ kind = "agent", title = "", body = "", sessionId = "", key = "", toWechat = false } = {}) {
    const t = String(title || "").trim().slice(0, 80) || "元枢";
    const b = String(body || "").trim().slice(0, 600);
    if (!b && !title) return { ok: false, error: "通知内容为空" };
    const ev = { id: randomUUID(), seq: ++seq, ts: now(), kind, title: t, body: b, sessionId: String(sessionId || ""), key: String(key || "") };
    events.push(ev);
    if (events.length > RING) events.splice(0, events.length - RING);
    persist();
    for (const sub of subs) send(sub, ev);
    const result = { ok: true, id: ev.id, seq: ev.seq, clients: subs.size, wechat: "skipped" };
    if (toWechat && wechat?.notifyOwner) {
      try { await wechat.notifyOwner(formatWechatPush({ title: t, body: b, kind })); result.wechat = "sent"; }
      catch (e) { result.wechat = `failed: ${String(e?.message || e).slice(0, 80)}`; log.warn?.(`[notifier] 微信通知失败: ${result.wechat}`); }
    }
    return result;
  }

  // 长对话 run 终态：只对“跑了一阵子、用户大概率已经走开”的跑完/失败发，短问答不打扰。
  function runFinished(run, { minMs = LONG_RUN_MS } = {}) {
    if (!run || !["completed", "failed"].includes(run.status)) return null;
    const start = Date.parse(run.startedAt || run.createdAt || "");
    const end = Date.parse(run.completedAt || run.failedAt || "") || now();
    if (!Number.isFinite(start) || end - start < minMs) return null;
    const secs = Math.round((end - start) / 1000);
    const failed = run.status === "failed";
    return notify({
      kind: "run", sessionId: run.sessionId, key: `run:${run.sessionId}`,
      title: failed ? "元枢 · 任务失败" : "元枢 · 任务完成",
      body: failed ? `${String(run.error || "未知原因").slice(0, 160)}（已运行 ${secs} 秒）` : `已运行 ${secs} 秒，回到元枢查看结果`,
    });
  }

  function subscribe(res, req, after) {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const sub = { write: (s) => { if (!res.writableEnded) res.write(s); } };
    // after 缺省 = 只看以后的；显式给了游标才补发（重连不丢）
    if (Number.isInteger(after)) for (const ev of events) if (ev.seq > after) send(sub, ev);
    try { res.write(`event: subscribed\ndata: ${JSON.stringify({ lastSeq: seq })}\n\n`); } catch { /* 断开即忽略 */ }
    subs.add(sub);
    const hb = setInterval(() => { try { sub.write(": ping\n\n"); } catch { /* 断开即忽略 */ } }, 20000);
    hb.unref?.();
    req.on("close", () => { clearInterval(hb); subs.delete(sub); });
  }

  return { notify, runFinished, subscribe, list: (after = 0) => events.filter((e) => e.seq > after), get lastSeq() { return seq; }, get clients() { return subs.size; } };
}

export const NOTIFY_USER_TOOL = {
  type: "function",
  function: {
    name: "notify_user",
    description: "主动告诉用户一件事（会推到用户所有已打开的元枢：网页/电脑端/手机端系统通知，开了「通知发到微信」时也发微信）。"
      + "只在这些时候用：长任务/后台任务/定时任务做完或出了问题，用户很可能已经离开页面。"
      + "你答应过“做完告诉你”，就在做完时调用它，而不是只在对话里说一句。别用它闲聊或重复刚刚已经在对话里说过的话。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "一句话标题，例如“视频已生成”" },
        body: { type: "string", description: "结果摘要（含关键产物位置或失败原因），不超过 200 字" },
        wechat: { type: "boolean", description: "是否同时发微信，默认发（用户没开微信通知时自动跳过）" },
      },
      required: ["title", "body"],
    },
  },
};

export async function execNotifyUser(notifier, args = {}, ctx = {}) {
  const title = String(args?.title || "").trim();
  const body = String(args?.body || "").trim();
  if (!title || !body) return { text: "notify_user 需要 title 和 body", isError: true };
  const r = await notifier.notify({ kind: "agent", title, body, sessionId: ctx.sessionId || "", key: ctx.sessionId ? `agent:${ctx.sessionId}` : "", toWechat: args?.wechat !== false });
  const wx = r.wechat === "sent" ? "，微信已发送" : r.wechat.startsWith("failed") ? `，微信没发出去（${r.wechat.slice(8)}）` : "";
  const reach = r.clients ? `已推到 ${r.clients} 个在线端` : "当前没有在线客户端，用户下次打开会看到";
  return { text: `已通知用户：${reach}${wx}`, isError: false };
}
