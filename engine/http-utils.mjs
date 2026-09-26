// engine/http-utils.mjs —— HTTP 通用工具（2026-08-20 从 server.mjs 拆出）
// json()/readBody()：纯 node res/req 操作，无外部依赖，全库 300+ 调用点零改动
import { StringDecoder } from 'node:string_decoder';

// P1 错误响应脱敏：移除可能泄露密钥/内部路径/上游错误详情的内容
const SENSITIVE_RE = /(?:sk-[a-zA-Z0-9]{8,}|Bearer\s+[^\s]{8,}|api[_-]?key[=:]\s*\S+|token[=:]\s*\S+|password[=:]\s*\S+|-----BEGIN\s+\w+\s+PRIVATE\s+KEY)/gi;
function sanitizeError(msg) {
  if (typeof msg !== "string") return msg;
  return msg.replace(SENSITIVE_RE, "[REDACTED]").slice(0, 500);
}

function sanitizeErrorValue(value) {
  if (typeof value === "string") return sanitizeError(value);
  if (Array.isArray(value)) return value.map(sanitizeErrorValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitizeErrorValue(child)]));
  }
  return value;
}

export function json(res, code, obj) {
  // error 可能是字符串或嵌套对象；统一脱敏其所有文本字段，避免上游详情夹带凭据。
  if (obj && Object.prototype.hasOwnProperty.call(obj, "error")) {
    obj = { ...obj, error: sanitizeErrorValue(obj.error) };
  }
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

// 读取并解析 JSON 请求体。
//
// 超限的处理方式很关键（2026-09-15 真机踩到）：以前是 `reject(); req.destroy()`——
// 一旦 body 超过上限就**在响应写回之前掐断连接**，客户端只看到一句 `fetch failed`，
// 连"太大了、上限多少"都拿不到（实测：2.8MB 的 /api/media 请求只报 fetch failed，
// 排查方向直接被带偏到网络层）。现在改成：判超限后停止累积、把剩下的流量排掉、
// 抛一个带 statusCode 的错，让调用方能回一个说得清的 413。
export function readBody(req, maxMB = 2) {
  return new Promise((resolve, reject) => {
    let data = "";
    let received = 0;
    let tooLarge = false;
    const decoder = new StringDecoder('utf8');
    const max = maxMB * 1024 * 1024;
    req.on("data", (c) => {
      if (tooLarge) return; // 已判超限：只把剩余流量丢掉，不再让它占内存
      received += Buffer.isBuffer(c) ? c.length : Buffer.byteLength(c);
      if (received > max) {
        tooLarge = true;
        data = "";
        req.resume(); // 把请求体读干净，响应才有机会送达
        reject(Object.assign(
          new Error(`请求体超过 ${maxMB}MB 上限（已收到 ${(received / 1048576).toFixed(1)}MB）。请改用文件路径，或减少内联的媒体数据。`),
          { statusCode: 413 },
        ));
        return;
      }
      // 网络分块可能落在汉字/表情的字节中间，不能逐块独立解码。
      data += typeof c === 'string' ? c : decoder.write(c);
    });
    req.on("end", () => {
      if (tooLarge) return;
      data += decoder.end();
      try { resolve(JSON.parse(data || "{}")); } catch { reject(Object.assign(new Error("invalid JSON"), { statusCode: 400 })); }
    });
    req.on("error", reject);
  });
}
