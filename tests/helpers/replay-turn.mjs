// Bind archived run events to their own user turn, even when the session has continued.
export function historyForRun(history, events) {
  const ids = new Set(events.filter(event => event.type === 'tool').map(event => event.data?.id).filter(Boolean));
  const indexes = history.flatMap((message, index) => message.tools?.some(tool => ids.has(tool.id)) ? [index] : []);
  if (!indexes.length) throw new Error('回放工具不在所选会话历史中，拒绝混用最新一轮');
  const first = indexes[0];
  let start = first;
  while (start >= 0 && history[start].role !== 'user') start--;
  if (start < 0) throw new Error('回放缺少用户轮次起点');
  let end = first + 1;
  while (end < history.length && history[end].role !== 'user') end++;
  if (indexes.some(index => index >= end)) throw new Error('回放工具跨越多个用户轮次');
  const turn = history.slice(start, end);
  const found = new Set(turn.flatMap(message => (message.tools || []).map(tool => tool.id)));
  if ([...ids].some(id => !found.has(id))) throw new Error('回放轮次缺少工具记录');
  return turn;
}
