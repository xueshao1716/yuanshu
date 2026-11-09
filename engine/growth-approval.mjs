// engine/growth-approval.mjs —— 换代/回滚的"现有人工确认"接线（2026-11-09）
//
// 与 gene-approval / persona-approval 同一套边界，不新造一套审批：
//   · 必须在一个**有效会话**里等确认（sessionId 由调用方给，服务端校验会话存在）；
//   · 确认卡走 confirmRegistry + busPush，前台点"允许"才放行一次（allowed-once）；
//   · approvedBy 由服务端**自己铸**（human-confirm:<sessionId>:<确认编号>），
//     绝不采信请求体里传进来的 approvedBy——否则任何调用方都能冒充人；
//   · 确认期间成长状态变了（比如又推进了一代）→ stale_confirmation，要求重新审查。
//
// 这里只做"等人点头 + 冻结指纹"，真正的 generation 变更在 genome-growth.promote/rollback。

export const GROWTH_TOOL_NAME = "growth-governance";
export const GROWTH_ACTIONS = Object.freeze(["promote", "rollback"]);

function fingerprintOf(state) {
  return JSON.stringify({
    generation: state?.generation,
    dims: state?.dims,
    pending: state?.pending?.id || null,
    generations: (state?.generations || []).map((g) => g?.gen),
  });
}

const fmtDims = (dims) =>
  Object.entries(dims || {})
    .map(([k, v]) => `${k}=${Number(v).toFixed(2)}`)
    .join(" ");

export function createGrowthApproval({ api, registry, sessionExists, push, timeoutMs = 60000 }) {
  let active = false;
  return async (action, body = {}) => {
    if (!GROWTH_ACTIONS.includes(action)) return { error: "不支持的成长操作", code: "invalid_action" };
    if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "成长操作请求必须为对象", code: "invalid_request" };
    const sid = body.sessionId;
    if (typeof sid !== "string" || !sid || !sessionExists(sid)) {
      return { error: "需要有效会话中的人工确认（缺少 sessionId 或会话不存在）", code: "confirmation_required" };
    }
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 2000) : "";
    if (action === "rollback" && !reason) return { error: "请填写回滚理由", code: "reason_required" };

    const before = api.status({ includeSources: false });
    if (action === "promote" && !before.pending) return { error: "没有待批的换代提案", code: "no_pending_proposal" };
    if (action === "rollback" && !(before.generations || []).length) return { error: "没有可回退的上一代", code: "no_previous_generation" };
    if (active) return { error: "已有一次换代确认在等待", code: "confirmation_pending" };

    let reg;
    try {
      active = true;
      const detail = action === "promote"
        ? `批准换代：第 ${before.generation} 代 → 第 ${before.generation + 1} 代；旧值 ${fmtDims(before.pending?.dims)}；新值 ${fmtDims(before.pending?.nextDims)}；理由：${before.pending?.reason || reason || "（未填）"}`
        : `回滚到第 ${Math.max(0, before.generation - 1)} 代：当前 ${fmtDims(before.dims)}；理由：${reason}`;
      const fingerprint = fingerprintOf(before);
      reg = registry.register(sid, { toolName: GROWTH_TOOL_NAME, reason: detail, src: GROWTH_TOOL_NAME, action }, timeoutMs);
      push(sid, "confirm", {
        id: reg.id,
        sessionId: sid,
        toolName: GROWTH_TOOL_NAME,
        reason: detail,
        expiresAt: Date.now() + timeoutMs,
      });
      if (await reg.promise !== "allowed-once") return { error: "人工未批准或确认已过期（未改动世代）", code: "confirmation_denied" };
      const after = api.status({ includeSources: false });
      if (fingerprintOf(after) !== fingerprint) {
        return { error: "确认期间成长状态发生变化（换代/提案/回滚），请重新审查", code: "stale_confirmation" };
      }
      const approvedBy = `human-confirm:${sid}:${reg.id}`;
      return action === "promote"
        ? api.promote({ approvedBy, reason })
        : api.rollback({ approvedBy, reason });
    } catch (error) {
      return { error: String(error?.message || error).slice(0, 200), code: "growth_governance_failed" };
    } finally {
      if (reg) registry.settle(sid, reg.id, false);
      active = false;
    }
  };
}
