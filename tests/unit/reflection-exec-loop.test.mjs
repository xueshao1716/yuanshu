// 端到端（离线）：复盘产出的清单，kind=fix 的真的被派了执行轮并带证据结清。
// 用假的 unifiedChat（就说"干完了 + 证据"），验证 server 里那一段接线的语义：
//   清单 → 派发 → 执行 → 回账（done+证据 → kept；blocked → 留 pending 且记下尝试）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planReflectionExecution, buildActionExecutionPrompt, parseActionResult, recordActionAttempt, summarizeExecution } from '../../engine/reflection-exec.mjs';
import { recordReflectionActions } from '../../engine/time-task-run.mjs';
import { loadPromises } from '../../engine/promises.mjs';

test('闭环：复盘清单里的 fix 被真的做掉并留下证据，红线那条不动', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-reflect-e2e-'));
  const reflection = [
    '## 复盘',
    '昨天有三处没做完。',
    '```json',
    JSON.stringify({
      actions: [
        { text: '给 abort 用例改成 ping 回环地址', kind: 'fix' },
        { text: '轮换 API key 并写进配置', kind: 'fix' },   // 红线 → 转人工
        { text: '跟踪社区包的版本变化', kind: 'track' },
      ],
    }),
    '```',
  ].join('\n');
  const rec = recordReflectionActions(root, reflection, { taskId: 'T1' });
  assert.equal(rec.parsed, 3);
  assert.equal(loadPromises(root).length, 3);

  const { executable, deferred } = planReflectionExecution(rec.actions);
  assert.equal(executable.length, 1, '只有那一条干净的 fix 进自动执行');
  assert.equal(executable[0].text, '给 abort 用例改成 ping 回环地址');
  assert.equal(deferred.length, 2);
  assert.ok(deferred.some((a) => a.kind === 'ask' && /红线/.test(a.reason)));
  assert.ok(deferred.some((a) => a.kind === 'track'));

  // 假执行轮：拿提示词、回一个带证据的结果
  const prompt = buildActionExecutionPrompt(executable[0], { ymd: '2026-09-17' });
  assert.match(prompt, /给 abort 用例改成 ping 回环地址/);
  const reply = '改好了。\n```json\n{"status":"done","evidence":"node --test tests/unit/yuanshu-stability.test.mjs → pass 8/8","files":["tests/unit/yuanshu-stability.test.mjs"],"summary":"换成回环地址"}\n```';
  const result = parseActionResult(reply);
  const back = recordActionAttempt(root, executable[0], result);
  assert.equal(back.closed, true);

  const kept = loadPromises(root).find((p) => p.text === '给 abort 用例改成 ping 回环地址');
  assert.equal(kept.status, 'kept');
  assert.match(kept.evidence, /pass 8\/8/);
  // 另外两条仍挂着等人/等跟踪（没被这次执行碰到）
  assert.equal(loadPromises(root).filter((p) => p.status === 'pending').length, 2);

  // 一轮总结是人话
  assert.equal(summarizeExecution([{ status: 'done' }]), '本自动执行 1 条：完成 1');
});
