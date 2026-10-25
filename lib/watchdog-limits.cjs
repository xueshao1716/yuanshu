// ===== lib/watchdog-limits.cjs —— 守护进程阈值的单一真源 =====
//
// 为什么单独成文件：这些数字原来有两份副本——watchdog.cjs 里的本地常量，
// 和 server.mjs 里通知文案硬编码的"180 秒"。2026-10-23 把阈值从 180 提到 300 时
// 只改了前者，于是用户收到的通知一直说"持续 180 秒会被守护重启"，而实际是 300 秒。
// 阈值和告知必须同一个来源，否则下次还会有人照着通知去等一个不存在的号码。
//
// CJS 是因为 watchdog 以 CommonJS 启动（早于 ESM 世界）；server.mjs 可以直接 import 它，
// Node 的 CJS 互操作会把 module.exports 作为 default 给出来。
const LIMITS = Object.freeze({
  /** 连续多少次健康检查失败，才谈"僵死" */
  STUCK_KILL_AFTER: 3,
  /**
   * 失败要持续多久才强杀。历史：60s → 180s（2026-10-23 前）→ 300s。
   * 提上去的原因是实测 163 秒的停顿会自己恢复（GC / 内存回收），180 秒会误杀。
   */
  STUCK_MIN_MS: 300_000,
  /** 冷启动宽限：实测要 40–60 秒，原来 15 秒就判死会杀掉正常的启动 */
  STARTUP_GRACE_MS: 120_000,
  /** 有轮次在跑时，额外再等多久才动刀（总容忍 = STUCK_MIN_MS + 这个值） */
  ACTIVE_RUN_GRACE_MS: 300_000,
  /** 心跳写到服务冻住之间允许的间隔：心跳最后一次写在这个窗口内，说明"冻住时它确实在干活" */
  HEARTBEAT_STALE_MS: 60_000,
});

/**
 * 判定该不该强杀僵死的子进程。
 *
 * 关键在 activeRuns：事件循环卡死时健康检查一定失败，但**正在跑的对话也一起卡住了**。
 * 原来的逻辑只看"失败够久"就杀——一次超过 300 秒的大停顿会把用户跑到一半的轮次杀掉。
 * 所以：冻住之前的心跳如果报告有活动轮次，就多给 ACTIVE_RUN_GRACE_MS；
 * 真死（进程活着但永不响应）仍然会被收掉，只是晚 5 分钟。
 *
 * @param {object} p
 * @param {number} p.consecutiveFails 连续健康检查失败次数
 * @param {number} p.firstFailAt      这一串失败开始的时间（0 = 还没失败过）
 * @param {number} p.childStartedAt   子进程启动时间
 * @param {number} [p.now]
 * @param {number} [p.activeRuns]     冻住前最后一次心跳报告的活动轮次数
 * @param {number} [p.heartbeatAt]    冻住前最后一次心跳的时间
 * @returns {{kill:boolean, deferred:boolean, reason:string}}
 */
function decideStuckKill({
  consecutiveFails = 0, firstFailAt = 0, childStartedAt = 0, now = Date.now(),
  activeRuns = 0, heartbeatAt = 0, limits = LIMITS,
} = {}) {
  if (!(consecutiveFails >= limits.STUCK_KILL_AFTER)) {
    return { kill: false, deferred: false, reason: `失败次数未到（${consecutiveFails}/${limits.STUCK_KILL_AFTER}）` };
  }
  if (!firstFailAt || now - firstFailAt < limits.STUCK_MIN_MS) {
    return { kill: false, deferred: false, reason: "失败持续时间未到" };
  }
  if (!childStartedAt || now - childStartedAt <= limits.STARTUP_GRACE_MS) {
    return { kill: false, deferred: false, reason: "仍在启动宽限内" };
  }
  const failedSec = Math.round((now - firstFailAt) / 1000);
  // 冻住之前的证据：心跳要在"开始失败"前后仍然新鲜，才有资格代表当时的活动
  const heartbeatSpokeForStall = heartbeatAt > 0 && heartbeatAt + limits.HEARTBEAT_STALE_MS >= firstFailAt;
  if (activeRuns > 0 && heartbeatSpokeForStall && now - firstFailAt < limits.STUCK_MIN_MS + limits.ACTIVE_RUN_GRACE_MS) {
    return {
      kill: false,
      deferred: true,
      reason: `有 ${activeRuns} 个轮次在跑（冻住前心跳可见），暂缓强杀：已等 ${failedSec}s，最多等到 ${Math.round((limits.STUCK_MIN_MS + limits.ACTIVE_RUN_GRACE_MS) / 1000)}s`,
    };
  }
  return { kill: true, deferred: false, reason: `连续 ${consecutiveFails} 次健康检查失败，已持续 ${failedSec}s` };
}

module.exports = { LIMITS, decideStuckKill };
