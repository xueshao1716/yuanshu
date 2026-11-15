// 主对话链空闲看门狗（2026-11-15）
// 背景：直连路径早有 idleTimeout，但主链 agent.prompt 只在客户端断开时 abort——
// 上游流卡住、客户端又没断，就会一直挂着（10 月实测挂了 23 分钟才报错，会话全程 busy）。
// 口径：任何 agent 事件都算"有动静"；工具执行期间暂停计时（长命令本来就久，不能误杀）。

export const DEFAULT_CHAT_IDLE_MS = 180_000;

/** 订阅 agent 事件，超过 ms 没动静就 abort 一次。返回 stop()，必须在本轮结束时调用。 */
export function watchAgentIdle(agent, { ms = DEFAULT_CHAT_IDLE_MS, onIdle = null } = {}) {
  let timer = null;
  let toolsRunning = 0;
  let stopped = false;
  const arm = () => {
    clearTimeout(timer);
    if (stopped || toolsRunning > 0) return;
    timer = setTimeout(() => {
      if (stopped) return;
      stopped = true;
      try { agent.abort(); } catch {}
      try { onIdle?.(ms); } catch {}
    }, ms);
    timer.unref?.();
  };
  const unsubscribe = agent.subscribe(event => {
    if (event?.type === 'tool_execution_start') toolsRunning++;
    else if (event?.type === 'tool_execution_end') toolsRunning = Math.max(0, toolsRunning - 1);
    arm();
  });
  arm();
  return () => {
    stopped = true;
    clearTimeout(timer);
    try { unsubscribe?.(); } catch {}
  };
}
