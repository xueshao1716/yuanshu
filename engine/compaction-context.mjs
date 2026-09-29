// Compact only the model view. Original messages and tool result pairs stay intact.
const isSummary = m => m._section === 'compaction' || String(m.content || '').startsWith('【早前对话摘要】');
export function partitionCompaction(history, keep = 10) {
  let start = Math.max(0, history.length - keep);
  // Move the boundary back to each retained result's producer, including parallel calls.
  for (let previous = -1; previous !== start;) {
    previous = start;
    for (let i = start; i < history.length; i++) {
      const id = history[i].tool_call_id;
      if (!id) continue;
      const producer = history.findIndex(m => m.tool_calls?.some(c => c.id === id));
      if (producer >= 0 && producer < start) start = producer;
    }
  }
  const lastUser = history.findLastIndex(m => m.role === 'user');
  const system = [], retained = [], old = [];
  history.forEach((m, i) => {
    if (['system', 'developer'].includes(m.role) && !isSummary(m)) system.push(m);
    else if (!isSummary(m) && (i >= start || i === lastUser)) retained.push(m);
    else old.push(m);
  });
  return { system, retained, old };
}

export function validCompactionSummary(result) {
  if (result?.error || typeof result?.text !== 'string') return false;
  const text = result.text.trim();
  // The six requested sections distinguish a summary from an empty-input/error reply.
  return text.length > 20 && [1, 2, 3, 4, 5, 6].every(n =>
    new RegExp(`(?:^|\\n)\\s*${n}[.、．):：]`).test(text));
}
