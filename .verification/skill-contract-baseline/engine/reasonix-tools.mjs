// ══ Reasonix 机制落地（esengine/DeepSeek-Reasonix 借鉴，2026-08-19）══
// 三个纯函数/常量：工具结果压缩 / NEEDS_PRO 自报升级 / scavenge 工具调用捞回。
// 纯逻辑模块：不依赖 server.mjs 内部符号，可单测、可复用。

import { archiveToolResult, countTextLines, toolResultId } from "./tool-result-archive.mjs";

// ① turn-end 工具结果压缩（P3）：超长工具结果只保留头尾+省略提示，后续轮次省 token；
//    会话文件原文不动（审计无损），仅喂模型时压缩。
export const TURN_END_RESULT_CAP = 9000;   // 超过此字符数（≈3000-4500 token）触发
export const TURN_END_RESULT_EDGE = 3000;  // 保留头尾各多少字符

// 省略段里出现这些特征就说明"丢掉的很可能是失败证据"，必须摘出来。
// 对应 NVlabs/SoL-Pi 的 missing-failure-evidence 守卫：失败日志读起来像失败，
// 就不许被压缩成一句干净的总结。
const FAILURE_SIGNAL = /(?:\bFAIL(?:ED|URE)?\b|\bERROR\b|\bError:|\bAssertionError\b|Traceback \(most recent call last\)|^\s*panic:|non-zero exit|exit (?:code|status) [1-9]|✗|❌)/m;
const MAX_SURFACED_SIGNALS = 3;

/** 按整行取头部，绝不把一行切成半句——半句话比没有更误导。 */
function headLines(text, budget) {
  const lines = text.split("\n");
  const out = [];
  let used = 0;
  for (const line of lines) {
    const add = (out.length ? 1 : 0) + line.length;
    if (used + add > budget) break;
    out.push(line);
    used += add;
  }
  return out.join("\n");
}

/** 按整行取尾部。 */
function tailLines(text, budget) {
  const lines = text.split("\n");
  const out = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const add = (out.length ? 1 : 0) + lines[i].length;
    if (used + add > budget) break;
    out.unshift(lines[i]);
    used += add;
  }
  return out.join("\n");
}

/** 在省略段里找疑似失败信号，带行号返回（行号相对原文）。 */
function scanFailureSignals(text, baseLine = 1) {
  const hits = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && hits.length < MAX_SURFACED_SIGNALS; i++) {
    if (!FAILURE_SIGNAL.test(lines[i])) continue;
    hits.push({ line: baseLine + i, text: lines[i].trim().slice(0, 200) });
  }
  return hits;
}

// 压缩时优先按整行切；同时把被丢弃的中间段归档，并给出**可执行**的回读指针。
// 以前这里只说"如需完整内容可重新读取"，却没给路径、没给 id、中间段也没有任何归档——
// 模型想照做也无从下手；而报错常出现在中段，丢了就是永久丢失。
export function shrinkToolResult(text) {
  const s = String(text ?? "");
  if (!s || s.length <= TURN_END_RESULT_CAP) return s;

  let head = headLines(s, TURN_END_RESULT_EDGE);
  let tail = tailLines(s, TURN_END_RESULT_EDGE);
  // 退化情形：整个结果就是一行，比预算还长（比如一串 base64 或压成一行的 JSON）。
  // 这时"不切半句"会让头尾都空掉，反而什么都看不到——宁可切，但要说明边界没对齐。
  let lineAligned = true;
  if (!head) { head = s.slice(0, TURN_END_RESULT_EDGE); lineAligned = false; }
  if (!tail) { tail = s.slice(-TURN_END_RESULT_EDGE); lineAligned = false; }

  const omittedStart = head.length;
  const omittedEnd = Math.max(omittedStart, s.length - tail.length);
  const omitted = s.slice(omittedStart, omittedEnd);
  if (!omitted) return s; // 头尾已经盖满，没有再省的空间
  const omittedLines = countTextLines(omitted);
  const baseLine = head ? countTextLines(head) + 1 : 1;
  const signals = scanFailureSignals(omitted, baseLine);

  const archived = archiveToolResult(s);
  const parts = [`\n\n…[工具结果过长已压缩：原文 ${s.length} 字符 / ${countTextLines(s)} 行，头尾各保留约 ${TURN_END_RESULT_EDGE} 字符]…`];
  if (archived) {
    // 指针必须可执行：绝对路径 + 一条现成的读取命令，模型用已有工具就能回读
    parts.push(`原件已归档：${archived.file}`);
    parts.push(`回读方式：read 工具读该文件（可带 offset/limit）；或 bash: sed -n '<起>,<止>p' "${archived.file}"`);
  } else {
    // 归档不可用时如实说明，绝不写"可重新读取"这种空头承诺
    parts.push("原件未归档（归档不可用），如需完整内容请重新执行该命令");
  }
  parts.push(`已省略中间 ${omitted.length} 字符（约第 ${baseLine}–${baseLine + omittedLines - 1} 行${lineAligned ? "" : "，边界未按整行对齐"}）`);
  if (signals.length) {
    parts.push(`⚠️ 省略段含疑似失败信号 ${signals.length} 条，已摘出，不要当成成功：`);
    for (const hit of signals) parts.push(`  L${hit.line}: ${hit.text}`);
  }
  parts.push("…\n\n");
  return head + parts.join("\n") + tail;
}

// ② 大结果先发全文 N 次再压缩。
//
// 借 NVlabs/SoL-Pi ObservationPack 的 FULL_SENDS：模型可能**还在用**这个结果，
// 一出现就砍掉会饿死正在读它的模型。
//
// 元枢的语义要说清：`formatSessionHistory` 每**请求**只调用一次（多轮 agentic 循环
// 复用同一份 history），而结果产生的那一轮里本来就是全文（新结果直接进循环的 messages，
// 不经过压缩）。所以 FULL_SENDS=2 的实际含义是：
//   结果产生后的**头两次请求**仍给全文，第三次起才压缩。
// 注意这与 SoL-Pi 不完全等价——它数的是循环内的**每一次 provider 请求**，
// 元枢这里数的是**请求数**，比它更宽松（更省不下 token，但更不容易丢证据）。
export const FULL_SENDS = 2;
const MAX_TRACKED_RESULTS = 4000;
const projections = new Map();

function projectionKey(tool, full) {
  const id = String(tool?.id || "").trim();
  // 有 tool_call_id 就用它（廉价且唯一）；没有就退回内容寻址，保证同一份内容同一个计数
  return id ? `id:${id}` : `hash:${toolResultId(full)}`;
}

/** 记一次投影并返回这是第几次。供测试观察与重置。 */
export function countProjection(tool, full) {
  const key = projectionKey(tool, full);
  const seen = (projections.get(key) || 0) + 1;
  // 有界：长跑进程里大结果会越积越多，超了就淘汰最早的一批（Map 保持插入序）
  if (projections.size >= MAX_TRACKED_RESULTS && !projections.has(key)) {
    let drop = Math.ceil(MAX_TRACKED_RESULTS * 0.1);
    for (const k of projections.keys()) { projections.delete(k); if (--drop <= 0) break; }
  }
  projections.set(key, seen);
  return seen;
}

export function resetProjectionCounts() {
  projections.clear();
}

/**
 * 工具结果的投影策略：够短就原样；够长则**前 FULL_SENDS 次发全文**，之后压缩。
 * `formatSessionHistory` 默认用它，测试可注入等价实现来避免共享计数状态。
 */
export function projectToolResult(tool) {
  const full = String(tool?.output ?? "");
  if (!full || full.length <= TURN_END_RESULT_CAP) return full;
  return countProjection(tool, full) <= FULL_SENDS ? full : shrinkToolResult(full);
}

// ② NEEDS_PRO 自报升级（P3）：模型认为任务超纲时输出 <<<NEEDS_PRO[: 原因]>>> 首行
//    → 系统用 pro 模型重试一次。纯自报、无静默升级。
export const NEEDS_PRO_RE = /^<<<\s*NEEDS_PRO(?:\s*:\s*([^>]{1,120}))?\s*>>>/;

// ③ scavenge（P2 修复管线）：DeepSeek 实证故障——工具调用 JSON 偶发被放进 reasoning_content，
//    final message 无 tool_calls。无 tool_calls 且有思考时，扫描思考捞回合法工具调用。
//    校验：name 必须在工具集 + arguments 是对象 + 每轮每工具限 1 次（防重复捞/防思考示例误捞）。
export function scavengeToolCalls(thinking, toolDefs, seenCalls) {
  if (!thinking || !toolDefs) return [];
  const names = new Set(toolDefs.map(t => t.function?.name).filter(Boolean));
  const found = [];
  const patterns = [
    /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\})\s*\}/g,
    /\{\s*"function"\s*:\s*\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\})\s*\}\s*\}/g,
    /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"parameters"\s*:\s*(\{[\s\S]*?\})\s*\}/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(thinking)) && found.length < 3) {
      const name = m[1];
      if (!names.has(name)) continue; // 工具名必须合法，防误捞思考里的示例
      let args = {};
      try { args = JSON.parse(m[2]); } catch { continue; }
      if (typeof args !== "object" || Array.isArray(args)) continue;
      const sig = name + ":" + JSON.stringify(args);
      if (seenCalls.get(sig)) continue; // 每轮每工具一次，防重复捞
      seenCalls.set(sig, 1); // 标记已捞，同 sig 后续跳过（含嵌套格式内外层重复）
      found.push({ id: "scavenged-" + name + "-" + (found.length + 1), name, args });
      if (found.length >= 3) break;
    }
    if (found.length >= 3) break;
  }
  return found;
}
