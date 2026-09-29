// Two-file transaction: exclusive writer + before-image journal + verified writes.
// A leftover lock is deliberately fail-closed; never steal a possibly live writer's lock.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function createGeneStore(root, defaults) {
  const dir = path.join(root, '工程/经验库');
  const files = ['genome.json', 'proposals.json'].map(name => path.join(dir, name));
  const journal = path.join(dir, '.gene-transaction.json');
  const lock = path.join(dir, '.gene-writer.lock');
  const raw = file => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  function atomic(file, text) {
    const temp = `${file}.tmp-${randomUUID()}`;
    let fd;
    try {
      fd = fs.openSync(temp, 'wx');
      fs.writeFileSync(fd, text, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, file);
      if (raw(file) !== text) throw new Error('写入后核验失败');
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }
  function locked(fn) {
    fs.mkdirSync(dir, { recursive: true });
    let fd;
    try { fd = fs.openSync(lock, 'wx'); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('基因存储被占用；若上次进程异常退出，请确认进程已停止后处理遗留写锁');
      throw error;
    }
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); return fn(); }
    finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  function restore(before) {
    for (let i = 0; i < files.length; i++) {
      if (raw(files[i]) === before[i]) continue;
      if (before[i] === null) fs.unlinkSync(files[i]);
      else atomic(files[i], before[i]);
    }
  }
  function recover() {
    const text = raw(journal);
    if (text === null) return;
    const record = JSON.parse(text);
    if (record.version !== 1 || !Array.isArray(record.before) || record.before.length !== 2 ||
      !record.before.every(value => value === null || typeof value === 'string')) throw new Error('基因事务日志损坏，需人工恢复');
    restore(record.before);
    fs.unlinkSync(journal);
  }
  function decode(before) {
    const genome = before[0] === null ? { genes: structuredClone(defaults), observations: { lastObservedAt: null, events: [] } } : JSON.parse(before[0]);
    const proposals = before[1] === null ? { proposals: [], reviews: [], snapshots: [] } : JSON.parse(before[1]);
    if (!genome?.genes || !Object.keys(defaults).every(name => {
      const g = genome.genes[name];
      return g && ['baseline', 'expression', 'mutability'].every(k => Number.isFinite(g[k]) && g[k] >= 0 && g[k] <= 1);
    }) || !['proposals', 'reviews', 'snapshots'].every(k => Array.isArray(proposals?.[k]))) throw new Error('基因存储格式无效，禁止用默认值覆盖');
    genome.observations ??= { lastObservedAt: null, events: [] };
    if (!Array.isArray(genome.observations.events)) throw new Error('基因观测格式无效');
    return { genome, proposals };
  }
  function transaction(change) {
    return locked(() => {
      recover();
      const before = files.map(raw);
      const state = decode(before);
      const original = JSON.stringify(state);
      const components = [state.genome, state.proposals].map(value => JSON.stringify(value));
      const result = change?.(state);
      if (JSON.stringify(state) !== original) {
        const after = [state.genome, state.proposals].map((value, i) =>
          before[i] !== null && JSON.stringify(value) === components[i] ? before[i] : JSON.stringify(value, null, 2));
        try {
          atomic(journal, JSON.stringify({ version: 1, before }));
          for (let i = 0; i < files.length; i++) if (before[i] !== after[i]) atomic(files[i], after[i]);
          // Removing the journal is the commit point. Before this, recovery restores both files.
          fs.unlinkSync(journal);
        } catch (error) {
          try { if (raw(journal) !== null) recover(); }
          catch (recovery) { throw new Error(`基因保存失败，恢复尚未完成：${recovery.message}`, { cause: error }); }
          throw new Error(`基因保存失败，本次变更未提交：${error.message}`, { cause: error });
        }
      }
      return { state, result: structuredClone(result) };
    });
  }
  return { read: () => transaction().state, transaction };
}
