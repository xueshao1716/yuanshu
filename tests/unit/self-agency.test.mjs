import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_SELF_POLICY, SELF_SCOPES, allows, actionsToday, loadSelfPolicy, recordSelfAction,
  saveSelfPolicy, selfAuditPath, selfPolicyPath, selfTools, withinDailyLimit,
} from '../../engine/self-agency.mjs';

const ALL_TOOLS = [
  'read', 'search_files', 'web_search', 'write', 'edit', 'bash', 'todo_write',
  'generate_image', 'generate_video', 'share_project', 'cultivation', 'delegate_team',
].map(name => ({ type: 'function', function: { name } }));

function ws(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-self-agency-'));
  if (typeof t?.after === 'function') t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('默认策略：能写能跑能提交本地，但不放开对外发布与花钱', (t) => {
  const root = ws(t);
  const p = loadSelfPolicy(root);
  assert.equal(p.enabled, true);
  assert.deepEqual(p.scopes, DEFAULT_SELF_POLICY.scopes);
  assert.equal(allows(p, 'workspaceWrite'), true);
  assert.equal(allows(p, 'shell'), true);
  assert.equal(allows(p, 'localGit'), true);
  assert.equal(allows(p, 'media'), false);
  assert.equal(allows(p, 'external'), false);
  assert.equal(allows(p, 'unknown-scope'), false);
});

test('selfTools：只读恒在，危险工具按 scope 放行，未知工具一律不给', (t) => {
  const root = ws(t);
  const names = (p) => selfTools(ALL_TOOLS, p).map(t => t.function.name).sort();

  const dflt = names(loadSelfPolicy(root));
  assert.deepEqual(dflt, ['bash', 'edit', 'read', 'search_files', 'todo_write', 'web_search', 'write']);

  const off = names(saveSelfPolicy(root, { enabled: false }));
  assert.deepEqual(off, ['read', 'search_files', 'web_search']);

  const media = names(saveSelfPolicy(root, { enabled: true, scopes: ['media'] }));
  assert.deepEqual(media, ['generate_image', 'generate_video', 'read', 'search_files', 'web_search']);

  // 没在映射表里的工具（cultivation / delegate_team / share_project 非 external 时）不放开
  assert.equal(names(saveSelfPolicy(root, { enabled: true, scopes: [...SELF_SCOPES] })).includes('cultivation'), false);
  assert.equal(names(saveSelfPolicy(root, { enabled: true, scopes: [...SELF_SCOPES] })).includes('share_project'), true);
});

test('策略文件落在 记忆/运行时/自主执行.json，坏文件回落默认', (t) => {
  const root = ws(t);
  saveSelfPolicy(root, { dailyActions: 5 });
  assert.ok(fs.existsSync(selfPolicyPath(root)));
  const saved = JSON.parse(fs.readFileSync(selfPolicyPath(root), 'utf8'));
  assert.equal(saved.dailyActions, 5);
  fs.writeFileSync(selfPolicyPath(root), '{ 坏掉的 json', 'utf8');
  assert.equal(loadSelfPolicy(root).dailyActions, DEFAULT_SELF_POLICY.dailyActions);
});

test('审计与限频：动作落盘、按天计数、超限即停', (t) => {
  const root = ws(t);
  const now = new Date('2026-10-20T10:00:00Z');
  for (let i = 0; i < 3; i++) {
    assert.equal(recordSelfAction(root, { task: 't1', action: 'write', detail: 'a.md', result: 'ok' }, { now }), true);
  }
  assert.equal(actionsToday(root, { now }), 3);
  assert.match(fs.readFileSync(selfAuditPath(root), 'utf8'), /自主执行审计/);

  const policy = { ...DEFAULT_SELF_POLICY, dailyActions: 3 };
  assert.equal(withinDailyLimit(root, policy, { now }), false);
  assert.equal(withinDailyLimit(root, { ...policy, dailyActions: 4 }, { now }), true);
  // 换一天重新计
  assert.equal(actionsToday(root, { now: new Date('2026-10-21T10:00:00Z') }), 0);
});
