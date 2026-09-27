// 单次输出预算（2026-09-16）。
//
// 真机现象：经常报「工具调用被截断（多半是输出超长），请把任务拆小再试」。
// 根因不是任务长，是**我们自己的上限太低**：模型明明声明 32k~384k 输出，
// 而 \`unified-chat\` 与 \`model-adapter\` 都写死 \`Math.min(mdef?.maxTokens || 8192, 8192)\`——
// 于是"一次写完一个大文件/长脚本"必然在 8192 token 处被砍，工具调用参数断成半个 JSON，
// 守卫判定 truncated，重试两次后把锅甩给用户（"请把任务拆小"）。
//
// 这里统一算预算：起步给到模型声明的量（但有保险丝，别把 384k 原样发出去），
// 命中截断时允许往上抬到模型声明的上限。字段名也走 compat（有的通道要 max_completion_tokens）。
export const OUTPUT_TOKEN_FALLBACK = 8192;
export const OUTPUT_TOKEN_CEILING = 32768;   // 起步上限：32k 输出 ≈ 2.4 万汉字，一次写文件足够
export const OUTPUT_TOKEN_HARD_CAP = 131072; // 截断重试时最多抬到这里

export function clampOutputTokens(mdef, { fallback = OUTPUT_TOKEN_FALLBACK, ceiling = OUTPUT_TOKEN_CEILING } = {}) {
  const n = Number(mdef?.maxTokens);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(Math.floor(n), ceiling));
}

// 截断后的下一次预算：翻倍，但不超过「模型声明」与硬上限。
export function escalateOutputTokens(current, mdef, { hardCap = OUTPUT_TOKEN_HARD_CAP } = {}) {
  const declared = Number(mdef?.maxTokens);
  const limit = Number.isFinite(declared) && declared > 0 ? Math.min(Math.floor(declared), hardCap) : hardCap;
  const next = Math.max(Math.floor(Number(current) || OUTPUT_TOKEN_FALLBACK) * 2, OUTPUT_TOKEN_FALLBACK + 4096);
  return Math.max(1, Math.min(next, limit));
}

export function maxTokensFieldOf(compat) {
  const f = String(compat?.maxTokensField || "").trim();
  return f || "max_tokens";
}
