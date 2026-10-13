// engine/feedback.mjs —— 反馈收集（bug 报告 + 改进意见）收件箱，2026-10-13
// 场景：分发出去的主机在系统页提交反馈 → POST 到它连接的工作台服务器 →
// 服务器落盘收件箱 → 开发者（服务器主人）在系统页查看、标记处理。
// 设计原则：①诊断信息显式征得同意才附带 ②绝不含令牌/密钥 ③追加式存储防覆盖。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

const MAX_TITLE = 120;
const MAX_DETAIL = 8000;
const MAX_ITEMS = 500;
const TYPES = new Set(["bug", "idea"]);
const RATE_LIMIT_MS = 12 * 60 * 60 * 1000; // 同 IP 12 小时内最多 N 条（防公开端点被刷）
const RATE_MAX = 8;

export function createFeedbackStore({ wsRoot, version = "", readCrashTail }) {
  // 2026-10-13：wsRoot 支持函数延迟求值——store 初始化早于 initWorkspaceApi，直接传 WS_ROOT 会拿空串写错目录
  const ws = () => (typeof wsRoot === "function" ? wsRoot() : wsRoot);
  // 2026-10-13 深挖：dir/file 必须每次调用时求值——store 构造在模块顶层（早于 initWorkspaceApi），
  // 构造时固化会把空 wsRoot 永久锁进路径，写进进程 cwd（D:/pi-web/feedback）。
  const dir = () => path.join(ws(), "feedback");
  const file = () => path.join(dir(), "inbox.json");

  function load() {
    try { return JSON.parse(fs.readFileSync(file(), "utf8")); } catch { return { items: [] }; }
  }
  function save(box) {
    fs.mkdirSync(dir(), { recursive: true });
    const tmp = `${file()}.tmp-${randomUUID()}`;
    fs.writeFileSync(tmp, JSON.stringify(box, null, 2), "utf8");
    fs.renameSync(tmp, file());
  }

  // 诊断摘要：只收非敏感运行事实，帮助开发者定位；不读任何令牌/密钥/会话内容。
  function collectDiagnostics() {
    const diag = { version, os: `${os.type()} ${os.release()} ${os.arch()}`, node: process.version, uptimeS: Math.round(process.uptime()) };
    try {
      if (typeof readCrashTail === "function") diag.crashTail = readCrashTail();
    } catch { /* 诊断失败不阻塞提交 */ }
    return diag;
  }

  function add({ type, title, detail, contact = "", withDiagnostics = false, env = null, source = "workbench", ip = "" }) {
    const cleanType = TYPES.has(type) ? type : "idea";
    const cleanTitle = String(title || "").trim().slice(0, MAX_TITLE);
    const cleanDetail = String(detail || "").trim().slice(0, MAX_DETAIL);
    if (!cleanTitle) return { error: "标题不能为空" };
    const box = load();
    if (source === "public" && ip) {
      const cutoff = Date.now() - RATE_LIMIT_MS;
      const recent = box.items.filter(x => x.source === "public" && x.ip === ip && x.at >= cutoff).length;
      if (recent >= RATE_MAX) return { error: "rate_limited" };
    }
    const item = {
      id: randomUUID(), at: Date.now(), type: cleanType,
      title: cleanTitle, detail: cleanDetail, contact: String(contact || "").slice(0, 200),
      status: "open", env: env || null,
      source, ip: source === "public" ? ip : "",
      diagnostics: withDiagnostics ? collectDiagnostics() : null,
    };
    box.items.push(item);
    box.items = box.items.slice(-MAX_ITEMS);
    save(box);
    return { item };
  }

  function list() { return load().items.slice().reverse(); }

  function mark(id, status) {
    if (!["open", "done", "wontfix"].includes(status)) return { error: "invalid_status" };
    const box = load();
    const it = box.items.find(x => x.id === id);
    if (!it) return { error: "not_found" };
    it.status = status; it.handledAt = Date.now();
    save(box);
    return { item: it };
  }

  return { add, list, mark, collectDiagnostics };
}
