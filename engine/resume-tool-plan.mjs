import { isDeepStrictEqual } from 'node:util';
import { toolCallsFromPlan } from './yuanshu-loop.mjs';

// The durable plan, not the size-bounded history view, owns pending arguments.
// Rebuild one complete exchange before executing; never append a second call
// group between a retained assistant message and its outstanding results.
export function restorePendingToolPlan(history, plan) {
  const planned = toolCallsFromPlan(plan);
  if (!planned.length) return [];
  const plannedIds = new Set(planned.map(call => call.id));
  const results = new Map(history.filter(m => m.role === 'tool').map(m => [m.tool_call_id, m]));
  const groups = history.filter(m => m.role === 'assistant' && (
    m.tool_calls?.some(call => plannedIds.has(call.id)) ||
    m.anthropic_content?.some(block => block.type === 'tool_use' && plannedIds.has(block.id))
  ));
  const calls = new Map();
  for (const group of groups) {
    for (const call of group.tool_calls || []) {
      if (results.has(call.id) || plannedIds.has(call.id)) calls.set(call.id, call);
    }
  }
  for (const call of planned) calls.set(call.id, call);
  const allCalls = [...calls.values()];
  const assistant = { role: 'assistant', content: groups[0]?.content ?? null, tool_calls: allCalls };
  // DeepSeek 思考模式：带 tool_calls 的 assistant 必须回传 reasoning_content，否则 400。
  // 续跑时把原响应里的推理原样接回；来源不止一条时无法拼成合法前缀，宁可不带。
  if (groups.length === 1 && typeof groups[0]?.reasoning_content === 'string' && groups[0].reasoning_content) {
    assistant.reasoning_content = groups[0].reasoning_content;
  }
  // Preserve an intact native signed response only when it describes exactly
  // this exchange. Never edit/truncate signed blocks to manufacture a match.
  const native = groups.length === 1 ? groups[0].anthropic_content : null;
  if (Array.isArray(native) && isDeepStrictEqual(
    native.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input: b.input })),
    allCalls.map(c => ({ id: c.id, name: c.function.name, input: JSON.parse(c.function.arguments) })),
  )) {
    assistant.anthropic_content = structuredClone(native);
    assistant.anthropic_model = groups[0].anthropic_model;
  }
  const groupSet = new Set(groups);
  const retained = history.filter(m => !groupSet.has(m) && !(m.role === 'tool' && calls.has(m.tool_call_id)));
  history.length = 0;
  history.push(...retained, assistant, ...allCalls.flatMap(call => results.has(call.id) ? [results.get(call.id)] : []));
  return planned.filter(call => !results.has(call.id));
}
