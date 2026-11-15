// 天团成员工具（2026-11-15）：只读检索 + 共享看板，但写不了/跑不了/生不了/派不了。
//
// 锁五条线：
//   ① 工具表 = read/list/grep/web_search + team_board，不多不少；写/命令/生图/派活不在里面
//   ② 未授权工具调用 → 明确拒绝文本（不是静默丢弃），成员能换路继续
//   ③ 看板：成员能 list/claim/complete/release，不能 create；owner/teamId 由宿主固定
//   ④ 成本闸：12 轮 / 40 次，到顶强制收尾（假执行器计数，不发真实请求）
//   ⑤ 每次成员工具调用写 动作审计.jsonl，带 member / teamId / before-after
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  initSubagent, spawnSubagent,
  TEAM_MEMBER_TOOLS, TEAM_MEMBER_READ_TOOLS, TEAM_MEMBER_BOARD_TOOL, TEAM_MEMBER_BOARD_ACTIONS,
  TEAM_MEMBER_DENIED_TOOLS, TEAM_MEMBER_MAX_STEPS, TEAM_MEMBER_MAX_TOOL_CALLS,
  resolveToolPolicy, judgeTeamMemberTool, judgeTeamBoardAction,
} from '../../engine/subagent.mjs';
import { createTask, readBoard, listTasks } from '../../engine/team-board.mjs';
import { executeTeam } from '../../engine/team-subagents.mjs';

const MODEL = { provider: 'fixture', id: 'm', api: 'openai-completions', maxTokens: 4000, contextWindow: 64000, baseUrl: 'https://fixture.invalid/v1' };

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-member-tools-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function chatResponse(message, finish = 'stop') {
  return { ok: true, status: 200, json: async () => ({ model: 'served', choices: [{ finish_reason: finish, message }], usage: { prompt_tokens: 10, completion_tokens: 10 } }) };
}

const call = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const toolRound = (calls) => ({ content: '', tool_calls: calls });

/** 假执行器：只回放 replies（字符串=最终正文 / 对象=工具轮），每条请求都记录，不发真实请求。 */
function setup(t, replies, { root = null } = {}) {
  const wsRoot = root || workspace(t);
  const requests = [];
  initSubagent({
    traceDir: path.join(wsRoot, 'traces'),
    getDefaultModel: () => MODEL,
    getFlashModel: () => MODEL,
    modelReader: () => ({ fixture: { models: [MODEL] } }),
    authReader: () => ({ fixture: { key: 'k' } }),
    researchRoots: () => [wsRoot],
    webSearch: async query => `搜索结果：${query}`,
    httpFetch: async (_url, opts) => {
      const body = JSON.parse(opts.body);
      requests.push(body);
      const index = requests.length - 1;
      let reply = typeof replies === 'function' ? replies(body, index) : (Array.isArray(replies) ? replies.shift() : replies);
      if (typeof reply === 'string') reply = { content: reply };
      return chatResponse(reply);
    },
  });
  return { root: wsRoot, requests };
}

function runTeam(options = {}) {
  return spawnSubagent({ task: '完成本阶段', profile: 'team', outputFormat: 'text', teamId: 'team-1', member: 'IDEA', ...options });
}

test('team profile 工具清单 = 只读检索 + team_board，写文件/命令/生图/派活一个都不给', async t => {
  const { root, requests } = setup(t, '结论正文');
  const r = await runTeam({ wsRoot: root, teamId: 'team-tools' });
  assert.equal(r.done, true, r.error);
  const names = requests[0].tools.map(tool => tool.function.name).sort();
  assert.deepEqual(names, ['grep', 'list', 'read', 'team_board', 'web_search'], '不多不少');
  assert.deepEqual([...TEAM_MEMBER_TOOLS].sort(), names);
  assert.deepEqual([...TEAM_MEMBER_READ_TOOLS].sort(), ['grep', 'list', 'read', 'web_search']);
  for (const denied of TEAM_MEMBER_DENIED_TOOLS) {
    assert.equal(names.includes(denied), false, `${denied} 绝不能出现在成员工具表里`);
  }

  // 成员版看板：动作枚举没有 create，团队编号由宿主固定（不能换板子看别人）
  const board = requests[0].tools.find(tool => tool.function.name === 'team_board').function;
  assert.deepEqual(board.parameters.properties.action.enum, [...TEAM_MEMBER_BOARD_ACTIONS]);
  assert.equal(board.parameters.properties.action.enum.includes('create'), false);
  assert.equal(board.parameters.properties.teamId, undefined);
  assert.equal(board.parameters.required.includes('action'), true);

  // 提示词里写死纪律（模型只看得到这段）
  const system = requests[0].messages[0].content;
  assert.match(system, /天团成员「IDEA」/);
  assert.match(system, /先调用 team_board/);
  assert.match(system, /expectedRevision/);
  assert.match(system, /complete/);
  assert.match(system, /release/);
  assert.match(system, /不能写文件、运行命令/);

  // 权限判定集中在一处，可单测
  assert.equal(judgeTeamMemberTool('read').ok, true);
  assert.equal(judgeTeamMemberTool('team_board').ok, true);
  assert.equal(judgeTeamMemberTool('write').ok, false);
  assert.match(judgeTeamMemberTool('bash').text, /没有「bash」/);
  assert.equal(judgeTeamBoardAction({ action: 'claim' }).ok, true);
  assert.equal(judgeTeamBoardAction({ action: 'create' }).ok, false);
  assert.match(judgeTeamBoardAction({ action: 'create' }).text, /不能 create/);
  assert.equal(resolveToolPolicy('team', { readTools: true, board: true }).kind, 'team');
  assert.deepEqual([...resolveToolPolicy('team', { readTools: false, board: true }).toolNames], ['team_board']);
  assert.equal(resolveToolPolicy('team', { readTools: true, board: false }).toolNames.includes('team_board'), false);
});

test('未授权工具调用被明确拒绝（不是静默丢弃），成员能拿到说明继续换路', async t => {
  const { root, requests } = setup(t, [
    toolRound([
      call('c1', 'write', { path: 'a.txt', content: 'x' }),
      call('c2', 'bash', { command: 'rm -rf /' }),
      call('c3', 'generate_image', { prompt: 'cat' }),
      call('c4', 'delegate_task', { task: '再派一个' }),
    ]),
    '最终正文',
  ]);
  const r = await runTeam({ wsRoot: root, teamId: 'team-deny' });
  assert.equal(r.done, true, r.error);
  assert.equal(requests.length, 2, '拒绝后模型还能拿到说明继续走');
  const toolMessages = requests[1].messages.filter(message => message.role === 'tool');
  assert.equal(toolMessages.length, 4);
  for (const message of toolMessages) assert.match(message.content, /⛔ 天团成员没有/);
  assert.match(toolMessages[0].content, /write/);
  assert.match(toolMessages[0].content, /不能写文件/);
  assert.match(toolMessages[1].content, /bash|运行命令/);
  assert.equal(fs.existsSync(path.join(root, 'a.txt')), false, '拒绝 = 没执行');
});

test('成员能 list/claim/complete 看板，不能 create；owner 与 teamId 由宿主固定', async t => {
  const root = workspace(t);
  const task = createTask('team-board-flow', { subject: 'IDEA：提出方向' }, { wsRoot: root }).task;
  const rounds = [
    toolRound([call('l1', 'team_board', { action: 'list', ready: true })]),
    toolRound([call('l2', 'team_board', { action: 'claim', taskId: task.id, owner: '小语', expectedRevision: 1 })]),
    toolRound([call('l3', 'team_board', { action: 'complete', taskId: task.id, expectedRevision: 2, result: '方向已交' })]),
    toolRound([call('l4', 'team_board', { action: 'create', subject: '成员自己造的活' })]),
    '最终正文',
  ];
  const snapshots = {};
  const { requests } = setup(t, (body, index) => {
    // index=2 是 complete 那一轮的请求，此时 claim 已执行、complete 还没执行。
    if (index === 2) snapshots.afterClaim = readBoard('team-board-flow', { wsRoot: root });
    return rounds[index];
  }, { root });
  const r = await spawnSubagent({ task: '本阶段', profile: 'team', outputFormat: 'text', teamId: 'team-board-flow', member: 'IDEA', wsRoot: root });
  assert.equal(r.done, true, r.error);
  assert.equal(requests.length, 5);

  const listed = requests[1].messages.find(message => message.tool_call_id === 'l1').content;
  assert.match(listed, /看板 team-board-flow/);
  assert.match(listed, new RegExp(task.id));

  const claimed = requests[2].messages.find(message => message.tool_call_id === 'l2').content;
  assert.match(claimed, /已认领/);
  assert.match(claimed, /owner=IDEA/, 'owner 必须是宿主给的成员名，不认模型传的“小语”');
  assert.equal(snapshots.afterClaim.tasks[0].status, 'in_progress');
  assert.equal(snapshots.afterClaim.tasks[0].owner, 'IDEA');

  const completed = requests[3].messages.find(message => message.tool_call_id === 'l3').content;
  assert.match(completed, /已完成/);
  const board = readBoard('team-board-flow', { wsRoot: root });
  assert.equal(board.tasks[0].status, 'completed');
  assert.equal(board.tasks[0].result, '方向已交');

  const deniedCreate = requests[4].messages.find(message => message.tool_call_id === 'l4').content;
  assert.match(deniedCreate, /不能 create/);
  assert.equal(listTasks('team-board-flow', {}, { wsRoot: root }).total, 1, '成员没有造出新任务');
  assert.equal(r.diagnostics.toolCalls, 3, '被拒的 create 不计入已执行调用');
});

test('工具轮上限 12：到顶强制收尾（最后一轮不给工具）', async t => {
  const { root, requests } = setup(t, (body, index) => (body.tools
    ? toolRound([call(`r${index}`, 'list', { path: '.' })])
    : '收尾正文'));
  const r = await spawnSubagent({ task: '无限查', profile: 'team', outputFormat: 'text', teamId: 'team-rounds', member: 'CHALLENGE', wsRoot: root });
  assert.equal(r.done, true, r.error);
  assert.equal(TEAM_MEMBER_MAX_STEPS, 12);
  assert.equal(requests.length, TEAM_MEMBER_MAX_STEPS + 1, '12 轮工具 + 1 次收尾');
  assert.ok(requests.slice(0, TEAM_MEMBER_MAX_STEPS).every(req => Array.isArray(req.tools) && req.tools.length));
  assert.equal(requests.at(-1).tools, undefined, '最后一步不挂工具');
  assert.match(requests.at(-1).messages.at(-1).content, /工具轮次已用完/);
  assert.equal(r.diagnostics.toolCalls, 12);
  assert.equal(r.diagnostics.toolRounds, 12);
});

test('总调用上限 40：单轮并行也不越过总额度，超出直接进收尾', async t => {
  const { root, requests } = setup(t, (body, index) => (body.tools
    ? toolRound([0, 1, 2, 3].map(n => call(`b${index}-${n}`, 'list', { path: '.' })))
    : '收尾正文'));
  const r = await spawnSubagent({ task: '并行猛查', profile: 'team', outputFormat: 'text', teamId: 'team-budget', member: 'EXEC', wsRoot: root });
  assert.equal(r.done, true, r.error);
  assert.equal(TEAM_MEMBER_MAX_TOOL_CALLS, 40);
  assert.equal(r.diagnostics.toolCalls, 40, '正好用满 40 次，不多执行');
  assert.equal(requests.length, 10 + 1, '10 轮 × 4 次后进入收尾');
  assert.equal(requests.at(-1).tools, undefined);
  assert.match(requests.at(-1).messages.at(-1).content, /工具调用总预算已用完/);
});

test('executeTeam 预建阶段任务，成员在工具循环里自己 claim → complete（不是主控代劳）', async t => {
  const root = workspace(t);
  const requests = [];
  initSubagent({
    traceDir: path.join(root, 'traces'),
    getDefaultModel: () => MODEL, getFlashModel: () => MODEL,
    modelReader: () => ({ fixture: { models: [MODEL] } }),
    authReader: () => ({ fixture: { key: 'k' } }),
    researchRoots: () => [root],
    httpFetch: async (_url, opts) => {
      const body = JSON.parse(opts.body);
      requests.push(body);
      const system = String(body.messages[0]?.content || '');
      const member = /天团成员「([^」]+)」/.exec(system)?.[1] || '';
      const toolMessages = body.messages.filter(message => message.role === 'tool');
      if (member === 'IDEA' && body.tools) {
        const listReply = toolMessages.find(message => /看板 /.test(message.content));
        if (!listReply) return chatResponse({ content: '', tool_calls: [call('i1', 'team_board', { action: 'list', ready: true })] }, 'tool_calls');
        const line = String(listReply.content).split('\n').find(row => row.includes('IDEA：'));
        const taskId = /(t-[a-z0-9-]+)/.exec(line || '')?.[1];
        const claimReply = toolMessages.find(message => /✅ 已认领/.test(message.content));
        if (taskId && !claimReply) return chatResponse({ content: '', tool_calls: [call('i2', 'team_board', { action: 'claim', taskId, expectedRevision: 1 })] }, 'tool_calls');
        const revision = Number(/rev=(\d+)/.exec(claimReply?.content || '')?.[1] || 2);
        const completeReply = toolMessages.find(message => /✅ 已完成/.test(message.content));
        if (taskId && !completeReply) return chatResponse({ content: '', tool_calls: [call('i3', 'team_board', { action: 'complete', taskId, expectedRevision: revision, result: 'IDEA 完成' })] }, 'tool_calls');
        return chatResponse({ content: '方案要点' });
      }
      return chatResponse({ content: member === 'REVIEW' ? '{"pass":true,"issues":[]}' : '阶段正文' });
    },
  });
  const result = await executeTeam({ task: '测试看板协作' }, { wsRoot: root, sessionId: 's', runId: 'team-flow' });
  assert.equal(result.isError, false, result.text);
  assert.equal(requests.length, 7, '四个阶段 + IDEA 的 3 次看板工具轮');  const board = readBoard('team-flow', { wsRoot: root });
  assert.equal(board.tasks.length, 4, '预建四个阶段任务');
  const idea = board.tasks.find(task => task.subject.startsWith('IDEA：'));
  assert.equal(idea.owner, 'IDEA');
  assert.equal(idea.status, 'completed');
  assert.equal(idea.result, 'IDEA 完成');
  // 主控没有替成员完成：其余阶段（fake 模型没调看板）仍是 pending。
  assert.equal(board.tasks.filter(task => task.status === 'pending').length, 3);
  // 成员身份确实来自 stage（label）；审计行也按成员分开。
  const rows = fs.readFileSync(path.join(root, '记忆', '运行时', '动作审计.jsonl'), 'utf8')
    .trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  assert.ok(rows.some(row => row.member === 'IDEA' && row.teamId === 'team-flow' && row.tool === 'team_board'));
});

test('成员每次工具调用写入 动作审计.jsonl，带 member / teamId / before-after', async t => {
  const { root, requests } = setup(t, [
    toolRound([call('a1', 'list', { path: '.' }), call('a2', 'team_board', { action: 'summary' })]),
    '最终正文',
  ]);
  const r = await spawnSubagent({ task: '本阶段', profile: 'team', outputFormat: 'text', teamId: 'audit-team', member: 'REVIEW', wsRoot: root });
  assert.equal(r.done, true, r.error);
  const auditFile = path.join(root, '记忆', '运行时', '动作审计.jsonl');
  assert.ok(fs.existsSync(auditFile), '成员工具调用必须落现有审计');
  const rows = fs.readFileSync(auditFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const mine = rows.filter(row => row.member === 'REVIEW' && row.teamId === 'audit-team');
  assert.equal(mine.length, 4, '2 次调用 × before/after');
  assert.ok(mine.some(row => row.phase === 'before' && row.tool === 'list'));
  assert.ok(mine.some(row => row.phase === 'after' && row.tool === 'team_board' && row.ok === true));
  assert.ok(mine.every(row => row.initiator === 'subagent'));
  assert.ok(mine.every(row => String(row.runId || '').startsWith('subagent-')));
  assert.ok(mine.every(row => row.argsHash && row.argsPreview !== undefined));
  assert.equal(requests.length, 2);
});
