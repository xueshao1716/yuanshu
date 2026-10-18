// 2026-10-18：运行期授权判定。
//
// 此前 tasks.mjs 的 assertRun 用「控制面 revision 必须与启动时完全相等」来判断：
//   if (state.revision !== run.cultivation.policyRevision) fail('policy_changed')
// 而 revision 是**整个控制面**的版本号——别人提交一份设计稿、注册另一个个体、
// 做一次学习裁决，都会推进它，于是在跑的任务被以 policy_changed 终止。
// 真机上 5 次停止就是这么来的（用户侧体感是"莫名其妙停了"）。
//
// 这里把判定换成「当前策略是否仍然授权这一次运行」：只有真正跨越授权边界的变更才终止。
// 策略被暂停、过期、模型被移出白名单、远端被关——这些必须停；
// 额度上调、时间窗调整、别的个体注册——不该打断已经在跑的任务。
function denied() {
  return {ok: false, code: 'policy_changed'};
}

/**
 * @param {{policy?: object, design?: object, run?: object, atMs?: number}} input
 * @returns {{ok: true} | {ok: false, code: 'policy_changed'}}
 */
export function runAuthorization({policy, design, run, atMs = Date.now()} = {}) {
  if (!policy || policy.enabled !== true) return denied();
  const expiresAt = Date.parse(policy.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt <= atMs) return denied();
  // 空白名单视为"不允许任何模型"（受限预设就是这个语义），已启动的运行同样失效。
  const models = Array.isArray(policy.models) ? policy.models : [];
  const model = run?.input?.model;
  if (!models.length) return denied();
  if (model && !models.includes(model)) return denied();
  // 远端能力被关闭时，远端的运行必须停；本地运行不受影响。
  if (design?.permissions?.remote === true && policy.allowRemote !== true) return denied();
  return {ok: true};
}

// 策略里"会改变授权边界"的字段快照：用于把无关变更与实质变更分开（诊断与测试共用）。
export function authorizationBoundary(policy = {}) {
  return {
    enabled: policy.enabled === true,
    expiresAt: policy.expiresAt ?? null,
    models: Array.isArray(policy.models) ? [...policy.models].sort() : [],
    allowRemote: policy.allowRemote === true,
  };
}
