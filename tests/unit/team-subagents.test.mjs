import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initSubagent, getSubagentHistory, spawnSubagent } from '../../engine/subagent.mjs';

async function setup(t, replies) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-team-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const requests = [];
  initSubagent({ traceDir: path.join(root, 'traces'), getDefaultModel: () => ({ provider: 'fake', id: 'test' }), getFlashModel: () => null,
    modelReader: () => ({ fake: { models: [{ id: 'test', baseUrl: 'https://fake.invalid', reasoning: true }] } }),
    resolveAuth: () => ({ baseUrl: 'https://fake.invalid' }),
    authReader: () => ({ fake: { type: 'api_key', key: 'test' } }),
    httpFetch: async (_url, opts) => { const body = JSON.parse(opts.body); requests.push(body); const reply = replies.shift(); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: body.messages[0].content.includes('输出必须严格为 JSON') ? JSON.stringify({ result: reply, evidence: [], confidence: .8 }) : reply } }] }) }; },
  });
  return { root, requests };
}
test('team uses persisted children, passes prior work and writes only final reviewed delivery', async t => {
  const { root, requests } = await setup(t, ['方案末尾事实XYZ', '保留XYZ并纠正预算', '# 可拍脚本\n' + '具体镜头及口播。'.repeat(80), '{"pass":true,"issues":[]}']);
  const mod = await import('../../engine/team-subagents.mjs').catch(() => ({}));
  assert.equal(typeof mod.executeTeam, 'function', 'missing real team orchestrator');
  const events = [];
  const result = await mod.executeTeam({ task: '做探店账号前三期脚本' }, { wsRoot: root, sessionId: 's', runId: 'parent', onEvent: (type, data) => events.push({ type, data }) });
  assert.equal(result.isError, false);
  assert.equal(requests.length, 4);
  assert.ok(requests.slice(0, 2).every(r => r.reasoning_effort === 'low'));
  assert.equal(requests[2].reasoning_effort, 'medium', 'drafting balances reasoning and stage latency');
  assert.equal(requests[2].max_tokens, 12000, 'reasoning and complete delivery share a bounded output budget');
  assert.equal(requests[3].reasoning_effort, 'medium', 'bounded independent review');
  assert.doesNotMatch(JSON.stringify(requests[3].messages), /方案末尾事实XYZ|保留XYZ并纠正预算/, 'review judges the delivery without earlier agents steering its verdict');
  assert.match(JSON.stringify(requests[3].messages), /具体镜头及口播/);
  assert.match(JSON.stringify(requests[1].messages), /方案末尾事实XYZ/);
  assert.match(JSON.stringify(requests[2].messages), /纠正预算/);
  assert.match(requests[0].messages.at(-1).content, /600 字/);
  assert.match(requests[1].messages.at(-1).content, /700 字/);
  assert.match(await fs.readFile(path.join(root, result.artifact), 'utf8'), /具体镜头及口播/);
  const rows = await getSubagentHistory({ runId: 'parent' });
  assert.equal(rows.length, 4);
  assert.ok(rows.every(r => r.parentRunId === 'parent' && r.sessionId === 's' && r.status === 'completed'));
  assert.equal(events.filter(e => e.type === 'artifact_created').length, 1);
  assert.equal(result.delivery?.status, 'awaiting_acceptance', 'a real review proposal must exist');
  const proposal = JSON.parse(await fs.readFile(path.join(root, `工程/待审/${result.delivery.proposalId}.json`), 'utf8'));
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.content, await fs.readFile(path.join(root, result.artifact), 'utf8'));
  assert.equal(events.find(e => e.type === 'artifact_created').data.artifactDigest, result.delivery.artifactDigest);
  assert.equal(result.delivery.evidence.scope, 'text_pipeline_only');
  assert.equal(result.delivery.evidence.children.length, 4);
});

test('objective speech overrun cannot be approved by a model and repair replaces the draft', async t => {
  const bad = '0—3秒，画面：菜单；口播：“今天我们到这家店先来看看这个招牌套餐到底多少钱”。';
  const good = '0—3秒，画面：菜单；口播：“五十元，先看价。”';
  const fixedReview = JSON.stringify({ pass: true, issues: [], revisionChecks: [
    { id: 'R1', status: 'resolved', quote: '五十元，先看价。', reason: '已缩短口播，三秒容得下' },
  ] });
  const { root, requests } = await setup(t, ['方案', '质疑', bad, '{"pass":true,"issues":[]}', good, fixedReview]);
  const { executeTeam } = await import('../../engine/team-subagents.mjs');
  const result = await executeTeam({ task: '写三秒口播' }, { wsRoot: root, sessionId: 's', runId: 'timing' });
  assert.equal(result.isError, false);
  assert.equal(requests.length, 6);
  assert.match(JSON.stringify(requests[4].messages), /口播.*超/);
  assert.equal((await fs.readFile(path.join(root, result.artifact), 'utf8')).trim(), good);
  assert.doesNotMatch(JSON.stringify(requests[5].messages), /这个招牌套餐/);
  assert.equal(result.delivery.evidence.modelReview.revisionChecks[0].quote, '五十元，先看价。');
  assert.match(result.delivery.evidence.modelReview.revisionChecks[0].issue, /口播.*超/);
});

test('unfixed objective violations are not published even after two model approvals', async t => {
  const bad = '0—1秒；口播：“这一句实在太长不可能说得完”。';
  const review = JSON.stringify({ pass: true, issues: [], revisionChecks: [
    { id: 'R1', status: 'resolved', quote: '这一句实在太长不可能说得完', reason: '模型错误地声称口播已修正' },
  ] });
  const { root } = await setup(t, ['方案', '质疑', bad, '{"pass":true,"issues":[]}', bad, review]);
  const { executeTeam } = await import('../../engine/team-subagents.mjs');
  const result = await executeTeam({ task: '写一秒口播' }, { wsRoot: root, sessionId: 's', runId: 'bad-timing' });
  assert.equal(result.isError, true);
  assert.equal(result.artifact, undefined);
  assert.match(result.text, /口播/);
});
test('failed child prevents publication, and unbound calls cannot invent parent identity', async t => {
  const { root, requests } = await setup(t, ['方案', '质疑', '正文', '{"pass":false,"issues":["缺少脚本"]}', '修订', '{"pass":false,"issues":["仍缺正文"]}']);
  const mod = await import('../../engine/team-subagents.mjs').catch(() => ({}));
  assert.equal(typeof mod.executeTeam, 'function');
  const denied = await mod.executeTeam({ task: 'test', runId: 'forged' }, { wsRoot: root });
  assert.equal(denied.isError, true); assert.equal(requests.length, 0);
  const r = await mod.executeTeam({ task: 'test' }, { wsRoot: root, runId: 'parent', sessionId: 's' });
  assert.equal(r.isError, true); assert.equal(r.artifact, undefined);
  assert.equal(requests.length, 6);
  assert.equal(requests[4].reasoning_effort, 'medium', 'repair must reconsider the whole delivery');
});
test('parent cancellation closes the active child and prevents following stages', async t => {
  const { root, requests } = await setup(t, ['方案']);
  const { executeTeam } = await import('../../engine/team-subagents.mjs');
  const ac = new AbortController();
  const r = await executeTeam({ task: 'test' }, { wsRoot: root, runId: 'cancel-parent', sessionId: 's', signal: ac.signal,
    onEvent: type => { if (type === 'subagent_finished') ac.abort(); } });
  assert.equal(r.cancelled, true); assert.equal(requests.length, 1); assert.equal(r.artifact, undefined);
});
test('team text profile preserves structured video output and long task tail', async t => {
  const { requests } = await setup(t, ['unused']);
  const long = '上下文'.repeat(1500) + '必须保留尾部约束';
  const r = await spawnSubagent({ task: long, profile: 'team', outputFormat: 'text' });
  assert.equal(r.done, true);
  assert.match(JSON.stringify(requests[0].messages), /必须保留尾部约束/);
  assert.equal(r.result, 'unused');
});

test('team prose is not forced into a JSON string while review remains fail closed', async t => {
  const prose = '# 脚本\n0—3秒；口播：“先看价格。”\n路径仅为待办：C:\\素材';
  const { root, requests } = await setup(t, ['方向\n第二行', '核价后购买', prose, '看起来没问题']);
  const { executeTeam } = await import('../../engine/team-subagents.mjs');
  const result = await executeTeam({ task: '多行脚本' }, { wsRoot: root, sessionId: 's', runId: 'prose-review' });
  assert.equal(requests.length, 4);
  assert.ok(requests.every(r => !r.messages[0].content.includes('输出必须严格为 JSON')),
    'prose stages must not require models to escape multiline drafts as JSON strings');
  assert.match(JSON.stringify(requests[3].messages), /先看价格/);
  assert.equal(result.isError, true);
  assert.match(result.text, /复核结果格式无效/);
  assert.equal(result.artifact, undefined);
});

test('ordinary children retain default reasoning and truncated team output is never accepted', async t => {
  const { root, requests } = await setup(t, ['normal']);
  await spawnSubagent({ task: 'normal' });
  assert.equal(requests[0].reasoning_effort, 'high');
  initSubagent({ traceDir: path.join(root, 'length-traces'), getDefaultModel: () => ({ provider: 'fake', id: 'test', baseUrl: 'https://fake.invalid' }),
    authReader: () => ({ fake: { key: 'test' } }), modelReader: () => ({}),
    httpFetch: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '{"result":"表面完整却被截断","evidence":[]}' } }] }) }) });
  const r = await spawnSubagent({ task: 'final', profile: 'team' });
  assert.equal(r.done, false);
  assert.match(r.error, /输出预算/);
});
test('completed team recovery reuses result and uncertain stage never buys another call', async t => {
  const { root, requests } = await setup(t, ['方案', '质疑', '正文', '{"pass":true,"issues":[]}']);
  const { executeTeam } = await import('../../engine/team-subagents.mjs');
  let state = {};
  const ctx = { wsRoot: root, runId: 'resume-parent', sessionId: 's', saveTeamState: s => { state = s; } };
  const first = await executeTeam({ task: 'test' }, ctx);
  assert.equal(first.isError, false);
  const again = await executeTeam({ task: 'test' }, { ...ctx, teamState: state });
  assert.equal(again.artifact, first.artifact); assert.equal(requests.length, 4);
  const cancelled = await executeTeam({ task: 'test' }, { ...ctx, teamState: state, signal: AbortSignal.abort() });
  assert.equal(cancelled.cancelled, true);
  await fs.writeFile(path.join(root, first.artifact), '人工改稿');
  const changed = await executeTeam({ task: 'test' }, { ...ctx, teamState: state });
  assert.equal(changed.isError, true); assert.match(changed.text, /交付文件/);
  assert.equal(await fs.readFile(path.join(root, first.artifact), 'utf8'), '人工改稿');
  const uncertain = await executeTeam({ task: 'test' }, { ...ctx, teamState: { task: 'test', inFlight: 'EXEC', stages: [] } });
  assert.equal(uncertain.isError, true); assert.match(uncertain.text, /不确定/); assert.equal(requests.length, 4);
});

test('revision does not republish on a bare approval that forgot earlier review issues', async t => {
  const { root, requests } = await setup(t, ['旧方案标记', '早期质疑标记', '旧稿标记',
    '{"pass":false,"issues":["预算分支与三份台词矛盾"]}', '按实际购买数量拍摄', '{"pass":true,"issues":[]}']);
  const { executeTeam } = await import('../../engine/team-subagents.mjs');
  const result = await executeTeam({ task: '预算脚本' }, { wsRoot: root, runId: 'closure', sessionId: 's' });
  assert.equal(result.isError, true);
  assert.equal(result.artifact, undefined);
  assert.equal(requests.length, 6, 'no extra paid revision loops');
  assert.match(JSON.stringify(requests[5].messages), /预算分支与三份台词矛盾/);
  assert.doesNotMatch(JSON.stringify(requests[5].messages), /旧稿标记|旧方案标记|早期质疑标记/);
  assert.doesNotMatch(JSON.stringify(requests[4].messages), /旧方案标记|早期质疑标记/);
});
