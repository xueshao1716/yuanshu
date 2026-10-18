// engine/cultivation/approval-flow.mjs —— 越线走授权的完整链路
//
// 背景（2026-10-18）：授权中心的「等我确认」只聚合 confirmRegistry，而 `cultivation-policy`
// 这个类型从来没有注册点；培养自己的会话授权又只给 60 秒窗口，是给"人在场点一下"设计的。
//
// 这里把链路收成一个模块：
//   申请 → 落盘（30 分钟有效）+ 注册卡片
//   批准 → 用**会话授权**（challenge→confirm）拿一次性凭证 → 执行那条命令
//   拒绝 → 记录，小语下次能看到原因
//
// 安全边界不变：会话授权的 allowedActions 仍是最终边界，批准也不能借此拿到工具/电脑/文件权限。
import { createRequest, settleRequest, findRequest } from './approval-requests.mjs';

export const APPROVAL_TTL_MS = 30 * 60 * 1000;

export function createApprovalFlow({ registry, wsRoot, runtime, ttlMs = APPROVAL_TTL_MS } = {}) {
  if (!registry || typeof registry.register !== 'function' || typeof registry.settle !== 'function')
    throw new Error('approval_flow_unavailable');
  if (!runtime) throw new Error('approval_flow_unavailable');

  function request({ sessionId, command, reason } = {}) {
    const sid = String(sessionId || '');
    if (!sid) throw new Error('没有会话上下文，无法提交授权申请');
    const row = createRequest(wsRoot, { sessionId: sid, command, reason });
    const reg = registry.register(sid, {
      toolName: 'cultivation-policy',
      src: 'cultivation-request',
      reason: `小语申请越线授权：${String(reason || '见策略差异').slice(0, 160)}`,
      meta: { requestId: row.id, action: String(command?.action || '') },
    }, ttlMs);
    return { requestId: row.id, cardId: reg.id };
  }

  async function approve(requestId, sessionId) {
    const req = findRequest(wsRoot, String(requestId || ''));
    if (!req) return { ok: false, error: '申请不存在' };
    if (req.status !== 'pending') return { ok: false, error: `申请已处理（${req.status}）` };
    if (req.sessionId !== String(sessionId || '')) return { ok: false, error: '申请不属于该会话' };
    if (Number(req.expiresAt) && Number(req.expiresAt) <= Date.now()) {
      settleRequest(wsRoot, requestId, 'expired', { by: '授权中心', note: '超过有效期未处理' });
      return { ok: false, error: '申请已过期，让她重新申请' };
    }
    const command = req.command;
    try {
      const ch = runtime.sessionChallenge(command, req.sessionId, { silent: true });
      // 人已经在授权中心点过确认：把同一份命令的内部凭证立即放行，不再推第二张弹框
      registry.settle(req.sessionId, ch.id, true);
      const proof = await runtime.sessionConfirm(ch.id, command, req.sessionId);
      const verified = runtime.verifySession(proof, command, req.sessionId);
      const result = await runtime.execute(command, verified.kind, verified.source);
      settleRequest(wsRoot, requestId, 'approved', { by: '授权中心' });
      return { ok: true, result };
    } catch (e) {
      settleRequest(wsRoot, requestId, 'rejected', { by: '授权中心', note: String(e?.message || e).slice(0, 120) });
      return { ok: false, error: String(e?.message || e).slice(0, 160) };
    }
  }

  function reject(requestId) {
    return settleRequest(wsRoot, requestId, 'rejected', { by: '授权中心' });
  }

  return { request, approve, reject };
}
