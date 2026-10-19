import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_SELF_POLICY, canSpend, recordSpend, spendToday, selfSpendPath, loadSelfPolicy, saveSelfPolicy,
} from '../../engine/self-agency.mjs';

function ws(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-spend-'));
  if (typeof t?.after === 'function') t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('默认策略：花钱开着，但带单次与每日上限', (t) => {
  const root = ws(t);
  const p = loadSelfPolicy(root);
  assert.equal(p.spend.enabled, true);
  assert.equal(p.spend.perActionCny, 8);
  assert.equal(p.spend.dailyCapCny, 50);
  assert.equal(p.spend.monthlyCapCny, 300);
  assert.equal(p.spend.requireReason, true);
  // 2026-10-20：主人放开花钱 → media 在默认范围内
  assert.ok(p.scopes.includes('media'));
  assert.ok(!p.scopes.includes('external'));
});

test('花费审计：每笔落盘、按天累计、金额可核', (t) => {
  const root = ws(t);
  const now = new Date('2026-10-20T02:00:00Z');
  assert.equal(recordSpend(root, { cny: 1.5, action: 'generate_image', reason: '封面草图' }, { now }), true);
  assert.equal(recordSpend(root, { cny: 2, action: 'generate_tts', reason: '配音试听' }, { now }), true);
  assert.equal(spendToday(root, { now }), 3.5);
  assert.match(fs.readFileSync(selfSpendPath(root), 'utf8'), /理由：封面草图/);
  assert.equal(spendToday(root, { now: new Date('2026-10-21T02:00:00Z') }), 0);
});

test('canSpend：单笔超额 / 每日超额 / 关闭时都拒绝，并给出人话原因', (t) => {
  const root = ws(t);
  const now = new Date('2026-10-20T03:00:00Z');
  const policy = loadSelfPolicy(root);

  assert.equal(canSpend(policy, root, 2, { now }).ok, true);
  assert.match(canSpend(policy, root, 9, { now }).reason, /单次上限/);

  recordSpend(root, { cny: 49, action: 'generate_video', reason: '测试' }, { now });
  assert.match(canSpend(policy, root, 2, { now }).reason, /每日上限/);

  const off = saveSelfPolicy(root, { spend: { enabled: false } });
  assert.match(canSpend(off, root, 1, { now }).reason, /已关/);
});

test('策略文件里 spend 可被读回（含部分字段缺失时的兜底）', (t) => {
  const root = ws(t);
  const saved = saveSelfPolicy(root, { spend: { dailyCapCny: 50 } });
  assert.equal(saved.spend.dailyCapCny, 50);
  assert.equal(saved.spend.perActionCny, DEFAULT_SELF_POLICY.spend.perActionCny);
  assert.equal(saved.spend.enabled, DEFAULT_SELF_POLICY.spend.enabled);
});
