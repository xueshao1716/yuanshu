// engine/agent-pending.mjs —— 未决确认"总览"聚合（2026-10-11 授权中心修归属混乱）
// 背景：确认卡都落在 confirm-registry（内存），但历史上只暴露了按会话过滤的
// persona/gene 查询（/api/soul/confirmations）和各面板自己的卡（超维/电脑）。
// 之前想要"等我确认"一区收齐，却只能靠人挑会话再逐个看——归属靠人填。
// 这个模块把注册表一次性摊开：卡片带着"它属于哪条对话"进来，不用人再挑。
// 安全边界不变：本机受限类（人格/基因/电脑/超维）远程只能看和拒，批准仍在 /api/agent/confirm 里拦。

const KINDS = new Map([
  ['persona-governance', ['人格变更', true]],
  ['gene-governance', ['性格基因变更', true]],
  ['cultivation-policy', ['培养策略（一次性）', false]],
  ['maintenance', ['超维模式', true]],
  ['computer-use', ['电脑操作', true]],
]);

export function pendingKind(toolName) {
  const hit = KINDS.get(String(toolName));
  if (hit) return { label: hit[0], localOnly: hit[1] };
  return { label: String(toolName || '确认'), localOnly: false }; // 工具 ask / 沙箱 ask 等走通用弹框，未见过的类型不乱标本机受限
}

export function pendingOverview({ registry, now = Date.now, localApprovalOk = false } = {}) {
  const rows = Array.isArray(registry?.list?.()) ? registry.list() : [];
  const items = rows
    .filter(row => row && row.sessionId && row.id)
    .map(row => {
      const kind = pendingKind(row.toolName);
      return {
        id: String(row.id),
        sessionId: String(row.sessionId),
        toolName: String(row.toolName || ''),
        kind: kind.label,
        localOnly: kind.localOnly,
        canApprove: kind.localOnly ? !!localApprovalOk : true,
        src: String(row.src || ''),
        reason: String(row.reason || '未写明原因'),
        // 培养越线申请带申请号：授权中心批准时靠它去执行那一条命令
        ...(row.meta && typeof row.meta === 'object' ? { meta: row.meta } : {}),
        expiresAt: Number(row.expiresAt) || 0,
      };
    })
    .sort((a, b) => a.expiresAt - b.expiresAt); // 最快过期的排最前，越晚答越没得选的先看
  return { ok: true, canApproveLocally: !!localApprovalOk, count: items.length, items };
}

export default { pendingKind, pendingOverview };
