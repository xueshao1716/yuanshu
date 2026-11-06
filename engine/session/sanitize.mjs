// engine/session-sanitize.mjs —— 会话文件消息级卫生处理
// 解决 reasoning 模型 thinkingSignature/thinking 膨胀导致上游 400/502 的根因
// 策略：agent.prompt() 前扫描 jsonl，超限字段就地截断重写
import fs from "node:fs";

// 简单文件锁：防止 sanitize 和 agent appendMessage 同时写同一个 jsonl
const _locks = new Set();
function acquireLock(fp) {
  if (_locks.has(fp)) return false;
  _locks.add(fp);
  return true;
}
function releaseLock(fp) { _locks.delete(fp); }

const MAX_THINKING_SIGNATURE = 256 * 1024; // 256KB（上游 10MiB 硬限）
const MAX_THINKING = 64 * 1024;            // 64KB
const MAX_TOOL_RESULT = 512 * 1024;        // 512KB 单条工具结果
const MAX_LINE_BYTES = 8 * 1024 * 1024;    // 8MB 单行总大小（留 2MB 安全余量）

/**
 * 对会话 jsonl 文件做单条消息级卫生处理（就地重写）
 * @param {string} filePath - jsonl 文件路径
 * @returns {{ modified: boolean, truncated: number }} 是否修改 + 截断了几条
 */
export function sanitizeSessionFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { modified: false, truncated: 0 };
  // 并发保护：同一文件不重入（agent appendMessage 可能同时在写）
  if (!acquireLock(filePath)) return { modified: false, truncated: 0 };
  let lines;
  try { lines = fs.readFileSync(filePath, "utf8").split("\n"); } catch { releaseLock(filePath); return { modified: false, truncated: 0 }; }

  let modified = false, truncated = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    // 快速判断：行字节 > 512KB 才值得解析（性能：不解析小消息）
    if (Buffer.byteLength(line, "utf8") < MAX_TOOL_RESULT) continue;

    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const m = d.message || d.payload?.message || {};
    const content = m.content;
    let changed = false;

    // 1. 截断 thinkingSignature
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (typeof block.thinkingSignature === "string" && block.thinkingSignature.length > MAX_THINKING_SIGNATURE) {
          block.thinkingSignature = block.thinkingSignature.slice(0, 1024) + "...[truncated by sanitize]";
          changed = true;
        }
        if (typeof block.thinking === "string" && block.thinking.length > MAX_THINKING) {
          block.thinking = block.thinking.slice(0, MAX_THINKING) + "\n...[truncated: " + block.thinking.length + " chars]";
          changed = true;
        }
        // 工具结果文本截断
        if (typeof block.text === "string" && block.text.length > MAX_TOOL_RESULT && m.role === "toolResult") {
          block.text = block.text.slice(0, MAX_TOOL_RESULT) + "\n...[truncated: " + block.text.length + " chars]";
          changed = true;
        }
      }
    }
    // 顶级 thinking/thinkingSignature（某些消息格式）
    if (typeof m.thinkingSignature === "string" && m.thinkingSignature.length > MAX_THINKING_SIGNATURE) {
      m.thinkingSignature = m.thinkingSignature.slice(0, 1024) + "...[truncated]";
      changed = true;
    }
    if (typeof m.thinking === "string" && m.thinking.length > MAX_THINKING) {
      m.thinking = m.thinking.slice(0, MAX_THINKING) + "\n...[truncated]";
      changed = true;
    }

    // 2. 整行仍然超大（其他原因）→ 极端兜底
    if (changed) {
      const newLine = JSON.stringify(d);
      if (Buffer.byteLength(newLine, "utf8") > MAX_LINE_BYTES) {
        // 极端：直接丢弃 content（保留元数据）
        if (m.content) m.content = [{ type: "text", text: "[message too large, removed by sanitize]" }];
        lines[i] = JSON.stringify(d);
      } else {
        lines[i] = newLine;
      }
      truncated++;
      modified = true;
    }
  }

  if (modified) {
    try { fs.writeFileSync(filePath, lines.join("\n"), "utf8"); } catch {}
  }
  releaseLock(filePath);
  return { modified, truncated };
}
