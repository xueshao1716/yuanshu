// engine/service-log.mjs —— 服务日志（2026-10-21）
//
// 问题：服务正常运行的 stdout 从来不落盘。watchdog 把子进程输出放环形缓冲，
// 只有崩溃时写 60 行进 watchdog.log。于是"服务为什么慢/为什么报错"只能靠复现。
//
// 现在三处统一这套路径约定（watchdog.cjs 是 CJS，自己内联同样的规则，别引 ESM）：
//   文件：<wsRoot>/记忆/运行时/服务日志-YYYY-MM-DD.log
//   轮转：单日文件超过 20MB → 改名 .1（覆盖旧 .1）
//   读取：tail 只读最后 N 行，不整文件加载（日志可能几十 MB）
import fs from 'node:fs';
import path from 'node:path';

export const SERVICE_LOG_DIR = '记忆/运行时';
export const MAX_BYTES = 20 * 1024 * 1024;

/** 本地日期（与候选/收发文件口径一致） */
export function localDate(now = new Date()) {
  try { return now.toLocaleDateString('sv-SE'); } catch { return now.toISOString().slice(0, 10) }
}

export function serviceLogPath(wsRoot, now = new Date()) {
  return path.join(wsRoot, SERVICE_LOG_DIR, `服务日志-${localDate(now)}.log`);
}

/** 读最后 N 行：从文件尾往回按块读，避免大文件整体进内存 */
export function tailServiceLog(wsRoot, { lines = 200, maxBytes = 512 * 1024, now = new Date() } = {}) {
  const file = serviceLogPath(wsRoot, now);
  let fd;
  try {
    const st = fs.statSync(file);
    const size = st.size;
    const readSize = Math.min(size, maxBytes);
    const start = size - readSize;
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      // 起点可能截断半行，丢掉第一段
      const i = text.indexOf('\n');
      if (i >= 0) text = text.slice(i + 1);
    }
    const all = text.split('\n').filter(Boolean);
    return {
      file,
      size,
      truncated: start > 0,
      lines: all.slice(-Math.max(1, Math.min(lines, 5000))),
    };
  } catch (e) {
    return { file, size: 0, truncated: false, lines: [], error: String(e?.message || e).slice(0, 160) };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

/** 列出最近的日志文件（按日期倒序），供排查"昨天那次"用 */
export function listServiceLogs(wsRoot, { limit = 7 } = {}) {
  try {
    const dir = path.join(wsRoot, SERVICE_LOG_DIR);
    return fs.readdirSync(dir)
      .filter(n => /^服务日志-\d{4}-\d{2}-\d{2}\.log(\.1)?$/.test(n))
      .sort()
      .reverse()
      .slice(0, limit)
      .map(n => {
        const p = path.join(dir, n);
        try { const st = fs.statSync(p); return { name: n, bytes: st.size, at: st.mtime.toISOString() }; } catch { return { name: n, bytes: 0, at: '' } }
      });
  } catch { return [] }
}
