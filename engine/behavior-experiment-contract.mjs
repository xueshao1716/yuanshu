import { evidenceError, evidenceId } from './task-evidence-snapshot.mjs';
import { evidenceHash } from './task-evidence-artifacts.mjs';

export const RECORD_LIMIT = 256 * 1024;
export const EXPERIMENT_DIRECTORY = '记忆/运行时/行为实验';
export { evidenceError as experimentError, evidenceHash as experimentHash };
export function bounded(value) {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > RECORD_LIMIT) throw evidenceError('行为实验记录超过 256KiB 上限', 413);
  return value;
}
export function fields(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !names.includes(k)))
    throw evidenceError('行为实验字段无效或包含不支持的字段');
}
export function text(value, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw evidenceError('行为实验说明缺失或过长');
  return value.trim();
}
export function recordInput(input, allowSynthetic) {
  bounded(input);
  fields(input, ['experimentId', 'sourceKind', 'sessionId', 'hypothesis', 'baseline', 'variants']);
  if (!['real-task', 'synthetic-fixture'].includes(input.sourceKind) || input.sourceKind === 'synthetic-fixture' && !allowSynthetic)
    throw evidenceError('此入口仅接受真实任务，合成样本限隔离演练');
  const variant = value => {
    fields(value, ['runId', 'version']);
    return { runId: evidenceId(value.runId), version: text(value.version, 100) };
  };
  if (!Array.isArray(input.variants) || input.variants.length > 2) throw evidenceError('最多关联两个替代做法');
  const baseline = variant(input.baseline), variants = input.variants.map(variant);
  if (new Set([baseline, ...variants].map(v => v.runId)).size !== variants.length + 1) throw evidenceError('对照必须是不同的实际运行');
  return { experimentId: evidenceId(input.experimentId), sourceKind: input.sourceKind,
    sessionId: evidenceId(input.sessionId), hypothesis: text(input.hypothesis), baseline, variants };
}

export function comparisonState(record) {
  const attempts = [record.baseline, ...record.variants];
  const reasons = [];
  if (!record.variants.length) reasons.push('缺少替代做法');
  if (attempts.some(v => v.status !== 'completed' || v.failure)) reasons.push('存在失败、中断或尚未完成的尝试');
  if (attempts.some(v => v.validation.acceptance !== 'pass' || !v.validation.reviewable || v.validation.objective === 'FAIL')) reasons.push('缺少当前有效的独立验收');
  if (attempts.some(v => v.inputDigest !== record.baseline.inputDigest)) reasons.push('原始任务输入不同，不能直接比较');
  if (attempts.some(v => v.issues.length)) reasons.push('部分来源或交付证据不完整');
  const failed = attempts.some(v => ['failed', 'stopped', 'interrupted'].includes(v.status) || v.failure || v.validation.acceptance === 'fail' || v.validation.objective === 'FAIL');
  return { state: failed ? 'failed' : reasons.length ? 'incomplete' : 'comparable', reasons };
}
