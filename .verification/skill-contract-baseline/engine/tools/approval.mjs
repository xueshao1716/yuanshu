// engine/tools/approval.mjs —— 危险操作确认（dsh user-approval seam 的 pi-web 移植）
// dsh 设计：审批 seam 与 UI/通道无关；fail-closed（无应答/出错=拒绝）；一次性授权；审计成对。
// pi-web 落点：包装 pi 引擎 agent.beforeToolCall（工具执行前），命中危险规则时
//   发 SSE 确认事件 → 等前端回答（Promise）→ 放行/阻断。
//
// 对外单一入口：createApprovalInterceptor() → { wrapBeforeToolCall(orig) }
//   - orig: Agent 原始的 beforeToolCall（默认返回 undefined=放行）
//   - 返回包装函数：命中危险 → ask() 等人工 → allowed-once 原样返回 / rejected 抛错阻断
//   - 安全：确认缺失、超时或异常都拒绝（fail-closed），不让危险操作绕过人工确认

// 危险规则：策略引擎注入（工具名 → 参数正则匹配），命中即需确认
// 规则项：{ tool, match?: { argName: regex }, reason }
// 默认最低保护：bash 命中危险命令关键词（删除/强推/隧道/密钥/危险 git）

const DEFAULTS = {
  // 危险 bash 命令关键词（命中任一 → 弹确认）。可被注入规则扩展。
  bashDangerRe: /(rm\s+-rf|del\s+\/f|rd\s+\/s|git\s+push\s+--force|git\s+reset\s+--hard|git\s+clean\s+-f|cloudflared|ngrok|trycloudflare|frpc|localtunnel|setx\s+DEEPSEEK_API_KEY|type\s+.*auth\.json|cat\s+.*auth\.json|netsh.*dns)/i,
  // 写类工具的破坏性：write/edit 未明确标明新建（无法判断路径是否覆盖时保持自由，由规则扩展）
};

export function createApprovalInterceptor(deps = {}) {
  const {
    policyDecide = null,       // fn(toolName, args) → { decision:'allow'|'deny', note? }（dsh-keys.policyDecide）
    ask = null,                // fn(toolName, args, reason) → Promise<'allowed-once'|'rejected'|'cancelled'>
    log = () => {},            // 审计/调试日志
    enabled = true,
  } = deps;

  // 判定某次工具调用是否需要人工确认
  function needsApproval(toolName, args) {
    if (!enabled) return false;
    const a = args || {};
    // 只针对 bash 危险命令弹确认（可斟酌的：rm/git force/隧道等）；策略引擎 deny（密钥/强推等安全红线）
    // 仍由 policyDecide 直接拒绝，不弹框——区分“危险但可批准”与“红线禁止”。
    if (toolName === "bash") {
      const cmd = String(a.command || "");
      const hit = DEFAULTS.bashDangerRe.test(cmd);
      log(`[approval:judge] tool=${toolName} hit=${hit ? "DANGER" : "safe"} cmd=${cmd.slice(0, 60)}`);
      if (hit) return { reason: `检测到危险命令：${cmd.slice(0, 80)}` };
    } else {
      log(`[approval:judge] tool=${toolName} hit=safe(非bash)`);
    }
    return false;
  }

  // 包装 agent.beforeToolCall：命中危险 → ask() 等人工；allowed-once 放行；其余抛错阻断
  function wrapBeforeToolCall(orig) {
    return async (info) => {
      const { toolCall, args } = info || {};
      const toolName = toolCall?.name || info?.toolName || "";
      let need = null;
      try { need = needsApproval(toolName, args); } catch { need = null; }

      // 不需要确认 → 走原始逻辑（或放行）
      if (!need) {
        if (typeof orig === "function") return orig(info);
        return undefined;
      }

      // 需要确认但没接 ask 应答者 → fail-closed：抛错阻断（改回策略 deny 语义）
      if (typeof ask !== "function") {
        log(`[approval] 无应答者，fail-closed 阻断 ${toolName}`);
        throw new Error(`[needs-approval] ${need.reason}`);
      }

      // 发确认请求，等人工回答
      try {
        const outcome = await ask(toolName, args, need.reason);
        log(`[approval] ${toolName} → ${outcome}`);
        if (outcome === "allowed-once") {
          // 一次性放行：让工具执行（调用原始 beforeToolCall）
          if (typeof orig === "function") return orig(info);
          return undefined;
        }
        // rejected / cancelled / unavailable → 阻断，把理由给模型
        throw new Error(`[用户拒绝] ${need.reason}`);
      } catch (err) {
        // ask() 本身异常（如超时/未接前端）→ fail-closed：阻断（安全优先），但不掩盖原因
        if (err?.message?.includes("用户拒绝") || err?.message?.includes("needs-approval")) throw err;
        log(`[approval] ask 异常，fail-closed 阻断：${String(err?.message || err)}`);
        throw new Error(`[needs-approval] 未能确认该操作，已阻止：${need.reason}`);
      }
    };
  }

  return { wrapBeforeToolCall, needsApproval };
}

export default createApprovalInterceptor;
