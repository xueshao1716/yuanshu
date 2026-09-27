// engine/board-api.mjs —— 工作台首屏「一条打包」（2026-09-20）
// 动机：外网每个请求 ~0.8s（隧道往返），工作台首屏要打 9 条接口 → 累计等 6 秒以上。
// 做法：**复用同一批 handler**（用 shim 捕获它们写给 res 的 JSON）合并成一条响应，不重写业务逻辑，
//       避免两份实现漂移。依赖由 server.mjs 注入。
export function createBoardApi(deps) {
  const cap = async (fn) => {
    const parts = [];
    const shim = {
      writeHead: () => {}, setHeader: () => {}, getHeader: () => undefined,
      write: (b) => { parts.push(b); return true; },
      end: (b) => { if (b) parts.push(b); },
      get statusCode() { return 200; }, set statusCode(_v) {}, get headersSent() { return false; },
    };
    try { await fn(shim); } catch (e) { return { __error: String((e && e.message) || e).slice(0, 120) }; }
    try { return JSON.parse(parts.join("")); } catch { return null; }
  };

  return {
    async bootstrap(res) {
      const { json, handlers, runApi, emotion, getSessionList, isListedGroup } = deps;
      const url = new URL("http://local/api/run/overview");
      const [providers, daily, subagent, deliveries, overview, tide, feelings] = await Promise.all([
        cap((s) => handlers.handleProviderStats(s)),
        cap((s) => handlers.handleDailyStats(s)),
        cap((s) => handlers.handleSubagentRuns(s)),
        cap((s) => handlers.handleWsDeliveries(s)),
        cap((s) => runApi.overview(s, null, url)),
        cap((s) => json(s, 200, { tide: emotion.getTide(300) })),
        cap((s) => json(s, 200, { feelings: emotion.getFeelings(50) })),
      ]);
      let sessions = [];
      try { sessions = getSessionList().filter((s) => isListedGroup(s.group)); } catch {}
      return json(res, 200, {
        sessions, providers, daily, subagent, deliveries, overview, tide, feelings,
        at: new Date().toISOString(),
        note: "首屏一条打包；单条接口仍在（可单独刷新）",
      });
    },
  };
}
