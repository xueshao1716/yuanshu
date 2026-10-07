// engine/http-utils.mjs —— HTTP 通用工具（2026-08-20 从 server.mjs 拆出）
// json()/readBody()：纯 node res/req 操作，无外部依赖，全库 300+ 调用点零改动

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

export function json(res, code, obj, extraHeaders = {}) {
  // error 可能是字符串或嵌套对象；统一脱敏其所有文本字段，避免上游详情夹带凭据。
  if (obj && Object.prototype.hasOwnProperty.call(obj, "error")) {
    obj = { ...obj, error: sanitizeErrorValue(obj.error) };
  }
  res.writeHead(code, { "Content-Type": "application/json", ...extraHeaders });
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
    const chunks = [];
    let received = 0;
    let tooLarge = false;
    const max = maxMB * 1024 * 1024;
    req.on("data", (c) => {
      if (tooLarge) return; // 已判超限：只把剩余流量丢掉，不再让它占内存
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf8');
      received += buf.length;
      if (received > max) {
        tooLarge = true;
        chunks.length = 0;
        req.resume(); // 把请求体读干净，响应才有机会送达
        reject(Object.assign(
          new Error(`请求体超过 ${maxMB}MB 上限（已收到 ${(received / 1048576).toFixed(1)}MB）。请改用文件路径，或减少内联的媒体数据。`),
          { statusCode: 413 },
        ));
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      if (tooLarge) return;
      // 整体解码（分块可能落在汉字中间），且必须是合法 UTF-8。
      // 2026-10-05 真机：Git Bash 的 curl -d 把中文按 GBK 发过来，宽松解码悄悄变成 U+FFFD，
      // 5 条基因审核的审核人与驳回理由就这样永久坏在盘上。宁可拒收并说清怎么发，也不写乱码。
      let data;
      try { data = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
      catch {
        reject(Object.assign(new Error("请求体不是合法 UTF-8（常见于 Windows 命令行 curl -d 直接写中文，会按 GBK 发出）。请用 node/python 发送，或把 JSON 存成 UTF-8 文件后用 --data-binary @文件。"), { statusCode: 400, code: 'invalid_encoding' }));
        return;
      }
      try { resolve(JSON.parse(data || "{}")); } catch { reject(Object.assign(new Error("invalid JSON"), { statusCode: 400 })); }
    });
    req.on("error", reject);
  });
}
