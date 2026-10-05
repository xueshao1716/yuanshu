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

// 行为信号：只喂基因观测，不进情绪向量。覆盖关键词表报不到的两类状态：
//   task_deep       —— 有结构证据在干重活：代码块 / 文件路径 / 报错文本 / ≥ 2 个不同技术词。
//                      长消息本身不算（出图提示词很长，却不是重活）。
//   user_frustrated —— 只认「反复失败」的说法。「为什么/为啥」和多个问号是好奇或求解释，
//                      真实消息里约一半不是受挫（2026-10-05 用 669 条真实消息核对），不当信号。
const TECH_TERMS = /链路|调用|函数|脚本|排查|报错|权限|部署|接口|代码|字段|参数|源码|提交|分支|依赖|配置|测试|端口|进程|日志|编译|构建|类型|模块|数据库|请求|返回值/g;
const ERROR_TEXT = /\b(?:Error|Exception|Traceback)\b|\bTS\d{4}\b|\bE[A-Z]{3,}\b|\b[45]\d{2}\b(?=\s*(?:错误|报错|Not|Bad|Internal|Unauthorized|Forbidden))/;
const FILE_PATH = /(?:^|[\s(（"'`])(?:[A-Za-z]:)?[\\/]?(?:[\w.\-]+[\\/])+[\w.\-]+\.(?:mjs|cjs|js|tsx?|py|json|md|html|css|ya?ml|toml|ps1|sh)\b/i;
const REPEATED_FAILURE = /还是(?:不行|报错|失败|没反应|没用|卡)|又(?:坏|挂|错|卡|崩|失败|白屏)|怎么又|怎么回事|咋回事|搞不定|弄不好|用不了|登不上|卡死|白屏了|返工|全失败/;

export function behaviorCues(message) {
  const raw = String(message || '').slice(0, 32000);
  const text = cueText(raw); // 引用/行内代码里的词不算用户自己的话
  const tags = [];
  const terms = new Set(text.match(TECH_TERMS) || []);
  if (/```/.test(raw) || FILE_PATH.test(raw) || ERROR_TEXT.test(raw) || terms.size >= 2) tags.push('task_deep');
  if (REPEATED_FAILURE.test(text)) tags.push('user_frustrated');
  return tags;
}
