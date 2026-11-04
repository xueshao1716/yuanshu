// ===== failure-note.mjs —— 失败要说人话（2026-11-04）=====
//
// 起因：模型 503 时她回「我这边出了点问题，稍后再发一次试试」——用户无从判断。
// 这个模块把底层错误翻成一句具体的、带原因的话。
export function describeFailure(raw, { tried = 0 } = {}) {
  const s = String(raw?.message || raw || "").trim();
  if (!s) return "这轮没做成，但没拿到具体原因（日志里也没记下）";
  const extra = tried > 1 ? `（试了 ${tried} 个通道）` : "";

  if (/(?:HTTP\s*)?503|服务不可用|overload/i.test(s)) return `模型服务 503 不可用${extra}，这轮没做成；不是你的问题，稍后重发即可`;
  if (/(?:HTTP\s*)?(?:429)/.test(s)) return `模型额度/频率被限（429）${extra}，这轮没做成`;
  if (/(?:HTTP\s*)?(?:401|403)/.test(s)) return `模型鉴权失败（401/403）${extra}，检查 key 是不是失效了`;
  if (/(?:HTTP\s*)?402/.test(s)) return `模型余额不足（402）${extra}，需要充值`;
  if (/fetch failed|ETIMEDOUT|ECONNRESET|network|socket/i.test(s)) return `网络断了${extra}，这轮没做成`;
  if (/timeout|超时/i.test(s)) return `执行超时${extra}，这轮没做成`;
  if (/deliver|交付门|RED/i.test(s)) return `活干完了但交付门没过：${s.slice(0, 80)}`;
  if (/abort|stop|interrupt/i.test(s)) return "这轮被中断了";
  return `这轮没做成：${s.slice(0, 100)}`;
}
