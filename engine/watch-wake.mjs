// ===== watch-wake.mjs —— 值班命中后的「唤醒」（2026-11-07）=====
//
// 全系统唯一会因为值班而花模型的地方，就这一个文件。
// 它只在 engine/watch-duty.mjs 过完「冷却 / 每日上限 / 免打扰 / 主动预算」四道闸门之后被调用一次。
//
// 执行链（全部复用现有件，不自造调度器）：
//   watch-duty.tick 命中 → wake() → jobPool.submit（排队/限并发/可取消/落盘）→ runTurn（server 注入的
//   带通道切换的一轮对话）→ notifier 推送 + agent-mailbox 回执 + 值班日志落一条。
//
// 2026-11-07 收紧（五条不足之二）：唤醒轮默认只给**最小只读工具集**，不再把 UNIFIED_TOOLS 整张表丢进去。
//   · 默认：read / search_files(或 grep/glob) / web_search / read_url / list_channels + notify_user 等回执工具；
//   · 默认不给：write / edit / bash / pwsh / dsh_task / 媒体生成；
//   · watch.allowTools 显式配了白名单 → 按白名单给（仍与 UNIFIED_TOOLS 求交集，命令仍要过 preflightCommand 与沙箱）。
import { completedTaskText } from "./task-continuation.mjs";
import { appendWatchLog } from "./watch-duty.mjs";

const KIND_LABEL = { cmd: "命令", http: "网址", file: "文件", time: "时间" };

/**
 * 唤醒轮默认工具白名单（名字，按需与 UNIFIED_TOOLS 求交集）。
 * 这里同时列出不同版本的等价工具名（search_files / grep / glob、notify_user / report），
 * 不存在的名字会被 resolveWakeTools 静默过滤——这样换引擎/换工具表时默认集不会一夜失效。
 */
export const DEFAULT_WAKE_TOOLS = Object.freeze([
  "read",
  "search_files",
  "grep",
  "glob",
  "web_search",
  "read_url",
  "orchestrator_read",
  "list_channels",
  "notify_user",
  "report",
]);

/** 与默认只读集对照用的「明确不给」清单（文档/测试可引用）。 */
export const DEFAULT_WAKE_DENY = Object.freeze([
  "write", "edit", "bash", "pwsh", "dsh_task", "run_detached",
  "generate_image", "generate_video", "generate_tts", "computer_use",
]);

/**
 * 计算这一轮真正要发给模型的工具表。
 *   · allowTools 为 null/undefined → 用 DEFAULT_WAKE_TOOLS；
 *   · allowTools 为数组（含空数组）→ 只按它给（空数组 = 一个工具都不给）；
 *   · 最后与 allTools（server 的 UNIFIED_TOOLS）求交集，保证不把不存在的工具塞给上游。
 */
export function resolveWakeTools(allTools = [], allowTools = null) {
  const available = (Array.isArray(allTools) ? allTools : [])
    .map((def) => ({ def, name: def?.function?.name || def?.name || "" }))
    .filter((x) => x.name);
  const wanted = Array.isArray(allowTools) ? allowTools : DEFAULT_WAKE_TOOLS;
  const wantedNames = [...new Set(wanted.map((n) => String(n || "").trim()).filter(Boolean))];
  const byName = new Map(available.map((x) => [x.name, x.def]));
  const tools = [];
  const names = [];
  const unknown = [];
  for (const name of wantedNames) {
    if (byName.has(name)) {
      tools.push(byName.get(name));
      names.push(name);
    } else {
      unknown.push(name);
    }
  }
  return { tools, names, unknown, usingDefault: !Array.isArray(allowTools) };
}

/**
 * 把「哪条值班命中了、看到了什么」写成一段给未来的自己看的唤醒词。
 * 第一条是 system：明确这是后台执行轮，只做检查与汇报（除非 allowTools 明确允许写）。
 */
export function composeWakeMessages(watch = {}, hit = {}, { now = Date.now(), tools = null } = {}) {
  const when = new Date(now).toLocaleString("zh-CN", { hour12: false });
  const deferred = hit?.deferred === true;
  const spec = watch.spec && typeof watch.spec === "object" ? JSON.stringify(watch.spec).slice(0, 600) : String(watch.spec || "");
  const detail = hit?.detail && typeof hit.detail === "object" ? JSON.stringify(hit.detail).slice(0, 1200) : "";
  const toolNames = Array.isArray(tools)
    ? tools.map((t) => t?.function?.name || t?.name || "").filter(Boolean)
    : [];
  const allow = Array.isArray(watch.allowTools) ? watch.allowTools : null;

  const system = [
    "你是元枢的值班执行轮（后台唤醒），不是伙伴在对话。",
    "只做检查与汇报，不要改代码、不要删数据、不要发布、不要花钱；除非本次 watch 的 allowTools 明确允许写操作，否则不要调用任何会改动文件或系统的工具。",
    allow
      ? `本次 allowTools（显式白名单）：${allow.length ? allow.join("、") : "（空：本轮没有任何工具）"}。`
      : `本轮默认只给只读工具：${toolNames.length ? toolNames.join("、") : "（无）"}。`,
    "结论要短：发生了什么、要不要伙伴做什么。",
  ].join("\n");

  const lines = [
    "【值班程序唤醒】这不是伙伴在跟你说话，是你之前写下的盯梢命中了。",
    `时间：${when}`,
    `值班：${watch.name || "未命名"}（${watch.id || "?"}）· 类型：${KIND_LABEL[watch.kind] || watch.kind}`,
    `判定：${hit?.reason || "（未给出原因）"}`,
    `规格：${spec}`,
  ];
  if (deferred) {
    const at = Number(hit?.at) || now;
    lines.push(`补跑：这条命中在免打扰（0–7 点）期间被拦下，现在补跑；原命中时间：${new Date(at).toLocaleString("zh-CN", { hour12: false })}`);
  }
  if (detail) lines.push(`现场：${detail}`);
  lines.push(
    "",
    "当时你写下的任务：",
    String(watch.prompt || "（没有写具体任务，就判断这件事要不要告诉伙伴）").slice(0, 3000),
    "",
    "要求：",
    "1. 先给结论（这事是不是真的要处理），再决定要不要动手；需要核实就用工具核实，别凭印象。",
    "2. 不要把「我被唤醒了」「这是一条系统消息」这类过程话写进结果，直接说发生了什么、要不要伙伴做什么。",
    "3. 结果会自动推送给伙伴，并在留言板留一条回执；一般不需要再调 notify_user。",
  );
  return [{ role: "system", content: system }, { role: "user", content: lines.join("\n") }];
}

/**
 * 创建 wake 函数。
 * @param {object} p
 * @param {object} p.jobPool      job-pool 实例（submit 复用排队/限并发/取消）
 * @param {object} p.notifier     notifier 实例（推送到网页/桌面/手机/微信）
 * @param {Function} p.postMessage agent-mailbox 的留言函数（回执）
 * @param {Function} p.runTurn    (messages, opts) => Promise<模型结果>，由 server 注入（带通道切换）
 * @param {string} p.logFile      值班日志「基准路径」（按天切分由 watch-log.mjs 负责）
 * @param {Array}  p.allTools     server 的 UNIFIED_TOOLS；给了才会做「默认只读 / allowTools 白名单」裁剪
 */
export function createWatchWake({
  wsRoot = ".",
  jobPool = null,
  notifier = null,
  postMessage = null,
  runTurn = null,
  logFile = "",
  allTools = null,
  now = () => Date.now(),
  log = console,
} = {}) {
  if (!jobPool || typeof jobPool.submit !== "function") throw new Error("createWatchWake 需要 jobPool（复用后台作业池）");
  if (typeof runTurn !== "function") throw new Error("createWatchWake 需要 runTurn（唤醒后跑一轮对话）");

  return function wake({ watch = {}, hit = {} } = {}) {
    const deferred = hit?.deferred === true;
    const label = deferred ? "免打扰补跑" : "触发";
    // 只有 server 显式注入 allTools 时才裁剪；没注入就沿用调用方的默认（测试/旧调用方兼容）。
    const scope = Array.isArray(allTools) ? resolveWakeTools(allTools, watch.allowTools ?? null) : null;
    let handle = null;
    handle = jobPool.submit(
      { kind: "watch", title: `值班：${String(watch.name || watch.id || "盯梢").slice(0, 40)}` },
      async (signal) => {
        const t0 = now();
        try {
          const messages = composeWakeMessages(watch, hit, { now: t0, tools: scope?.tools || null });
          const turnOpts = { signal };
          // 空数组在 unifiedChat 里会被当成「有工具表但为空」，部分上游会 400；
          // 显式 tools:false 才是「这一轮没有工具」的正确表达。
          if (scope) turnOpts.tools = scope.tools.length ? scope.tools : false;
          const raw = await runTurn(messages, turnOpts);
          const text = String(completedTaskText(raw) || "").trim().slice(0, 6000) || "（这一轮没有输出）";
          const body = text.slice(0, 600);
          try {
            await notifier?.notify?.({
              kind: "watch",
              // 补跑必须在推送标题里就能看出来：否则伙伴会以为是刚刚才发生的事
              title: `元枢 · 值班「${String(watch.name || "盯梢").slice(0, 30)}」触发了${deferred ? "（补跑）" : ""}`,
              body: deferred ? `【补跑】${body}` : body,
              key: `watch:${watch.id || "?"}${deferred ? ":deferred" : ""}`,
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
              text: `${deferred ? "【补跑】" : ""}「${watch.name || watch.id}」${label}：${hit?.reason || "命中"}\n${text.slice(0, 1500)}`,
              meta: { watchId: watch.id || "", jobId: handle?.id || "", kind: watch.kind || "", deferred },
            });
          } catch (e) {
            log.warn?.(`[watch-wake] 留言板回执失败：${String(e?.message || e).slice(0, 120)}`);
          }
          appendWatchLog(logFile, {
            event: "wake_done", watchId: watch.id || "", jobId: handle?.id || "",
            deferred, ms: now() - t0, text: text.slice(0, 800),
          }, now());
          return text;
        } catch (e) {
          const err = String(e?.message || e).slice(0, 300);
          appendWatchLog(logFile, { event: "wake_error", watchId: watch.id || "", jobId: handle?.id || "", deferred, error: err }, now());
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
      deferred,
      allowTools: Array.isArray(watch.allowTools) ? watch.allowTools : null,
      tools: scope ? scope.names : null,
    }, now());
    log.log?.(`[watch-wake] 值班 ${watch.id} ${deferred ? "免打扰补跑" : "命中"}，已交后台作业 ${handle?.id}：${String(hit?.reason || "").slice(0, 80)}`);
    return { jobId: handle?.id || "", status: handle?.status || "queued", deferred, tools: scope ? scope.names : null };
  };
}
