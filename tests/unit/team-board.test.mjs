// ===== team-board.test.mjs —— 团队共享任务看板（2026-11-15）=====
//
// 五条线一起锁：
//   ① schema：一个 team_board 工具带 6 个动作，使用纪律写死在 description 里（模型只看得到那段）
//   ② 状态机：create / list / ready / claim / complete / release，以及依赖完成后的 ready 传播
//   ③ 乐观并发：expectedRevision 不符 → 冲突且不覆盖；同一 owner 幂等；别人已占拒绝
//   ④ 存储：记忆/运行时/团队看板/<teamId>.json、原子写 + 一份 .bak、teamId 不存在不炸
//   ⑤ 接线：UNIFIED_TOOLS / 执行器表 / team-launch 落空板 / team-subagents 注入 / team-completion 收尾提示
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

import {
  TEAM_BOARD_TOOL, TEAM_BOARD_ACTIONS, TASK_STATUSES, BOARD_REL_DIR,
  configureTeamBoard, createTask, listTasks, claimTask, completeTask, releaseTask,
  editTask, setDependencies, boardSummary, formatBoardContext, formatBoardReminder,
  readBoard, ensureBoard, teamBoardPath, executeTeamBoard,
} from '../../engine/team-board.mjs';
import { createTeamLauncher } from '../../engine/team-launch.mjs';
import { executeTeam } from '../../engine/team-subagents.mjs';
import { createTeamCompletion } from '../../engine/team-completion.mjs';
import { initSubagent } from '../../engine/subagent.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-team-board-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const opts = (root) => ({ wsRoot: root });

/** 与 tests/unit/team-subagents.test.mjs 同形的子代理假通道：只回固定正文。 */
function setupSubagent(t, replies) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-team-board-sub-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requests = [];
  initSubagent({
    traceDir: path.join(root, 'traces'),
    getDefaultModel: () => ({ provider: 'fake', id: 'test' }),
    getFlashModel: () => null,
    modelReader: () => ({ fake: { models: [{ id: 'test', baseUrl: 'https://fake.invalid', reasoning: true }] } }),
    resolveAuth: () => ({ baseUrl: 'https://fake.invalid' }),
    authReader: () => ({ fake: { type: 'api_key', key: 'test' } }),
    httpFetch: async (_url, reqOpts) => {
      const body = JSON.parse(reqOpts.body);
      requests.push(body);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: replies.shift() ?? '正文' } }] }) };
    },
  });
  return { root, requests };
}

test('schema：一个工具六个动作、必填关系与使用纪律写死在 description', () => {
  const fn = TEAM_BOARD_TOOL.function;
  assert.equal(TEAM_BOARD_TOOL.type, 'function');
  assert.equal(fn.name, 'team_board');
  assert.deepEqual(fn.parameters.properties.action.enum, [...TEAM_BOARD_ACTIONS]);
  assert.deepEqual([...TEAM_BOARD_ACTIONS], ['create', 'list', 'claim', 'complete', 'release', 'summary']);
  assert.deepEqual(TASK_STATUSES, ['pending', 'in_progress', 'completed', 'blocked']);
  assert.deepEqual(fn.parameters.required, ['action']);
  assert.equal(fn.parameters.properties.expectedRevision.type, 'number');
  assert.equal(fn.parameters.properties.writeScopes.type, 'array');
  assert.equal(fn.parameters.properties.blockedBy.type, 'array');
  assert.equal(fn.parameters.properties.ready.type, 'boolean');

  // 描述是唯一常驻上下文的地方：纪律必须在这里，不能只写在注释里。
  assert.match(fn.description, /领活前先 list/);
  assert.match(fn.description, /claim 必须带 expectedRevision/);
  assert.match(fn.description, /同一文件不要两个 in_progress/);
  assert.match(fn.description, /writeScopes/);
  assert.match(fn.description, /不替代验收/);

  // 执行器层的必填关系：缺 action / 未知 action 都直接拒。
  assert.equal(executeTeamBoard({}, { wsRoot: os.tmpdir() }).isError, true);
  assert.match(executeTeamBoard({ action: 'nope' }, { wsRoot: os.tmpdir() }).text, /action 必须是/);
});

test('建/列：默认字段、写范围归一、文件落在 记忆/运行时/团队看板/<teamId>.json', t => {
  const root = workspace(t);
  const a = createTask('board-team', { subject: '改引擎入口', detail: '只改 team-launch', writeScopes: ['engine\\team-launch.mjs'], owner: '小语' }, opts(root));
  assert.equal(a.ok, true, a.error);
  assert.deepEqual(Object.keys(a.task).sort(),
    ['blockedBy', 'completedAt', 'detail', 'id', 'owner', 'result', 'revision', 'status', 'subject', 'writeScopes'].sort());
  assert.equal(a.task.status, 'pending');
  assert.equal(a.task.owner, '小语');           // create 的 owner 只是预填标注，占用仍要 claim
  assert.equal(a.task.blockedBy.length, 0);
  assert.deepEqual(a.task.writeScopes, ['engine/team-launch.mjs']);  // 反斜杠归一成 /
  assert.equal(a.task.result, null);
  assert.equal(a.task.completedAt, null);
  assert.equal(a.task.revision, 1);
  const b = createTask('board-team', { subject: '补测试' }, opts(root));
  assert.notEqual(a.task.id, b.task.id);

  const file = path.join(root, BOARD_REL_DIR, 'board-team.json');
  assert.equal(teamBoardPath('board-team', opts(root)), file);
  assert.ok(fs.existsSync(file), '看板必须落盘');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.teamId, 'board-team');
  assert.ok(raw.createdAt && raw.updatedAt);
  assert.equal(raw.tasks.length, 2);

  const all = listTasks('board-team', {}, opts(root));
  assert.equal(all.ok, true);
  assert.equal(all.total, 2);
  assert.deepEqual(all.tasks.map(task => task.subject), ['改引擎入口', '补测试']);
  assert.deepEqual(listTasks('board-team', { status: 'completed' }, opts(root)).tasks, []);
  assert.equal(listTasks('board-team', { owner: '小语' }, opts(root)).tasks.length, 1);
  assert.equal(readBoard('board-team', opts(root)).tasks.length, 2);
});

test('ready：依赖没完成不算 ready，也不许领；依赖完成之后自动变 ready', t => {
  const root = workspace(t);
  const dep = createTask('ready-team', { subject: '先修数据层' }, opts(root)).task;
  const next = createTask('ready-team', { subject: '再改接口', blockedBy: [dep.id] }, opts(root)).task;

  let ready = listTasks('ready-team', { ready: true }, opts(root)).tasks;
  assert.deepEqual(ready.map(task => task.id), [dep.id], '只有依赖已完成的才算 ready');
  const view = listTasks('ready-team', {}, opts(root)).tasks.find(task => task.id === next.id);
  assert.equal(view.ready, false);
  assert.deepEqual(view.pendingBlockedBy, [dep.id]);

  // 依赖未完成 → claim 被拒（不只是 list 里不显示）
  const blocked = claimTask('ready-team', next.id, 'bob', { ...opts(root), expectedRevision: next.revision });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blocked, true);
  assert.deepEqual(blocked.blockedBy, [dep.id]);

  assert.equal(claimTask('ready-team', dep.id, 'alice', { ...opts(root), expectedRevision: dep.revision }).ok, true);
  assert.equal(completeTask('ready-team', dep.id, 'alice', { ...opts(root), result: '数据层修好' }).ok, true);

  ready = listTasks('ready-team', { ready: true }, opts(root)).tasks;
  assert.deepEqual(ready.map(task => task.id), [next.id], '依赖完成后依赖者变 ready');
  const claimNext = claimTask('ready-team', next.id, 'bob', { ...opts(root), expectedRevision: next.revision });
  assert.equal(claimNext.ok, true, claimNext.error);
});

test('claim：同一 owner 重复认领幂等；别人已占 → 拒绝且不改归属', t => {
  const root = workspace(t);
  const task = createTask('claim-team', { subject: '写启动脚本' }, opts(root)).task;

  const first = claimTask('claim-team', task.id, 'alice', { ...opts(root), expectedRevision: task.revision });
  assert.equal(first.ok, true);
  assert.equal(first.task.status, 'in_progress');
  assert.equal(first.task.owner, 'alice');
  assert.equal(first.task.revision, 2);

  const again = claimTask('claim-team', task.id, 'alice', { ...opts(root), expectedRevision: 2 });
  assert.equal(again.ok, true);
  assert.equal(again.already, true);
  assert.equal(again.task.revision, 2, '幂等认领不该再涨 revision');

  const stolen = claimTask('claim-team', task.id, 'bob', { ...opts(root), expectedRevision: 2 });
  assert.equal(stolen.ok, false);
  assert.equal(stolen.occupied, true);
  assert.equal(stolen.owner, 'alice');
  assert.match(stolen.error, /已被 alice 占用/);

  const stored = readBoard('claim-team', opts(root)).tasks.find(item => item.id === task.id);
  assert.equal(stored.owner, 'alice');
  assert.equal(stored.status, 'in_progress');
  assert.equal(stored.revision, 2);
});

test('claim 乐观并发：revision 不符 → 冲突，且不覆盖看板', t => {
  const root = workspace(t);
  const task = createTask('rev-team', { subject: '改接口' }, opts(root)).task;
  const file = teamBoardPath('rev-team', opts(root));

  const stale = claimTask('rev-team', task.id, 'alice', { ...opts(root), expectedRevision: 99 });
  assert.equal(stale.ok, false);
  assert.equal(stale.conflict, true);
  assert.equal(stale.revision, 1);
  assert.match(stale.error, /revision 冲突/);
  let stored = JSON.parse(fs.readFileSync(file, 'utf8')).tasks[0];
  assert.equal(stored.status, 'pending');
  assert.equal(stored.owner, null);
  assert.equal(stored.revision, 1, '冲突的那次不许写盘');

  assert.equal(claimTask('rev-team', task.id, 'alice', { ...opts(root), expectedRevision: 1 }).ok, true);
  // complete 带过期 revision 同样拒绝（看板上已经是 rev=2）
  const staleComplete = completeTask('rev-team', task.id, 'alice', { ...opts(root), expectedRevision: 1, result: '做完了' });
  assert.equal(staleComplete.conflict, true);
  stored = JSON.parse(fs.readFileSync(file, 'utf8')).tasks[0];
  assert.equal(stored.status, 'in_progress');
  assert.equal(stored.result, null);
  assert.equal(completeTask('rev-team', task.id, 'alice', { ...opts(root), expectedRevision: 2, result: '做完了' }).ok, true);
});

test('complete / release：状态机与归属，完成是终态', t => {
  const root = workspace(t);
  const a = createTask('flow-team', { subject: 'A' }, opts(root)).task;
  const b = createTask('flow-team', { subject: 'B' }, opts(root)).task;

  // 没认领不能完成
  assert.match(completeTask('flow-team', a.id, 'alice', opts(root)).error, /只有 in_progress/);
  assert.equal(claimTask('flow-team', a.id, 'alice', { ...opts(root), expectedRevision: a.revision }).ok, true);

  // 别人不能替我完成 / 释放
  assert.match(completeTask('flow-team', a.id, 'bob', opts(root)).error, /不能替它完成/);
  assert.match(releaseTask('flow-team', a.id, 'bob', opts(root)).error, /不能替它释放/);

  const done = completeTask('flow-team', a.id, 'alice', { ...opts(root), result: '已改完，测试绿' });
  assert.equal(done.ok, true);
  assert.equal(done.task.status, 'completed');
  assert.equal(done.task.result, '已改完，测试绿');
  assert.ok(Number.isFinite(Date.parse(done.task.completedAt)));
  assert.equal(done.task.revision, 3);
  assert.equal(completeTask('flow-team', a.id, 'alice', opts(root)).already, true, '重复完成幂等');
  assert.match(completeTask('flow-team', a.id, 'bob', opts(root)).error, /已经完成/);
  assert.equal(claimTask('flow-team', a.id, 'bob', { ...opts(root), expectedRevision: 3 }).error, '任务已完成，不能领取');
  assert.match(releaseTask('flow-team', a.id, 'alice', opts(root)).error, /已完成是终态/);

  // 释放后能被别人领
  assert.equal(claimTask('flow-team', b.id, 'alice', { ...opts(root), expectedRevision: b.revision }).ok, true);
  const released = releaseTask('flow-team', b.id, 'alice', opts(root));
  assert.equal(released.ok, true);
  assert.equal(released.task.status, 'pending');
  assert.equal(released.task.owner, null);
  assert.equal(released.task.result, null);
  assert.equal(released.task.revision, 3);
  assert.equal(claimTask('flow-team', b.id, 'bob', { ...opts(root), expectedRevision: 3 }).ok, true);
});

test('writeScopes 重叠：两个 in_progress 同范围 → summary.conflicts 非空', t => {
  const root = workspace(t);
  const a = createTask('scope-team', { subject: '改引擎入口', writeScopes: ['engine/team-launch.mjs'] }, opts(root)).task;
  const b = createTask('scope-team', { subject: '重构引擎', writeScopes: ['engine'] }, opts(root)).task;
  const c = createTask('scope-team', { subject: '改测试', writeScopes: ['tests/unit/team-board.test.mjs'] }, opts(root)).task;
  assert.equal(claimTask('scope-team', a.id, 'alice', { ...opts(root), expectedRevision: a.revision }).ok, true);
  assert.equal(claimTask('scope-team', b.id, 'bob', { ...opts(root), expectedRevision: b.revision }).ok, true);

  let summary = boardSummary('scope-team', opts(root));
  assert.equal(summary.ok, true);
  assert.equal(summary.conflicts.length, 1, 'engine/team-launch.mjs 落在 engine 下面，算重叠');
  assert.deepEqual(summary.conflicts[0].taskIds, [a.id, b.id]);
  assert.deepEqual(summary.conflicts[0].owners, ['alice', 'bob']);
  assert.ok(summary.conflicts[0].scope.some(scope => scope.startsWith('engine')), '冲突要带具体范围');

  // 第三个任务范围不重叠（还没认领，本来也不算）；释放 b 之后冲突消失
  assert.equal(claimTask('scope-team', c.id, 'carol', { ...opts(root), expectedRevision: c.revision }).ok, true);
  summary = boardSummary('scope-team', opts(root));
  assert.equal(summary.conflicts.length, 1, '只和 engine 范围冲突，不串到 tests');
  assert.equal(releaseTask('scope-team', b.id, 'bob', opts(root)).ok, true);
  assert.deepEqual(boardSummary('scope-team', opts(root)).conflicts, []);
});

test('summary / 上下文：计数、未认领、可领、收尾提示', t => {
  const root = workspace(t);
  const a = createTask('sum-team', { subject: 'A' }, opts(root)).task;
  const b = createTask('sum-team', { subject: 'B', blockedBy: [a.id] }, opts(root)).task;
  createTask('sum-team', { subject: 'C' }, opts(root));
  assert.equal(claimTask('sum-team', a.id, 'alice', { ...opts(root), expectedRevision: a.revision }).ok, true);

  const summary = boardSummary('sum-team', opts(root));
  assert.equal(summary.total, 3);
  assert.deepEqual(summary.byStatus, { pending: 2, in_progress: 1, completed: 0, blocked: 0 });
  assert.equal(summary.unowned, 2, '未认领 = 非 completed 且没 owner');
  assert.deepEqual(summary.ready.map(task => task.subject), ['C']);
  assert.deepEqual(summary.inProgress.map(task => task.owner), ['alice']);

  const context = formatBoardContext(summary);
  assert.match(context, /团队共享看板 · sum-team/);
  assert.match(context, /可领（依赖已完成、没人占）：.*C/);
  assert.match(context, /进行中：.*A（alice）/);
  assert.match(formatBoardReminder(summary), /还有 3 项没收尾/, '未收尾 = 待办 2 + 进行中 1');
  assert.equal(formatBoardContext(boardSummary('empty-team', opts(root))), '', '空板不污染提示词');

  assert.equal(completeTask('sum-team', a.id, 'alice', { ...opts(root), result: 'ok' }).ok, true);
  assert.equal(claimTask('sum-team', b.id, 'bob', { ...opts(root), expectedRevision: b.revision }).ok, true);
  assert.equal(completeTask('sum-team', b.id, 'bob', opts(root)).ok, true);
  const c = listTasks('sum-team', { status: 'pending' }, opts(root)).tasks[0];
  assert.equal(claimTask('sum-team', c.id, 'carol', { ...opts(root), expectedRevision: c.revision }).ok, true);
  assert.equal(completeTask('sum-team', c.id, 'carol', opts(root)).ok, true);
  const after = boardSummary('sum-team', opts(root));
  assert.equal(formatBoardReminder(after), '', '全做完就不再提示');
});

test('editTask / setDependencies：改字段带并发检查，依赖不能自指/成环', t => {
  const root = workspace(t);
  const a = createTask('edit-team', { subject: 'A' }, opts(root)).task;
  const b = createTask('edit-team', { subject: 'B' }, opts(root)).task;

  const edited = editTask('edit-team', a.id, { subject: 'A2', detail: '补验收标准' }, { ...opts(root), expectedRevision: 1 });
  assert.equal(edited.ok, true);
  assert.equal(edited.task.subject, 'A2');
  assert.equal(edited.task.revision, 2);
  assert.equal(editTask('edit-team', a.id, { subject: 'A3' }, { ...opts(root), expectedRevision: 1 }).conflict, true);
  assert.equal(editTask('edit-team', a.id, { status: 'completed' }, opts(root)).ok, false, '状态机只能走 claim/complete');

  // 依赖：未知 id / 自指 / 成环都拒绝
  assert.match(setDependencies('edit-team', b.id, ['missing'], opts(root)).error, /不存在/);
  assert.match(setDependencies('edit-team', b.id, [b.id], opts(root)).error, /不能依赖自己/);
  assert.equal(setDependencies('edit-team', b.id, [a.id], opts(root)).ok, true);
  const cycle = setDependencies('edit-team', a.id, [b.id], opts(root));
  assert.equal(cycle.ok, false);
  assert.match(cycle.error, /成环/);
  assert.equal(listTasks('edit-team', { ready: true }, opts(root)).tasks.length, 1, 'B 依赖 A，A 才是 ready');

  // blocked <-> pending 只能由 edit 走
  const blocked = editTask('edit-team', a.id, { status: 'blocked' }, opts(root));
  assert.equal(blocked.ok, true);
  assert.match(claimTask('edit-team', a.id, 'alice', { ...opts(root), expectedRevision: blocked.task.revision }).error, /blocked/);
  assert.equal(editTask('edit-team', a.id, { status: 'pending' }, opts(root)).ok, true);
});

test('落盘：原子写 + 写前留一份 .bak；ensureBoard 不重置已有任务', t => {
  const root = workspace(t);
  const file = teamBoardPath('disk-team', opts(root));
  ensureBoard('disk-team', opts(root));
  assert.ok(fs.existsSync(file));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).tasks, []);
  assert.equal(fs.existsSync(`${file}.bak`), false, '第一次写没有旧文件可备份');

  const task = createTask('disk-team', { subject: '留档任务' }, opts(root)).task;
  const emptyBackup = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'));
  assert.deepEqual(emptyBackup.tasks, [], '.bak 是写前那一版（ensureBoard 的空板）');
  assert.equal(claimTask('disk-team', task.id, 'alice', { ...opts(root), expectedRevision: 1 }).ok, true);
  const backup = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'));
  assert.equal(backup.tasks.length, 1);
  assert.equal(backup.tasks[0].status, 'pending', '.bak 是写前那一版');

  const ensured = ensureBoard('disk-team', opts(root));
  assert.equal(ensured.tasks.length, 1);
  assert.equal(ensured.tasks[0].owner, 'alice', 'ensureBoard 不能重置已有任务');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).tasks[0].revision, 2);
});

test('teamId 不存在 / 非法时不炸：返回空结果或错误对象，不抛异常', t => {
  const root = workspace(t);
  const missing = listTasks('never-created', {}, opts(root));
  assert.equal(missing.ok, true);
  assert.equal(missing.total, 0);
  assert.equal(missing.missing, true);
  assert.deepEqual(missing.tasks, []);
  const emptySummary = boardSummary('never-created', opts(root));
  assert.equal(emptySummary.total, 0);
  assert.deepEqual(emptySummary.byStatus, { pending: 0, in_progress: 0, completed: 0, blocked: 0 });
  assert.deepEqual(emptySummary.ready, []);
  assert.deepEqual(emptySummary.conflicts, []);
  assert.equal(claimTask('never-created', 't-x', 'alice', opts(root)).ok, false);
  assert.equal(completeTask('never-created', 't-x', 'alice', opts(root)).ok, false);
  assert.equal(createTask('', { subject: 'x' }, opts(root)).ok, false, '空 teamId 返回错误而不是抛');
  assert.equal(createTask('../逃出去', { subject: 'x' }, opts(root)).ok, false, '路径穿越的 teamId 被拒');
  assert.equal(listTasks('../逃出去', {}, opts(root)).ok, false);
  assert.equal(boardSummary('../逃出去', opts(root)).ok, false);
  assert.equal(createTask('never-created', { subject: '  ' }, opts(root)).ok, false, '空 subject 被拒');
});

test('默认根：configureTeamBoard 之后不传 wsRoot 也能用（测试与脚本入口）', t => {
  const root = workspace(t);
  configureTeamBoard({ wsRoot: root });
  try {
    const created = createTask('cfg-team', { subject: '默认根' });
    assert.equal(created.ok, true, created.error);
    assert.ok(fs.existsSync(teamBoardPath('cfg-team')));
    assert.equal(listTasks('cfg-team').tasks.length, 1);
  } finally {
    configureTeamBoard({ wsRoot: '' });
  }
});

test('执行器 team_board：六个动作走同一套闸门（与 server 同形）', t => {
  const root = workspace(t);
  const ctx = { wsRoot: root, teamId: 'tool-team' };
  const created = executeTeamBoard({ action: 'create', subject: '改看板', writeScopes: ['engine/team-board.mjs'], blockedBy: [] }, ctx);
  assert.equal(created.isError, false, created.text);
  const taskId = created.details.task.id;
  assert.match(created.text, /已建任务/);

  const listed = executeTeamBoard({ action: 'list', ready: true }, ctx);
  assert.equal(listed.isError, false);
  assert.match(listed.text, /看板 tool-team/);
  assert.match(listed.text, /可领/);
  assert.equal(listed.details.tasks[0].id, taskId);

  // claim 不带 expectedRevision → 直接拒（防盲抢）
  const noRev = executeTeamBoard({ action: 'claim', taskId, owner: 'alice' }, ctx);
  assert.equal(noRev.isError, true);
  assert.match(noRev.text, /expectedRevision/);
  // 过期 revision → 冲突
  const stale = executeTeamBoard({ action: 'claim', taskId, owner: 'alice', expectedRevision: 99 }, ctx);
  assert.equal(stale.isError, true);
  assert.match(stale.text, /revision 冲突/);
  const claimed = executeTeamBoard({ action: 'claim', taskId, owner: 'alice', expectedRevision: 1 }, ctx);
  assert.equal(claimed.isError, false, claimed.text);
  assert.match(claimed.text, /已认领/);

  const completed = executeTeamBoard({ action: 'complete', taskId, owner: 'alice', expectedRevision: 2, result: '改完，node --check 通过' }, ctx);
  assert.equal(completed.isError, false, completed.text);
  assert.equal(completed.details.task.result, '改完，node --check 通过');

  const summary = executeTeamBoard({ action: 'summary' }, ctx);
  assert.equal(summary.isError, false);
  assert.match(summary.text, /已完成 1/);
  assert.match(summary.text, /写范围冲突：无/);

  // teamId 兜底：不给 args.teamId 时用 ctx.runId
  const viaRun = executeTeamBoard({ action: 'create', subject: '跑号兜底' }, { wsRoot: root, runId: 'run-fallback' });
  assert.equal(viaRun.isError, false, viaRun.text);
  assert.ok(fs.existsSync(teamBoardPath('run-fallback', opts(root))));
  // 未知 action
  assert.equal(executeTeamBoard({ action: 'drop' }, ctx).isError, true);
});

test('接线：server 的 UNIFIED_TOOLS / 执行器表 / createTeamCompletion 注入 wsRoot', () => {
  const src = read('server.mjs');
  const start = src.indexOf('const UNIFIED_TOOLS = [');
  assert.ok(start > 0, '找不到 UNIFIED_TOOLS');
  const end = src.indexOf('\n];', start);
  assert.ok(end > start, '找不到 UNIFIED_TOOLS 的收尾');
  assert.match(src.slice(start, end), /^\s*TEAM_BOARD_TOOL,\s*$/m, 'team_board 必须进 UNIFIED_TOOLS');

  const exStart = src.indexOf('const extraToolExecutors = {');
  assert.ok(exStart > 0, '找不到执行器表 extraToolExecutors');
  const exEnd = src.indexOf('\n};', exStart);
  assert.match(src.slice(exStart, exEnd), /^\s*team_board:\s*\(args,\s*ctx\)\s*=>/m, '执行器表里必须有 team_board');

  assert.match(src, /import\s*\{[^}]*TEAM_BOARD_TOOL[^}]*\}\s*from\s*['"]\.\/engine\/team-board\.mjs['"]/);
  assert.ok(src.indexOf('import { TEAM_BOARD_TOOL') < start, '导入必须早于 UNIFIED_TOOLS（模块求值期就构造数组）');
  assert.match(src, /createTeamCompletion\(\{\s*launcher:\s*teamLauncher,\s*wsRoot:\s*CONFIG\.cwd\s*\}\)/,
    '天团收尾读看板要用工作区根，不能靠 process.cwd()');
});

test('接线：team-launch 建团队就预建阶段任务，续跑沿用同一 teamId 不丢任务', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-team-board-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = new EventEmitter();
  child.pid = process.pid;
  child.unref = () => {};
  const launcher = createTeamLauncher({
    wsRoot: root, repoRoot: path.resolve('.'), port: 18990, token: 'fixture-secret',
    spawnProcess: () => child,
  });

  const pending = launcher.start('带看板的任务');
  child.emit('spawn');
  const launchId = (await pending).body.launch.id;
  const file = path.join(root, BOARD_REL_DIR, `${launchId}.json`);
  assert.ok(fs.existsSync(file), '建团队时就要有看板文件');
  const seeded = JSON.parse(fs.readFileSync(file, 'utf8')).tasks;
  assert.deepEqual(seeded.map(task => task.status), ['pending', 'pending', 'pending', 'pending', 'pending'],
    '开局由主控预建阶段任务，成员自己 claim');
  assert.deepEqual(seeded.map(task => task.subject.split('：')[0]), ['ANALYST', 'VIDEO', 'GUARDIAN', 'ARBIT', 'REVIEWER']);
  assert.ok(seeded.every(task => task.owner === null), '预建任务不预占负责人');
  assert.ok(seeded.every(task => Array.isArray(task.writeScopes) && task.writeScopes.length === 0),
    '成员不改文件，writeScopes 可空');

  // 往板上放一条任务，模拟成员还没做完就中断
  assert.equal(createTask(launchId, { subject: '别丢我' }, opts(root)).ok, true);
  child.emit('exit', 1, null); // 失败退出 → 允许 resume

  const resumed = launcher.resume(launchId);
  child.emit('spawn');
  const result = await resumed;
  assert.equal(result.status, 200);
  assert.notEqual(result.body.launch.id, launchId, '续跑是新 launch 编号');
  const board = readBoard(launchId, opts(root)); // teamId 沿用 checkpointId（= 原 launchId）
  assert.equal(board.tasks.length, 6, '续跑不能把已认领的任务冲掉');
  assert.equal(board.tasks.find(task => task.subject === '别丢我').subject, '别丢我');
  assert.equal(board.tasks.filter(task => task.subject.startsWith('ANALYST')).length, 1, '预建任务幂等，不重复建');
  child.emit('exit', 1, null);
});

test('接线：team-subagents 预建阶段任务、把 boardSummary 注入每个成员，收尾提示不阻断', async t => {
  const draft = '# 可拍脚本\n' + '具体镜头及口播。'.repeat(80);
  const { root, requests } = setupSubagent(t, ['方向要点', '质疑要点', draft, '{"pass":true,"issues":[]}']);
  createTask('parent', { subject: '改引擎入口', owner: '小语' }, opts(root));
  createTask('parent', { subject: '补测试' }, opts(root));

  const result = await executeTeam({ task: '做探店账号进三期脚本' }, { wsRoot: root, sessionId: 's', runId: 'parent' });
  assert.equal(result.isError, false, result.text);
  assert.equal(requests.length, 4);
  // 主控预建了本趟四个阶段任务，成员提示里能看到（预建 + 手工共 6 项）。
  const board = readBoard('parent', opts(root));
  assert.equal(board.tasks.filter(task => /^(IDEA|CHALLENGE|EXEC|REVIEW)：/.test(task.subject)).length, 4,
    '开局预建 IDEA/CHALLENGE/EXEC/REVIEW 四个阶段任务');
  assert.ok(requests.every(req => JSON.stringify(req.messages).includes('团队共享看板 · parent')),
    '每个成员都要看到共享看板');
  assert.ok(requests.every(req => JSON.stringify(req.messages).includes('改引擎入口')));
  // 成员提示里写死看板纪律（先 list、claim 带 expectedRevision、complete/release）。
  assert.ok(requests.every(req => /开工前先 team_board/.test(JSON.stringify(req.messages))));
  assert.ok(requests.every(req => /expectedRevision/.test(JSON.stringify(req.messages))));
  assert.match(result.text, /【看板】还有 6 项没收尾/);
  assert.equal(result.artifact !== undefined, true, '提示不阻断交付');
});

test('接线：team-completion 收尾把未完成任务标出来，但照常返回正文（不阻断）', async t => {
  const { root } = setupSubagent(t, ['正文草稿']);
  const teamId = 'completion-team';
  const created = createTask(teamId, { subject: '待收尾的活' }, opts(root)).task;
  const complete = createTeamCompletion({
    launcher: { childContext: id => (id === 'active' ? { runId: 'parent', sessionId: 'session', teamId, onEvent: () => {} } : null) },
    wsRoot: root,
  });

  const r = await complete({ launchId: 'active', role: 'VIDEO', provider: 'fake', modelId: 'test', message: 'draft' });
  assert.match(r.text, /正文草稿/, '有未完成任务也必须正常返回正文');
  assert.equal(r.board.teamId, teamId);
  assert.equal(r.board.pending, 1);
  assert.match(r.note, /未收尾/);
  assert.match(r.board.hint, /团队共享看板/);

  // 全部收尾之后不再提示
  assert.equal(claimTask(teamId, created.id, 'alice', { ...opts(root), expectedRevision: 1 }).ok, true);
  assert.equal(completeTask(teamId, created.id, 'alice', { ...opts(root), result: 'done' }).ok, true);
  const clean = await complete({ launchId: 'active', role: 'VIDEO', provider: 'fake', modelId: 'test', message: 'draft' });
  assert.equal(clean.board, undefined);
  assert.equal(clean.note, 'ok');
});
