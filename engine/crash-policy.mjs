// ===== crash-policy.mjs —— 未捕获异常要不要退出服务（2026-10-26）=====
//
// 起因：分发的 Linux 用户报回两条崩溃，都是 `Timeout._onTimeout` 抛的——**某个定时器里的 bug**，
// 但现在的兜底是「记日志 → close → 2s 后 exit(1)」→ watchdog 拉起 →
// 那个定时器下次又炸 → 用户那边看到的是**服务反复重启**（报告里 `watchdog 重启 3 次`）。
//
// 判断原则：
//   · 偶发一次 → 只记账、**不退出**（坏的只是那一个定时器，没理由让整台服务停摆）
//   · 同一签名 60 秒内重复 3 次 → 认为已经处在坏死循环里，退出让 watchdog 干净重启
//   · 内存耗尽这类明显致命的（OOM）→ 直接退出
// 判断写成纯函数，方便单测；server 只负责调用和记录。
export const CRASH_WINDOW_MS = 60_000;
export const CRASH_REPEAT_LIMIT = 3;

/** 错误签名：只取类型 + 第一条栈帧，避免每次对象地址不同导致永远不重复。 */
export function crashSignature(err) {
  const text = String(err?.stack || err || "");
  const head = text.split("\n").slice(0, 2).join(" | ");
  return head.replace(/0x[0-9a-f]+/gi, "0x*").slice(0, 200);
}

export function isFatalError(err) {
  const t = String(err?.stack || err || "");
  return /JavaScript heap out of memory|heap out of memory|ENOMEM|Cannot allocate memory/i.test(t);
}

/**
 * @param {{history:number[], now:number, windowMs?:number, limit?:number, err?:any}} input
 * @returns {{action:'survive'|'exit', repeats:number, reason:string}}
 */
export function decideCrashAction({ history = [], now = Date.now(), windowMs = CRASH_WINDOW_MS, limit = CRASH_REPEAT_LIMIT, err = null } = {}) {
  if (isFatalError(err)) return { action: "exit", repeats: history.length, reason: "out_of_memory" };
  const recent = [...history, now].filter((t) => Number.isFinite(t) && now - t <= windowMs);
  if (recent.length >= limit) {
    return { action: "exit", repeats: recent.length, reason: `same_crash_${recent.length}x_in_${Math.round(windowMs / 1000)}s` };
  }
  return { action: "survive", repeats: recent.length, reason: "transient" };
}
