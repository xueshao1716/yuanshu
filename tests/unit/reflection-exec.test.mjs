// 复盘 → 执行（engine/reflection-exec.mjs，2026-09-17）。
//
// 用户的观察："任务中的自我反思，是抓了一堆问题，但是没有主动执行能力了"。
// 结构性原因：复盘那轮只有只读工具，它的产出只能是清单；清单进承诺账后又要等人结清。
// 这组测试锁住补上的那一米，以及它的边界：
//   ① 只有 kind=fix 且不碰红线的才自动执行，其余留给跟踪/人工（理由要可见）
//   ② 每轮有上限（不是把复盘变成大工程）
//   ③ 执行轮提示词要求证据，结果契约只有 done/blocked/failed
//   ④ 只有"done + 证据"才结清；blocked/failed 留在账上并记下这次尝试
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_AUTO_FIX, normalizeActionKind, classifyAction, planReflectionExecution,
  buildActionExecutionPrompt, parseActionResult, isCloseable, recordActionAttempt, summarizeExecution,
} from '../../engine/reflection-exec.mjs';
import { loadPromises } from '../../engine/promises.mjs';
import { recordReflectionActions } from '../../engine/time-task-run.mjs';

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-reflect-exec-'));

test('kind 只认三档，没写按 track（保守：不猜它想立刻动手）', () => {
  assert.equal(normalizeActionKind('fix'), 'fix');
  assert.equal(normalizeActionKind('ASK'), 'ask');
  assert.equal(normalizeActionKind(''), 'track');
  assert.equal(normalizeActionKind('随便写点什么'), 'track');
});

test('分类：只有 fix 且不碰红线才自动执行，理由要说得出来', () => {
  assert.equal(classifyAction({ text: '给 reflection-exec 补一条回归测试', kind: 'fix' }).executable, true);
  assert.equal(classifyAction({ text: '跟踪社区包的版本变化', kind: 'track' }).executable, false);
  assert.equal(classifyAction({ text: '要不要改产品默认行为', kind: 'ask' }).executable, false);
  assert.equal(classifyAction({ text: '改一下', kind: 'fix' }).executable, false, '太短不足以执行');
  // 红线：一律转人工，连试都不试
  for (const text of ['轮换 API key 并写进配置', '把服务重新部署上线', 'git push 到远端', '删除旧会话数据', '给上游充值']) {
    const c = classifyAction({ text, kind: 'fix' });
    assert.equal(c.executable, false, `${text} 不该自动执行`);
    assert.equal(c.kind, 'ask');
    assert.match(c.reason, /红线/);
  }
});

test('派发：每轮最多 N 条，其余留给跟踪/人工且带理由', () => {
  const actions = Array.from({ length: MAX_AUTO_FIX + 2 }, (_, i) => ({ text: `补第 ${i} 条回归测试`, kind: 'fix' }));
  const { executable, deferred } = planReflectionExecution(actions);
  assert.equal(executable.length, MAX_AUTO_FIX);
  assert.equal(deferred.length, 2);
  assert.match(deferred[0].reason, /上限/);
  // 显式上限也要能被收紧
  assert.equal(planReflectionExecution(actions, { max: 1 }).executable.length, 1);
});

test('执行轮提示词：一次一条、必须给证据、不许碰红线动作', () => {
  const p = buildActionExecutionPrompt({ text: '给 abort 用例改成 ping 回环地址' }, { ymd: '2026-09-17' });
  assert.match(p, /给 abort 用例改成 ping 回环地址/);
  assert.match(p, /只做这一条/);
  assert.match(p, /证据 = 命令 \+ 输出摘要/);
  assert.match(p, /不许碰：密钥/);
  assert.match(p, /"status":"done\|blocked\|failed"/);
});

test('结果契约：取最后一个 JSON 块；status 不认识就不算结果（不猜成功）', () => {
  const ok = parseActionResult('干完了\n```json\n{"status":"done","evidence":"npm test → 1416 pass","files":["tests/unit/x.test.mjs"],"summary":"补了测试"}\n```');
  assert.equal(ok.status, 'done');
  assert.deepEqual(ok.files, ['tests/unit/x.test.mjs']);
  assert.equal(isCloseable(ok), true);
  // 先给示例块再给正式块：取最后一个
  const two = parseActionResult('```json\n{"status":"failed"}\n```\n其实：\n```json\n{"status":"blocked","evidence":"缺上游 key"}\n```');
  assert.equal(two.status, 'blocked');
  // 没有 JSON / status 不认识 / 说完成了但没证据
  assert.equal(parseActionResult('我做了但忘了写 JSON'), null);
  assert.equal(parseActionResult('```json\n{"status":"ok"}\n```'), null);
  assert.equal(isCloseable({ status: 'done', evidence: '' }), false, '说完成但不给证据 → 不算');
  assert.equal(isCloseable({ status: 'blocked', evidence: '缺 X' }), false);
});

test('结果回账：done+证据才结清；blocked/failed 留 pending 并记下这次尝试', () => {
  const root = tmpRoot();
  const text = '给 reflection-exec 补一条回归测试';
  recordReflectionActions(root, `\`\`\`json\n{"actions":[{"text":"${text}","kind":"fix"}]}\n\`\`\``, { now: new Date('2026-09-17T08:00:00Z') });
  assert.equal(loadPromises(root).length, 1);

  // 第一次：受阻 → 不结清，但留下尝试与原因
  const first = recordActionAttempt(root, { text }, { status: 'blocked', evidence: '缺上游 key', files: [], summary: '' }, { now: new Date('2026-09-17T09:00:00Z') });
  assert.equal(first.ok, true);
  assert.equal(first.closed, false);
  let p = loadPromises(root)[0];
  assert.equal(p.status, 'pending');
  assert.equal(p.attempts.length, 1);
  assert.equal(p.attempts[0].status, 'blocked');

  // 第二次：做完了且给得出证据 → 结清，证据留在账上，attempts 不丢
  const second = recordActionAttempt(root, { text }, { status: 'done', evidence: 'npm test → 1416 pass', files: ['tests/unit/reflection-exec.test.mjs'], summary: '补了测试' }, { now: new Date('2026-09-17T10:00:00Z') });
  assert.equal(second.closed, true);
  p = loadPromises(root)[0];
  assert.equal(p.status, 'kept');
  assert.match(p.evidence, /1416 pass/);
  assert.equal(p.attempts.length, 2, '两次尝试都要留着（不是只记最后一次）');
  assert.ok(p.closedAt);

  // 账上没有这条 → 不新建（账本只该记承诺）
  assert.equal(recordActionAttempt(root, { text: '一条不存在的行动' }, { status: 'done', evidence: 'x' }).ok, false);
});

test('一轮结束要有一句人话总结', () => {
  assert.equal(summarizeExecution([]), '');
  assert.match(summarizeExecution([{ status: 'done' }, { status: 'blocked' }, { status: 'failed' }]), /完成 1，受阻 1，失败 1/);
});
