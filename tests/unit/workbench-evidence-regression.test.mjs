import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTeamRunRead } from '../../engine/team-run-read.mjs';
import { createSoilReader } from '../../engine/aibody-soil.mjs';
import { createAIBodyRuntime } from '../../engine/aibody-runtime.mjs';

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
for (const [status, id, expected] of [['running', 'same', 'current'], ['launching', 'same', 'current'], ['completed', 'same', 'history'], ['failed', 'same', 'history'], ['interrupted', 'same', 'history'], ['running', 'other', 'history'], ['blocked', 'same', 'history'], [null, null, 'history']]) {
  test(`snapshot is ${expected} for ${status}/${id}`, t => {
    const wsRoot = workspace(t);
    const file = path.join(wsRoot, '工程/多AI角色扮演系统/team-run.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const contents = JSON.stringify({ launchId: 'same', task: '旧飞天舞' });
    fs.writeFileSync(file, contents);
    const read = createTeamRunRead({ wsRoot, json: (_, status, body) => ({ status, ...body }), getLaunch: () => status ? { status, id } : null });
    assert.equal(read(null).snapshotKind, expected);
    assert.equal(fs.readFileSync(file, 'utf8'), contents);
  });
}
test('readable identity proves file presence, not prompt loading; memory counts headings', t => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, 'APPEND_SYSTEM.md'), 'identity');
  fs.writeFileSync(path.join(root, '记忆.md'), '# 标题\n');
  const state = createSoilReader({ cwd: root, agentDir: root })();
  assert.ok(state.identity.summary.includes('文件可读'));
  assert.ok(!state.identity.summary.includes('已加载'));
  assert.ok(state.memory.summary.includes('1 个标题'));
  const denied = createSoilReader({ cwd: root, agentDir: root, fsMod: { ...fs, readFileSync() { throw new Error('denied'); } } })();
  assert.equal(denied.identity, null);
  assert.equal(denied.memory, null);
});
test('missing governance arrays and invalid gene values do not imply healthy zero counts', () => {
  const state = createSoilReader({ emotion: { getGenome: () => ({ genes: { a: { expression: null, baseline: 0.5 } } }) } })();
  assert.equal(state.governance, null);
  assert.equal(state.genes, null);
});
test('emotion is dated session history, not an unqualified current emotion', () => {
  const state = createSoilReader({ emotion: { getSnapshot: () => ({ primary: 'happy', intensity: .7, lastTalk: '2026-09-20T00:00:00Z' }) } })({ sessionId: 's' });
  assert.ok(state.emotion.summary.includes('最近会话记录'));
  assert.equal(state.emotion.details.sessionId, 's');
  assert.ok(state.emotion.summary.includes('09-20'));
});
test('continuity distinguishes restored records from resumed work; evolution is policy, not a verified capability', t => {
  const rootDir = workspace(t);
  const first = createAIBodyRuntime({ rootDir });
  first.beginTurn({ runId: 'r', sessionId: 's', message: '继续做' });
  const view = createAIBodyRuntime({ rootDir }).overview();
  assert.equal(view.currentRun.status, 'interrupted');
  assert.ok(view.theory.find(x => x.id === 'continuity').detail.includes('不会自动续跑'));
  assert.equal(view.evolution.rollback, null);
  assert.equal(view.evolution.humanApproval, null);
  assert.equal(view.evolution.status, 'policy_only');
  assert.equal(view.observationContext.sessionId, 's');
});
test('team UI collapses historical snapshots and warns about workflow version only when missing', () => {
  const src = fs.readFileSync(new URL('../../frontend/src/components/TeamRunView.tsx', import.meta.url), 'utf8');
  assert.ok(src.includes("data?.snapshotKind === 'current'"));
  assert.ok(src.includes('open={isCurrent}'));
  assert.ok(src.includes('历史运行记录'));
  assert.ok(src.includes('!run.profile?.version &&'));
});
