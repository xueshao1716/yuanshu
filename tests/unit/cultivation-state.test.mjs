// tests/unit/cultivation-state.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {validScope, emptyRecord, validateRecord, advanceRecord, MAX_AUDIT}
  from '../../engine/cultivation/state.mjs';

const workspace = 'a'.repeat(64);
const event = {actor: 'service:fixture', action: 'design.saved', at: '2026-09-30T12:00:00.000Z'};

test('仅允许 control 或 UUID，不允许人物名称或路径', () => {
  assert.equal(validScope('control'), true);
  assert.equal(validScope(randomUUID()), true);
  for (const scope of ['小语', '../mother', 'A/B', 'A\\B', '', 'CON', 'control.json'])
    assert.equal(validScope(scope), false);
});

test('推进版本不修改旧对象，状态与审计同时生成', () => {
  const base = emptyRecord(workspace, randomUUID());
  const payload = {layers: {temporary: {expression: 'serious'}, stable: {}, knowledgeRefs: []},
    appearance: {assetId: 'fixture-a'}, voice: {voiceId: 'fixture-voice'}};
  const next = advanceRecord(base, payload, event);
  assert.equal(base.revision, 0);
  assert.deepEqual(base.audit, []);
  assert.equal(next.revision, 1);
  assert.equal(next.audit[0].revision, 1);
  assert.equal(next.audit[0].actor, event.actor);
  assert.equal(next.createdAt, event.at);
  next.data.layers.temporary.expression = 'changed';
  assert.equal(payload.layers.temporary.expression, 'serious');
  const second = advanceRecord(next, {note: 'revision two'}, {...event, action: 'corrected'});
  assert.equal(second.audit.length, 2);
  assert.deepEqual(second.audit[0], next.audit[0]);
  assert.equal(validateRecord(second, workspace, base.scope).revision, 2);
  const detached = validateRecord(second, workspace, base.scope);
  detached.audit[0].action = 'mutated';
  assert.equal(second.audit[0].action, event.action);
  const earlier = advanceRecord(second, {}, {...event, at: '2026-09-29T12:00:00.000Z'});
  assert.equal(earlier.updatedAt, second.updatedAt);
  assert.equal(earlier.audit.at(-1).at, second.updatedAt);
});

test('拒绝损坏、异域、过大/非 JSON 数据，不绕过审计容量', () => {
  const base = emptyRecord(workspace, randomUUID());
  assert.throws(() => validateRecord(base, 'b'.repeat(64), base.scope), /invalid_record/);
  assert.throws(() => advanceRecord(base, {n: NaN}, event), /invalid_payload/);
  assert.throws(() => advanceRecord(base, {n: undefined}, event), /invalid_payload/);
  assert.throws(() => advanceRecord(base, {s: 'x'.repeat(32769)}, event), /invalid_payload/);
  assert.throws(() => advanceRecord(base, JSON.parse('{"__proto__":{}}'), event), /invalid_payload/);
  assert.throws(() => advanceRecord(base, {items: Array(1)}, event), /invalid_payload/);
  let deep = {};
  for (let i = 0; i < 14; i++) deep = {nested: deep};
  assert.throws(() => advanceRecord(base, deep, event), /invalid_payload/);
  assert.throws(() => advanceRecord(base, {}, {...event, actor: ''}), /invalid_record/);
  let row = base;
  for (let i = 0; i < MAX_AUDIT; i++) row = advanceRecord(row, {n: i}, event);
  assert.equal(row.audit.length, MAX_AUDIT);
  assert.throws(() => advanceRecord(row, {}, event), /audit_full/);
  const corrupt = structuredClone(row);
  corrupt.audit[0].revision = 9;
  assert.throws(() => validateRecord(corrupt, workspace, base.scope), /invalid_record/);
});

test('拒绝 JSON 序列化会静默丢失或执行的属性', () => {
  const base = emptyRecord(workspace, randomUUID());
  const array = [1];
  array.note = 'not serialized';
  let getterRuns = 0;
  const accessor = Object.defineProperty({}, 'value', {enumerable: true,
    get() { getterRuns++; return 'side effect'; }});
  const hidden = Object.defineProperty({}, 'value', {value: 'not serialized'});
  for (const data of [{items: array}, {[Symbol('hidden')]: true}, hidden, accessor])
    assert.throws(() => advanceRecord(base, data, event), /invalid_payload/);
  assert.equal(getterRuns, 0);
});
