// 夜间复盘的 fix 行动：落 fix-attempt 轨迹 + 听探索策略重试 + 验证结论挂到轨迹上（2026-10-07）
// 以前 server.mjs 里那段循环不落轨迹，做梦的 fix-attempt 回放一条样本都没有。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeReflectionAction } from '../../engine/reflection-exec.mjs';
import { listTraces, loadTrace } from '../../engine/trace.mjs';
import { evidenceNodes } from '../../engine/trace-evidence.mjs';
import { replayExplore } from '../../engine/explore-policy.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'reflect-trace-'));
const reply = (status, files = []) => '```json\n' + JSON.stringify({ status, evidence: `npm test → ${status}`, files }) + '\n```';
const verdict = v => '```json\n' + JSON.stringify({ verdict: v, evidence: 'cat 核对过' }) + '\n```';
const action = { text: '把 README 里的端口号改成 8787 并核对', kind: 'fix' };
const only = ws => { const t = listTraces(ws, { kind: 'fix-attempt', limit: 10 }); assert.equal(t.length, 1); return loadTrace(ws, t[0].id); };

test('done + 验证 PASS：落一条已关闭的 fix-attempt 轨迹，回放判成功', async () => {
  const ws = tmp();
  const out = await executeReflectionAction(action, { wsRoot: ws, runTurn: async () => reply('done'), verifyTurn: async () => verdict('PASS') });
  assert.equal(out.aborted, false);
  assert.equal(out.result.status, 'done');
  assert.equal(out.verification.verdict, 'PASS');
  const tr = only(ws);
  assert.equal(tr.closed.result, 'done');
  assert.equal(tr.goal, action.text);
  const nodes = evidenceNodes(tr);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].verification, 'PASS');
  assert.equal(replayExplore(tr, { retryOnFailure: 0 }).score, 1);
});

test('验证 FAIL：降级为 failed，轨迹上挂 FAIL，回放不算成功', async () => {
  const ws = tmp();
  const out = await executeReflectionAction(action, { wsRoot: ws, runTurn: async () => reply('done'), verifyTurn: async () => verdict('FAIL') });
  assert.equal(out.result.status, 'failed');
  assert.match(out.result.evidence, /独立验证未通过（FAIL）/);
  assert.equal(evidenceNodes(only(ws))[0].verification, 'FAIL');
  assert.equal(replayExplore(only(ws), { retryOnFailure: 3 }).score, 0);
});

test('failed 按现役探索策略重试（默认 1 次），每次尝试一个节点；blocked 不重试', async () => {
  const ws = tmp();
  let n = 0;
  const out = await executeReflectionAction(action, { wsRoot: ws, runTurn: async () => (++n === 1 ? reply('failed') : reply('done')), verifyTurn: async () => verdict('PASS') });
  assert.equal(n, 2);
  assert.equal(out.result.status, 'done');
  const nodes = evidenceNodes(only(ws));
  assert.deepEqual(nodes.map(x => x.action), ['执行轮', '执行轮·重试1']);
  // 这正是做梦要比的：不重试的策略在这条上失败，重试 1 次的成功
  assert.equal(replayExplore(only(ws), { retryOnFailure: 0 }).score, 0);
  assert.equal(replayExplore(only(ws), { retryOnFailure: 1 }).score, 1);

  const ws2 = tmp();
  let m = 0;
  const b = await executeReflectionAction(action, { wsRoot: ws2, runTurn: async () => { m++; return reply('blocked'); }, verifyTurn: async () => verdict('PASS') });
  assert.equal(m, 1, 'blocked 是缺东西/要人，重试也一样');
  assert.equal(b.result.status, 'blocked');
  assert.equal(b.verification, null, '没 done 就不派验证轮');
});

test('中途被中止：返回 aborted，不给结果（调用方不落账）', async () => {
  const ws = tmp();
  let stop = false;
  const out = await executeReflectionAction(action, { wsRoot: ws, isAborted: () => stop, runTurn: async () => { stop = true; return null; }, verifyTurn: async () => verdict('PASS') });
  assert.equal(out.aborted, true);
  assert.equal(out.result, null);
});

test('server 夜间执行段走共享函数，不再自己拼执行轮/验证轮', () => {
  const src = fs.readFileSync('server.mjs', 'utf8');
  assert.match(src, /executeReflectionAction\(action, \{ wsRoot: CONFIG\.cwd/);
  assert.doesNotMatch(src, /verifyArtifacts\(/);
});
