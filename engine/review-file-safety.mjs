import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isProtectedPath } from './tools/security.mjs';

// Review writes are limited to content folders, never queue/audit/runtime metadata.
export function reviewPath(root, input) {
  if (typeof input !== 'string' || !input || /[\x00-\x1f:]/.test(input)) throw new Error('无效的工作区相对路径');
  const parts = input.replaceAll('\\', '/').split('/');
  if (!['工程', '记忆', 'workshop-out'].includes(parts[0]) || parts.some(p => !p || p === '..' || p === '.' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('目标必须在允许的工作区内容目录内');
  if (parts.some(p => ['.git', '.pi', 'node_modules', '待审', '运行时', '授权记录.jsonl'].includes(p.toLowerCase()))) throw new Error('不能改写系统记录');
  const abs = path.resolve(root, ...parts);
  if (isProtectedPath(abs.toLowerCase())) throw new Error('受保护文件不能通过此入口改写');
  return reviewStoragePath(root, parts.join('/'));
}

// Internal metadata paths bypass the content allowlist, never the link checks.
export function reviewStoragePath(root, relative) {
  const parts = relative.replaceAll('\\', '/').split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[:\x00-\x1f]/.test(p))) throw new Error('无效的内部记录路径');
  let cursor = path.resolve(root);
  if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('工作区根目录不能是链接');
  for (const part of parts) {
    cursor = path.join(cursor, part);
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink() || stat.nlink > 1 && stat.isFile()) throw new Error('不能通过链接改写文件');
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return cursor;
}

export function backupTarget(backup) {
  const name = path.basename(backup);
  const match = /^(.+)\.bak(?:-.*)?$/.exec(name);
  if (!match) throw new Error('无法从备份文件名解析目标');
  return path.join(path.dirname(backup), match[1]);
}

export function reviewAudit(root, line) {
  const file = reviewStoragePath(root, '记忆/授权记录.jsonl');
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(line) + '\n', 'utf8');
}

export function reviewAtomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.yuanshu-review-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, content, { flag: 'wx' });
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
