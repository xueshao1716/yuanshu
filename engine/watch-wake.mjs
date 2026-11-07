// ===== watch-wake.mjs —— 值班命中后的「唤醒」（2026-11-07）=====
//
// 全系统唯一会因为值班而花模型的地方，就这一个文件。
// 它只在 engine/watch-duty.mjs 过完「冷却 / 每日上限 / 免打扰 / 主动预算」四道闸门之后被调用一次。
//
// 执行链（全部复用现有件，不自造调度器）：
//   watch-duty.tick 命中 → wake() → jobPool.submit（排队/限并发/可取消/落盘）→ runTurn（server 注入的
//   带通道切换的一轮对话）→ notifier 推送 + agent-mailbox 回执 + 值班日志.jsonl 落一条。
import { completedTaskText } from "./task-continuation.mjs";
import { appendWatchLog } from "./watch-duty.mjs";

const KIND_LABEL = { cmd: "命令", http: "网址", file: "文件", time: "时间" };

/** 把「哪条值班命中了、看到了什么」写成一段给未来的自己看的唤醒词。 */
export function composeWakeMessages(watch = {}, hit = {}, { now = Date.now() } = {}) {
  const when = new Date(now).toLocaleString("zh-CN", { hour12: false });
  const spec = watch.spec && typeof watch.spec === "object" ? JSON.stringify(watch.spec).slice(0, 600) : String(watch.spec || "");
  const detail = hit?.detail && typeof hit.detail === "object" ? JSON.stringify(hit.detail).slice(0, 1200) : "";
  const lines = [
    "【值班程序唤醒】这不是伙伴在跟你说话，是你之前写下的盯梢命中了。",
    `时间：${when}`,
    `值班：${watch.name || "未命名"}（${watch.id || "?"}）· 类型：${KIND_LABEL[watch.kind] || watch.kind}`,
    `判定：${hit?.reason || "（未给出原因）"}`,
    `规格：${spec}`,
  ];
  if (detail) lines.push(`现场：${detail}`);
  lines.push(
    "",
    "当时你写下的任务：",
    String(watch.prompt || "（没有写具体任务，就判断这件事要不要告诉伙伴）").slice(0, 3000),
    "",
    "要求：",
    "1. 先给结论（这事是不是真的要处理），再决定要不要动手；需要核实就用工具核实，别凭印象。",
    "2. 不要把「我被唤醒了」「这是一条系统消息」这类过程话写进结果，直接说发生了什么、要不要伙伴做什么。",
    "3. 结果会自动推送给伙伴，并在留言板留一条回执；你不需要再调 notify_user。",
  );
  return [{ role: "user", content: lines.join("\n") }];
}

/**
 * 创建 wake 函数。
 * @param {object} p
 * @param {object} p.jobPool      job-pool 实例（submit 复用排队/限并发/取消）
 * @param {object} p.notifier     notifier 实例（推送到网页/桌面/手机/微信）
 * @param {Function} p.postMessage agent-mailbox 的留言函数（回执）
 * @param {Function} p.runTurn    (messages, opts) => Promise<模型结果>，由 server 注入（带通道切换）
 * @param {string} p.logFile      值班日志 jsonl
 */
export function createWatchWake({
  wsRoot = ".",
  jobPool = null,
  notifier = null,
  postMessage = null,
  runTurn = null,
  logFile = "",
  now = () => Date.now(),
  log = console,
} = {}) {
  if (!jobPool || typeof jobPool.submit !== "function") throw new Error("createWatchWake 需要 jobPool（复用后台作业池）");
  if (typeof runTurn !== "function") throw new Error("createWatchWake 需要 runTurn（唤醒后跑一轮对话）");

  return function wake({ watch = {}, hit = {} } = {}) {
    let handle = null;
    handle = jobPool.submit(
      { kind: "watch", title: `值班：${String(watch.name || watch.id || "盯梢").slice(0, 40)}` },
      async (signal) => {
        const t0 = now();
        try {
          const messages = composeWakeMessages(watch, hit, { now: t0 });
          const raw = await runTurn(messages, { signal });
          const text = String(completedTaskText(raw) || "").trim().slice(0, 6000) || "（这一轮没有输出）";
          const body = text.slice(0, 600);
          try {
            await notifier?.notify?.({
              kind: "watch",
              title: `元枢 · 值班「${String(watch.name || "盯梢").slice(0, 30)}」触发了`,
              body,
              key: `watch:${watch.id || "?"}`,
              toWechat: true,
            });
          } catch (e) {
            log.warn?.(`[watch-wake] 推送失败：${String(e?.message || e).slice(0, 120)}`);
          }
          try {
            postMessage?.({
              wsRoot,
              from: "值班程序",
              to: "小语",
              kind: "alert",
              text: `「${watch.name || watch.id}」触发：${hit?.reason || "命中"}\n${text.slice(0, 1500)}`,
              meta: { watchId: watch.id || "", jobId: handle?.id || "", kind: watch.kind || "" },
            });
          } catch (e) {
            log.warn?.(`[watch-wake] 留言板回执失败：${String(e?.message || e).slice(0, 120)}`);
          }
          appendWatchLog(logFile, { event: "wake_done", watchId: watch.id || "", jobId: handle?.id || "", ms: now() - t0, text: text.slice(0, 800) }, now());
          return text;
        } catch (e) {
          const err = String(e?.message || e).slice(0, 300);
          appendWatchLog(logFile, { event: "wake_error", watchId: watch.id || "", jobId: handle?.id || "", error: err }, now());
          try {
            await notifier?.notify?.({
              kind: "watch",
              title: `元枢 · 值班「${String(watch.name || "盯梢").slice(0, 30)}」唤醒失败`,
              body: `${err}\n（命中判定：${String(hit?.reason || "").slice(0, 120)}。下次检查会继续盯。）`,
              key: `watch:${watch.id || "?"}:error`,
            });
          } catch { /* 推送失败不再抛 */ }
          throw e;
        }
      },
    );
    appendWatchLog(logFile, {
      event: "wake_dispatch",
      watchId: watch.id || "",
      name: watch.name || "",
      jobId: handle?.id || "",
      reason: hit?.reason || "",
    }, now());
    log.log?.(`[watch-wake] 值班 ${watch.id} 命中，已交后台作业 ${handle?.id}：${String(hit?.reason || "").slice(0, 80)}`);
    return { jobId: handle?.id || "", status: handle?.status || "queued" };
  };
}
