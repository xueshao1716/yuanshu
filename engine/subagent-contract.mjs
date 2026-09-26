import { estimateHistoryTokens } from './context-headroom.mjs';
import { clampOutputTokens } from './output-budget.mjs';

export const RESULT_SCHEMA = '{"result":"完整任务正文（字符串）","evidence":["关键证据"],"confidence":0.8}';
export const DELEGATE_CONTRACT = '仅分析已提供的文本：对比、摘要、规划或审阅。不联网、不读文件、不看图片、不运行命令、不生成真实媒体；检索或执行由主代理完成后提供必要材料。内部返回 ' + RESULT_SCHEMA + '；需要列表或业务 JSON 时写入 result 字符串。task 最多8000字符，context 最多8条、每条2000字符；超限会明确拒绝，不会静默删尾。输出 token 按模型能力有界分配，不保证等量字符；长任务拆成独立子任务。';

export function subagentError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function explicitSubagentInput({ task, context = [], seed = [], longForm = false }) {
  const maxTask = longForm ? 24000 : 8000;
  if (typeof task !== 'string' || !task.trim()) throw subagentError('invalid_input', '子任务需要非空 task 字符串');
  if (task.length > maxTask || !Array.isArray(context) || context.length > 8 || context.some(c => typeof c !== 'string' || c.length > 2000)) {
    throw subagentError('input_limit', `子任务输入超过上限或类型不符：task 最多 ${maxTask} 字符；context 最多 8 条字符串、每条 2000 字符。请拆分或提供精炼材料，不会静默截断。`);
  }
  const history = Array.isArray(seed) ? seed.filter(s => s && ['user', 'assistant'].includes(s.role) && typeof s.content === 'string' && s.content.trim()).map(s => ({ role: s.role, content: s.content })) : [];
  // Team seeds also carry the complete accepted draft (up to 24000 characters)
  // and review findings. Keep them intact; the model-window preflight still applies.
  const maxSeedChars = longForm ? 48000 : 12000;
  if (history.length > 24 || history.reduce((n, s) => n + s.content.length, 0) > maxSeedChars) {
    throw subagentError('context_limit', `子任务继承上下文超过上限（24条 / ${maxSeedChars}字符），请先缩减前文；未发送模型请求。`);
  }
  return [...history, ...context.map(content => ({ role: 'user', content })), { role: 'user', content: task }];
}

export function subagentBudget(model, messages, { longForm, reasoningEffort } = {}) {
  const desired = longForm ? (['medium', 'high'].includes(reasoningEffort) ? 12000 : 7000) : model?.reasoning ? 8192 : 4096;
  const declaredBudget = clampOutputTokens(model, { fallback: desired, ceiling: desired });
  // Estimate only: not a provider tokenizer. Reserve framing/safety space explicitly.
  const inputTokensEstimate = estimateHistoryTokens(messages) + messages.length * 16;
  const window = Number(model?.contextWindow);
  const room = Number.isFinite(window) && window > 0 ? Math.floor(window) - inputTokensEstimate - 512 : Infinity;
  const outputBudget = Math.min(declaredBudget, room);
  if (outputBudget < Math.min(1024, declaredBudget)) throw subagentError('context_limit', `子任务上下文余量不足：估算输入 ${inputTokensEstimate} token，窗口 ${window} token（含安全余量），请缩减材料；未发送模型请求。`);
  return { outputBudget, inputTokensEstimate };
}

export function subagentResponseDiagnostics(response, base) {
  const usage = response?.usage || {};
  const count = value => Number.isFinite(value) && value >= 0 ? value : null;
  return { ...base, finishReason: response?.finishReason || '',
    inputTokens: count(usage.input_tokens ?? usage.prompt_tokens),
    outputTokens: count(usage.output_tokens ?? usage.completion_tokens),
    reasoningTokens: count(usage.completion_tokens_details?.reasoning_tokens),
    usedModel: response?.usedModel ? `${response.usedModel.provider}/${response.usedModel.id}` : '' };
}

export function parseSubagentResult(response, { outputFormat, maxChars, outputBudget }) {
  if (['length', 'max_tokens'].includes(response?.finishReason) || response?.errorCode === 'output_limit') {
    throw subagentError('output_limit', `子任务输出预算耗尽（本次请求上限 ${outputBudget} token，可能包含推理），未把截断正文当作完整交付。请减少单次交付范围或拆分任务；不等于输入上下文超限。`);
  }
  if (response?.error) throw subagentError('upstream_error', response.error);
  if (!response?.text?.trim()) throw subagentError('empty_output', '子任务无回复正文，未当作完成；请检查通道与推理用量。');
  let parsed;
  if (outputFormat === 'text') parsed = { result: response.text, evidence: [], confidence: 0 };
  else {
    let text = response.text.trim();
    const fence = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
    if (fence) text = fence[1].trim();
    try { parsed = JSON.parse(text); } catch { /* explicit invalid_output below */ }
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed.result !== 'string' || !parsed.result.trim()) {
    throw subagentError('invalid_output', `输出不是预期 JSON 结构：期望 ${RESULT_SCHEMA}；列表或业务对象请放进 result 字符串。未收到明确截断标记，不能判定为上下文溢出。`);
  }
  if (parsed.result.length > maxChars) throw subagentError('output_limit', `子任务正文超过 ${maxChars} 字符上限，未截断发布；请拆分交付。`);
  return parsed;
}
