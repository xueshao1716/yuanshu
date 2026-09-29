import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { PERSONA_BEGIN, PERSONA_END, renderAppendSystemPersona } from './persona-def.mjs';

export const revisionOf = text => createHash('sha256').update(text).digest('hex');
export function atomicWrite(file, text) {
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined; fs.renameSync(temp, file);
  } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export function personaStorage(wsRoot, agentDir) {
  const dir = path.join(wsRoot, '记忆', '人格修订');
  const file = path.join(wsRoot, '记忆', '人格定义.json');
  const append = path.join(agentDir, 'APPEND_SYSTEM.md');
  function records() {
    if (!fs.existsSync(dir)) return [];
    if (fs.existsSync(path.join(dir, 'pending.json'))) throw new Error('人格写入未完成，请先检查待恢复事务；拒绝继续覆盖');
    return fs.readdirSync(dir).filter(n => /^[a-f0-9-]{36}\.json$/.test(n))
      .map(n => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))).sort((a, b) => b.sequence - a.sequence);
  }
  function transact(record, expectedRevision) {
    fs.mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, 'write.lock');
    let fd;
    try { fd = fs.openSync(lock, 'wx'); } catch { throw new Error('人格设置正在修改或有未恢复的锁，请稍后重试'); }
    const pending = path.join(dir, 'pending.json');
    let original, oldAppend, appendExists, started = false;
    try {
      records();
      original = fs.readFileSync(file, 'utf8');
      if (revisionOf(original) !== expectedRevision) throw new Error('人格版本已变化，请重新读取并审查差异');
      fs.mkdirSync(agentDir, { recursive: true });
      appendExists = fs.existsSync(append);
      oldAppend = appendExists ? fs.readFileSync(append, 'utf8') : '';
      const block = renderAppendSystemPersona(record.next);
      const start = oldAppend.indexOf(PERSONA_BEGIN), end = oldAppend.indexOf(PERSONA_END);
      if ((start >= 0) !== (end >= 0) || (start >= 0 && (end < start || oldAppend.indexOf(PERSONA_BEGIN, start + 1) >= 0 || oldAppend.indexOf(PERSONA_END, end + 1) >= 0))) throw new Error('本地人格块标记不完整或重复，请先修复');
      const nextAppend = start < 0 ? `${block}\n\n${oldAppend}` : oldAppend.slice(0, start) + block + oldAppend.slice(end + PERSONA_END.length);
      atomicWrite(pending, JSON.stringify({ record, original, oldAppend, appendExists }, null, 2));
      started = true;
      atomicWrite(append, nextAppend);
      atomicWrite(file, record.nextRaw);
      // The immutable revision record is both snapshot and audit. Its publication commits the transaction.
      atomicWrite(path.join(dir, `${record.snapshot_id}.json`), JSON.stringify(record, null, 2));
      fs.unlinkSync(pending);
    } catch (error) {
      if (started) {
        try {
          atomicWrite(file, original);
          if (appendExists) atomicWrite(append, oldAppend); else if (fs.existsSync(append)) fs.unlinkSync(append);
          const published = path.join(dir, `${record.snapshot_id}.json`);
          if (fs.existsSync(published)) fs.unlinkSync(published);
          fs.unlinkSync(pending);
        } catch { throw new Error('人格保存失败且恢复未完成；已保留事务备份并阻止继续写入，请检查人格修订目录'); }
      }
      throw error;
    } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  return { records, transact, file };
}
