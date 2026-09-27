// engine/mcp-chat.mjs —— MCP 对话 SSE 收集（2026-08-20）
// 调元枢内部 /api/chat 逻辑收集完整回复（不经 HTTP，进程内调用）
import { createSseWriter } from "./sse.mjs";

// 依赖注入：handleChat 引用（server.mjs 注入，避免循环依赖）
let _handleChat = null;
export function initMcpChat({ handleChat }) {
  _handleChat = handleChat;
}

// 收集 /api/chat 的 SSE 直到 done，返回完整文本
export async function chatCollect(body, ctx) {
  if (!_handleChat) {
    // fallback：走 HTTP（需要 ctx 提供 fetch/token）
    if (ctx?.api) {
      const r = await ctx.api("/api/chat", { method: "POST", body: JSON.stringify(body) });
      const text = await r.text();
      let full = "";
      for (const line of text.split("\n")) {
        if (line.startsWith("data: ")) {
          try {
            const d = JSON.parse(line.slice(6));
            if (d.text) full += d.text;
          } catch {}
        }
      }
      return full || "(空回复)";
    }
    return "chat 未初始化";
  }

  // 进程内调用：假 res 收集 SSE
  let full = "";
  const fakeRes = {
    writeHead() {},
    end() {},
    write(chunk) {
      const s = String(chunk);
      for (const line of s.split("\n")) {
        if (line.startsWith("data: ")) {
          try {
            const d = JSON.parse(line.slice(6));
            if (d.text) full += d.text;
          } catch {}
        }
      }
      return true;
    },
  };
  const writer = createSseWriter(fakeRes);
  const req = { headers: { host: "127.0.0.1" }, on() {} };
  await _handleChat(req, fakeRes, body);
  return full || "(空回复)";
}
