// engine/sandbox-ask.mjs —— 元枢沙箱升级的人工确认接缝
// 与 pi 共用同一个 confirm-registry：登记 → 推 confirm 事件 → 前端确认卡 → /api/agent/confirm settle。
// 超时 / 会话结束由注册表回 "cancelled"，gateSandboxCall 只认 "allowed-once"，其余一律拒绝（fail-closed）。
// 维护租约（maintenance lease）期间同一会话/任务/运行的升级直接放行一次。

export function createSandboxAskFactory({ registry, hasLease = () => false, timeoutMs } = {}) {
  if (!registry || typeof registry.register !== "function") throw new Error("sandbox-ask: registry required");
  return ({ writer, sessionId, taskId } = {}) => async (toolName, args, reason) => {
    const sid = sessionId || taskId || "new";
    const rid = args?.runId || taskId || sid;
    if (hasLease({ sessionId: sid, taskId: taskId || sid, runId: rid })) return "allowed-once";
    const reg = registry.register(sid, { toolName, reason, src: "sandbox" }, timeoutMs);
    try {
      writer?.push?.("confirm", { id: reg.id, toolName, reason, args: args || {}, sessionId: sid });
    } catch {
      // 推不出确认卡就没人能答：立刻按拒绝收口，不让工具空等到超时
      registry.settle?.(sid, reg.id, false);
    }
    return reg.promise;
  };
}
