// ===== wechat-circuit.mjs —— 发送熔断（2026-10-28）=====
//
// 设计借鉴 Hermes 的限流熔断：窗口内连续失败 N 次 → 停一会儿再发，别硬撞。
//
// 为什么需要：我们的 flush 现在失败就记一笔、接着发下一条——真被限流时，
// 越撞越久、还可能把账号搞进更长的冷却。熔断的作用是"认出自己在挨打，先停手"。
//
// 参数：
//   threshold  窗口内失败几次开闸（默认 3）
//   windowMs   计数窗口（默认 60s）
//   openMs     闸门持续多久（默认 60s，按失败次数递增，最多 4 倍）
export function createCircuit({ threshold = 3, windowMs = 60_000, openMs = 60_000, maxOpenMs = 240_000, now = Date.now } = {}) {
  let failures = [];      // 时间戳
  let openUntil = 0;
  let openCount = 0;

  return {
    /** 记一次失败；返回是否因此打开了闸门。 */
    recordFailure() {
      const t = now();
      failures = failures.filter((x) => t - x < windowMs).concat(t);
      if (failures.length < threshold) return false;
      const factor = Math.min(4, Math.max(1, failures.length - threshold + 1));
      openUntil = t + Math.min(maxOpenMs, openMs * factor);
      openCount += 1;
      failures = [];
      return true;
    },
    /** 记一次成功：清空失败计数（闸门已经开了就不动，等它自然到期）。 */
    recordSuccess() {
      failures = [];
    },
    /** 闸门是否还开着。 */
    isOpen() {
      return now() < openUntil;
    },
    remainingMs() {
      return Math.max(0, openUntil - now());
    },
    /** 面板/日志用。 */
    snapshot() {
      return { open: this.isOpen(), remainingMs: this.remainingMs(), recentFailures: failures.length, openCount };
    },
    reset() {
      failures = [];
      openUntil = 0;
      openCount = 0;
    },
  };
}
