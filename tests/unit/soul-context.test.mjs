import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCorrections, parseRelation, renderSoulContext, soulContextPrompt } from '../../engine/soul-context.mjs';
import { knowledgeRunOutput } from '../../engine/knowledge-run-source.mjs';

const FIXES = `# 纠正记忆

- **"双推" = git push 到两个远端**。不要猜。
### 2026-08-19 22:17
- 触发: 记得现在做文件不要再写大文件
- 纠正: 不要再写大文件

### 2026-09-22 20:21
- 触发: 不要再调用任何工具。只用上文告诉我项目名
- 纠正: 不要再调用任何工具

## 2026-09-19 人格方向搞反了
- **规矩（此后不再犯）**：
  1. 任何系统的 \`SOUL.md\` **只读**；要改先给 diff。
- 2026-09-12 [纠正记忆·情绪残留 0.36] 怎么一直失败
`;

test('soul context keeps durable corrections, newest first, and drops one-turn orders', () => {
  const fixes = parseCorrections(FIXES);
  assert.equal(fixes[0], '任何系统的 SOUL.md 只读；要改先给 diff。');
  assert.ok(fixes.includes('不要再写大文件'), 'trigger said 记得 → durable');
  assert.ok(!fixes.some((f) => f.includes('不要再调用任何工具')), 'single-turn order must not be injected every turn');
  assert.ok(!fixes.some((f) => /规矩|情绪残留/.test(f)), 'headings and emotion residue are not rules');
  assert.ok(fixes.some((f) => f.startsWith('"双推"')));
});

test('soul context renders both corrections and relationship notes, and is empty when nothing is known', () => {
  assert.equal(renderSoulContext({}), '');
  assert.deepEqual(parseRelation('# 关系\n\n> 说明\n- 喜欢简洁\n- 晚上工作\n'), ['晚上工作', '喜欢简洁']);
  const text = renderSoulContext({ fixes: ['不要再写大文件'], relation: ['喜欢简洁'] });
  assert.match(text, /灵魂快照/);
  assert.match(text, /- 不要再写大文件/);
  assert.match(text, /- 喜欢简洁/);
});

test('soul context reads the workspace memory files and refreshes when they change', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-ctx-'));
  fs.mkdirSync(path.join(ws, '记忆'));
  const file = path.join(ws, '记忆', '纠正记忆.md');
  fs.writeFileSync(file, '### 1\n- 触发: 以后都这样\n- 纠正: 先探活再推送\n');
  assert.match(soulContextPrompt(ws), /先探活再推送/);
  fs.writeFileSync(file, '### 1\n- 触发: 以后都这样\n- 纠正: 发版要升号\n');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  assert.match(soulContextPrompt(ws), /发版要升号/);
  assert.equal(soulContextPrompt(path.join(ws, 'missing')), '');
});

test('long runs with large think streams still yield their answer text as a knowledge source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kn-run-'));
  fs.mkdirSync(path.join(root, 'events'));
  const run = { id: 'big-run', sessionId: 's1' };
  const rows = [];
  for (let i = 1; i <= 12000; i++) rows.push(JSON.stringify({ runId: run.id, sessionId: 's1', seq: i, type: 'think', data: { text: 'x'.repeat(400) } }));
  rows.push(JSON.stringify({ runId: run.id, sessionId: 's1', seq: 12001, type: 'delta', data: { text: '最终答复' } }));
  fs.writeFileSync(path.join(root, 'events', `${run.id}.jsonl`), rows.join('\n') + '\n');
  assert.ok(fs.statSync(path.join(root, 'events', `${run.id}.jsonl`)).size > 4 * 1024 * 1024);
  assert.equal(knowledgeRunOutput(root, run, { required: true }), '最终答复');
  // 非必需探测读不了就当没有，不拖累整份来源
  fs.writeFileSync(path.join(root, 'events', 'bad.jsonl'), '{not json\n');
  assert.equal(knowledgeRunOutput(root, { id: 'bad', sessionId: 's1' }), '');
  assert.throws(() => knowledgeRunOutput(root, { id: 'bad', sessionId: 's1' }, { required: true }), { code: 'source_missing' });
});
