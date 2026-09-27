// 工具调用 arguments 的规范化（2026-09-16）。
//
// 真机故障：workbuddy/hy4-preview 报 HTTP 400 code 11133「请求参数不符合当前模型要求」，
// 同一批历史在 opencode-go 上则报 "Messages with role 'tool'"。逐字段拆下来定位到：
// **某条 assistant(tool_calls) 的 arguments 被双重编码**——它本身是一个 JSON 字符串字面量
// （`"{\"program\": \"const fs = require('fs')…\"}"`，parse 出来是 string 而不是 object），
// OpenAI 兼容端要求 arguments 必须是"能 parse 成对象的 JSON 文本"，于是整轮请求被拒。
//
// 实测（同一段真实历史，只改 arguments）：
//   arguments 原样（双重编码）            → 400
//   arguments = 550 个 a（不是合法 JSON）  → 400
//   arguments = 550 字的合法 JSON 对象     → 200 ✅
//   arguments = {}                        → 200 ✅
//
// 来源：历史里的 args 本来就是字符串，`formatSessionHistory` 又 JSON.stringify 了一次
// （`JSON.stringify(t.args)` → 带引号的字符串），模型通道那边同样可能把流式分片拼成字符串。
// 所以统一走这里：能解成对象就用对象；是字符串就再解一层；实在不行包成 {raw: ...}——
// 历史里那次调用早就执行完了，重放只需要它**语法合法**，绝不能让一条坏记录把整轮请求打死。

const MAX_RAW = 4000;

export function normalizeToolArgs(raw) {
  let s = "";
  if (typeof raw === "string") s = raw.trim();
  else if (raw == null) return "{}";
  else { try { s = JSON.stringify(raw); } catch { return "{}"; } }
  if (!s) return "{}";

  // 最多解三层字符串包裹（历史上出现过 string(JSON(string(JSON)))）
  for (let depth = 0; depth < 3; depth++) {
    // 脏前缀修复（沿用 repairToolArgs 的老行为）：`{}{"path":"/tmp/a.txt"}` 这种情况，
    // 前面那个空对象是上游分片错位留下的，先剥掉再解。
    while (/^\{\s*\}\s*(?=\{)/.test(s)) s = s.replace(/^\{\s*\}\s*/, "");
    let parsed;
    try { parsed = JSON.parse(s); } catch { break; }   // 不是合法 JSON → 交给下面的兜底
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return JSON.stringify(parsed);
    if (typeof parsed === "string") { s = parsed.trim(); if (!s) return "{}"; continue; }
    break;   // 数组 / 数字 / null / 布尔 → 不是对象
  }

  // 兜底：不是对象（或干脆不是 JSON）也要给一个**合法对象**，把原文留在 raw 里备查。
  // 注意：只有数组且元素全是字符串时才是"流式分片被拼成数组"，先试着缝回去。
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr) && arr.every(x => typeof x === "string")) {
      const joined = arr.join("").trim();
      try {
        const obj = JSON.parse(joined);
        if (obj && typeof obj === "object" && !Array.isArray(obj)) return JSON.stringify(obj);
      } catch {}
      s = joined || s;
    }
  } catch {}

  return JSON.stringify({ raw: String(s).slice(0, MAX_RAW) });
}

// 给"要发出去的整段历史"做一遍：任何 arguments 不合法的 tool_call 都就地把参数规范化。
export function normalizeToolCallArguments(messages) {
  if (!Array.isArray(messages)) return messages;
  for (const m of messages) {
    if (m?.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      if (!tc || typeof tc !== "object") continue;
      const fn = tc.function;
      if (!fn || typeof fn !== "object") continue;
      const fixed = normalizeToolArgs(fn.arguments);
      if (fixed !== fn.arguments) fn.arguments = fixed;
    }
  }
  return messages;
}
