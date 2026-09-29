// Conservative keyword heuristics, not semantic emotion/personality measurement.
export function cueText(message) {
  return String(message || '').slice(0, 32000)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^[ \t]*>.*$/gm, ' ')
    .replace(/[“「][^”」]*[”」]|"[^"\n]*"|`[^`\n]*`/g, ' ');
}

export function cueMatches(text, word, tag) {
  for (const sentence of text.split(/[。！？!?\n;]/)) {
    if (tag === 'task_accomplish' && /请|希望|如果|假如|能否|是否|需要|还要|要不要|帮我|给我|怎么|如何|尽快|赶紧|快点/.test(sentence)) continue;
    for (const clause of sentence.split(/[，,；]/)) {
      let start = 0;
      while (start < clause.length) {
        const at = clause.indexOf(word, start);
        if (at < 0) break;
        start = at + word.length;
        const before = clause.slice(Math.max(0, at - 12), at);
        if (/(?:不|没|未|无|别|莫|并非|不是|不能|尚未|不要)[^，。！？!?]{0,6}$/.test(before)) continue;
        if (tag === 'task_accomplish') {
          const after = clause.slice(start, start + 6);
          if (/^(?:了)?[吗么？?]|^(?:不了|失败|前|后再)/.test(after)) continue;
          if (!/已|终于|确实|确认|顺利/.test(before) && !/^了|^成功/.test(after) && !/^(?:搞定|全绿|成功)$/.test(clause.trim())) continue;
        }
        return true;
      }
    }
  }
  return false;
}
