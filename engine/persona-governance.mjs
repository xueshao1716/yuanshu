import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DEFAULT_DEFINITION, validatePersonaDefinition } from './persona-def.mjs';
import { personaStorage, revisionOf } from './persona-storage.mjs';

const REQUIRED_FIELDS = ['name', 'age', 'gender', 'kind', 'called', 'bond', 'inner', 'tone', 'values', 'boundaries', 'taboos', 'growth'];
export const PERSONA_FIELDS = [...REQUIRED_FIELDS, 'appearance', 'hairstyle', 'clothing', 'scenarioOutfits'];
const lists = new Set(['inner', 'tone', 'values', 'boundaries', 'taboos']);
function validatePatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('缺少人格定义');
  for (const [key, item] of Object.entries(value)) {
    if (!PERSONA_FIELDS.includes(key)) throw new Error(`不允许修改字段：${key}`);
    if (lists.has(key)) {
      if (!Array.isArray(item) || item.length > 40 || item.some(s => typeof s !== 'string' || !s.trim() || s.length > 2000)) throw new Error(`${key} 必须为非空文字列表（最多40项，每项2000字）`);
    } else if (key === 'age') {
      if (!Number.isInteger(item) || item < 16 || item > 99) throw new Error('年龄必须为16–99之间的整数');
    } else if (typeof item !== 'string' || item.length > 4000) throw new Error(`${key} 必须为文字且不超过4000字`);
  }
}
function validateAuthority(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('人格定义必须为完整对象');
  if (REQUIRED_FIELDS.some(key => !Object.hasOwn(value, key))) throw new Error('人格定义缺少必要字段；禁止用默认值补齐后覆盖');
  validatePatch(Object.fromEntries(PERSONA_FIELDS.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])));
  const problems = validatePersonaDefinition(value);
  if (problems.length) throw new Error(`人格定义不合法：${problems.join('；')}`);
}
export function createPersonaGovernance({ wsRoot, agentDir }) {
  const storage = personaStorage(wsRoot, agentDir);
  function read() {
    const current = { def: structuredClone(DEFAULT_DEFINITION), source: 'default', file: storage.file, problems: [] };
    let revision = null, records = [];
    try {
      // Parse and hash the same bytes: never pair an old definition with a newer revision.
      const raw = fs.readFileSync(storage.file, 'utf8');
      revision = revisionOf(raw);
      const definition = JSON.parse(raw);
      validateAuthority(definition);
      current.def = definition; current.source = 'file';
    } catch (e) { current.problems.push(`人格定义读取不可靠：${e.message}`); }
    try {
      records = storage.records();
    } catch (e) { current.problems.push(e.message); }
    const history = records.map(({ snapshot_id, created_at, action, changed, reviewer, previousRevision, appliedRevision }) => ({
      snapshot_id, created_at, action, changed, reviewer, previousRevision, appliedRevision,
      rolled_back_at: records.find(r => r.rollbackOf === snapshot_id)?.created_at,
    }));
    return { definition: current.def, source: current.source, file: current.file, problems: current.problems, revision, history };
  }
  function prepare(action, body = {}) {
    const current = read();
    if (current.problems.length || current.source !== 'file') throw new Error('人格定义读取不可靠，已拒绝写入；请先恢复原文件');
    if (!body.expectedRevision || body.expectedRevision !== current.revision) throw new Error('人格版本已变化或缺少版本，请重新读取并审查差异');
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason || reason.length > 2000) throw new Error('请填写修改理由（最多2000字）');
    let next, rollbackOf = null;
    if (action === 'apply') {
      validatePatch(body.definition);
      next = { ...current.definition, ...body.definition };
    } else if (action === 'rollback') {
      if (typeof body.snapshot_id !== 'string' || !/^[a-f0-9-]{36}$/.test(body.snapshot_id)) throw new Error('快照编号不合法');
      const snapshot = storage.records().find(r => r.snapshot_id === body.snapshot_id);
      if (!snapshot || current.history.find(r => r.snapshot_id === body.snapshot_id)?.rolled_back_at) throw new Error('快照不存在或已回退');
      if (snapshot.appliedRevision !== current.revision) throw new Error('当前人格已有后续修改，不能覆盖；请先审查最新版本');
      next = snapshot.before; rollbackOf = body.snapshot_id;
    } else throw new Error('不支持的人格操作');
    validateAuthority(next);
    const changed = PERSONA_FIELDS.filter(k => JSON.stringify(next[k]) !== JSON.stringify(current.definition[k]));
    if (!changed.length) throw new Error('没有需要保存的修改');
    return { action, reason, rollbackOf, beforeRevision: current.revision, before: current.definition, next, changed };
  }
  function commit(plan, reviewer) {
    if (!reviewer?.startsWith('human-confirm:')) throw new Error('缺少人工确认记录');
    const current = read();
    if (current.problems.length) throw new Error('人格读取失败，拒绝写入');
    if (current.revision !== plan.beforeRevision) throw new Error('人格版本已变化，请重新审查');
    const created_at = new Date().toISOString(), snapshot_id = randomUUID();
    const next = { ...plan.next, updatedAt: created_at, setBy: reviewer };
    const nextRaw = JSON.stringify(next, null, 2) + '\n';
    const record = { snapshot_id, created_at, sequence: (storage.records()[0]?.sequence || 0) + 1,
      action: plan.action, changed: plan.changed, reason: plan.reason, reviewer,
      previousRevision: plan.beforeRevision, appliedRevision: revisionOf(nextRaw),
      rollbackOf: plan.rollbackOf, before: plan.before, next, nextRaw };
    storage.transact(record, plan.beforeRevision);
    return { ok: true, ...read() };
  }
  return { read, prepare, commit };
}
