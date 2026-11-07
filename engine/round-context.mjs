// ===== round-context.mjs —— 把"这一轮是谁"带到任意深的工具调用（2026-11-07）=====
//
// 用户触发的 run 有 run-store 记录，runId 经 executionContext → toolContext 一路传到审计门；
// 但定时任务 / 后台子代理 / 值班唤醒是**她自己发起的**，unifiedChat 外没有那层
// executionContext，工具审计只能拿到空 runId，看门狗也就只能说"这轮没带 id"。
//
// 这里不新造调度器，只补一个 AsyncLocalStorage 上下文：
//   runWithRound({ runId, title, sessionId, kind }, () => ...)
// 期间发生的任何工具调用（含异步/并行）都能用 currentRound() 取到这一轮的 id 与名字。
// 与 initiator.mjs 同一套思路：不靠全局变量，并发跑也不会串。
import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage();

/** 当前所在的内部轮次（用户 run 的上下文里返回 null）。 */
export function currentRound() {
  return als.getStore() || null;
}

/** 在这一轮的身份里跑一段异步逻辑（返回值原样透出）。 */
export function runWithRound(round, fn) {
  const store = round && typeof round === "object" ? round : null;
  return als.run(store, fn);
}
