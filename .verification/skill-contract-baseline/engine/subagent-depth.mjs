// ===== subagent-depth.mjs —— 子智能体嵌套深度闸门（借 dsh-subagent/types/depth.js:18-25）=====
//
// dsh 的规矩：子深度 = 父深度 + 1，但最终取 **max(持久化 header, 运行期 options)**，
// 也就是**运行期只能加深、不能降低**。理由很实在：一个被恢复的子智能体如果按 0 重算
// 深度，maxDepth 这道闸门就形同虚设——它可以一级级无限派下去，而每一级都以为自己是第 1 层。
//
// 单用户桌面场景下这条同样成立：`delegate_task` 是模型可调的工具，模型完全可以
// 递归派活。没有这条闸门，"最多 3 层"只是一句无人执行的声明。
export const DEFAULT_MAX_DEPTH = 3;

/**
 * @param {number} parentDepth 父智能体深度（宿主为 0）
 * @param {{maxDepth?:number, runtimeDepth?:number|null}} opts
 * @returns {{depth:number, allowed:boolean, reason?:string}}
 */
export function nextSubagentDepth(parentDepth = 0, { maxDepth = DEFAULT_MAX_DEPTH, runtimeDepth = null } = {}) {
  const parent = Number.isFinite(Number(parentDepth)) ? Math.max(0, Math.floor(Number(parentDepth))) : 0;
  const runtime = runtimeDepth === null || runtimeDepth === undefined ? 0 : Math.max(0, Math.floor(Number(runtimeDepth) || 0));
  // 只能加深，不能降低：取两者较大值
  const depth = Math.max(parent + 1, runtime);
  const rawCap = Number(maxDepth);
  const cap = Number.isFinite(rawCap) && rawCap >= 1 ? Math.floor(rawCap) : DEFAULT_MAX_DEPTH;
  if (depth > cap) return { depth, allowed: false, reason: `子智能体嵌套超过上限 ${cap} 层（本轮为第 ${depth} 层）` };
  return { depth, allowed: true };
}
