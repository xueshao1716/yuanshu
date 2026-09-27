// ══════════════════════════════════════════════════════════
// engine/tui-bridge.mjs —— 后端 TUI 桥接（08-26）
// WebSocket /ws/tui：连接建立后先发送 auth 握手，再 spawn 一个独立 PTY 跑 pi TUI。
// 前端 xterm.js 直连操作（输入/输出/resize 双向透传）。
// 鉴权：首条 auth 消息中的 token 必须与 CONFIG.token 一致，否则立即断开。
// ══════════════════════════════════════════════════════════
import { WebSocketServer } from "ws";
import pty from "@lydell/node-pty";

let _wss = null;

/**
 * 挂载 TUI WebSocket 桥
 * @param httpServer 已有的 node http server
 * @param opts { token, cwd, cols, rows }
 */
export function initTuiBridge(httpServer, { token, cwd, cols = 120, rows = 30 } = {}) {
  if (_wss) return _wss;
  const wss = new WebSocketServer({ noServer: true });
  _wss = wss;

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/ws/tui") return; // 非 TUI 升级请求放行给其他处理方
    // 凭据不再从 URL 读取；连接建立后由客户端发送 auth 握手。
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws) => {
    let proc = null;
    let authenticated = false;
    let authTimer = setTimeout(() => {
      if (!authenticated) {
        try { ws.close(1008, "authentication timeout"); } catch {}
      }
    }, 5000);

    const start = () => {
      try {
        // Windows 下 conPTY 走 cmd 包装启动 pi TUI；cwd 为工作空间根
        proc = pty.spawn("cmd.exe", ["/c", "pi"], {
          name: "xterm-256color",
          cols, rows,
          cwd: cwd || process.cwd(),
          env: { ...process.env },
        });
      } catch (e) {
        try { ws.send(`\r\n[灵犀] TUI 启动失败：${e?.message || e}\r\n`); } catch {}
        ws.close();
        return;
      }

      proc.onData(d => { try { ws.send(d); } catch {} });
      proc.onExit(({ exitCode }) => {
        try { ws.send(`\r\n\x1b[2m[TUI 会话已退出，code=${exitCode}]\x1b[0m\r\n`); ws.close(); } catch {}
      });
    };

    ws.on("message", msg => {
      try {
        const d = JSON.parse(msg.toString());
        if (!authenticated) {
          if (d.type !== "auth" || !token || d.token !== token) {
            try { ws.close(1008, "unauthorized"); } catch {}
            return;
          }
          authenticated = true;
          clearTimeout(authTimer);
          try { ws.send(JSON.stringify({ type: "auth_ok" })); } catch {}
          start();
          return;
        }
        if (!proc) return;
        if (d.type === "input" && typeof d.data === "string") proc.write(d.data);
        else if (d.type === "resize") proc.resize(Math.max(20, +d.cols || 80), Math.max(6, +d.rows || 24));
      } catch {}
    });
    ws.on("close", () => { clearTimeout(authTimer); try { proc?.kill(); } catch {} });
    ws.on("error", () => {});
  });

  return wss;
}
