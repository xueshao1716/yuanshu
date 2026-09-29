import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as emotion from '../../engine/emotion.mjs';
import * as gene from '../../engine/gene.mjs';
import { beginYuanshuEmotion, endYuanshuEmotion } from '../../engine/yuanshu-emotion.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-turn-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  emotion.init(root);
  const sessionId = `turn-${Math.random()}`;
  const file = path.join(root, '工程/经验库/genome.json');
  return { root, file, sessionId, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}
for (const [message, tag] of [
  ['这个故障还没有修好，任务没有完成', 'task_accomplish'],
  ['这真不靠谱', 'user_happy'], ['请把问题修好，然后完成交付', 'task_accomplish'],
  ['如果成功了再告诉我', 'task_accomplish'], ['文档写着“已经完成”，实际上没有', 'task_accomplish'],
]) test(`no positive evidence from negation/request/quote: ${message}`, t => {
  const { sessionId } = fixture(t);
  emotion.updateEmotion(sessionId, message, { turnId: 'one' });
  assert.ok(!emotion.getSnapshot(sessionId).tags.includes(tag));
});
test('feedback beyond first 200 characters remains observable', t => {
  const { sessionId } = fixture(t);
  emotion.updateEmotion(sessionId, '背景说明。'.repeat(60) + '太好了，已经修好了', { turnId: 'one' });
  assert.ok(emotion.getSnapshot(sessionId).tags.includes('task_accomplish'));
});
test('SDK then fallback counts one turn once, identical new turn counts again', t => {
  const { sessionId, read } = fixture(t);
  const message = '研究一下这个设计';
  emotion.updateEmotion(sessionId, message, { turnId: 'one' });
  const before = gene.getGenome().genes.curiosity.expression;
  beginYuanshuEmotion(sessionId, message, [], { turnId: 'one' });
  assert.equal(gene.getGenome().genes.curiosity.expression, before);
  assert.equal(read().observations.events.length, 1);
  beginYuanshuEmotion(sessionId, message, [], { turnId: 'two' });
  assert.ok(gene.getGenome().genes.curiosity.expression > before);
  assert.equal(read().observations.events.length, 2);
});
test('turn deduplication survives reinitialization and neutral first observation', t => {
  const { root, read } = fixture(t);
  gene.updateGenes([], { sessionId: 's', message: 'neutral', turnId: 'one' });
  gene.initGene(root);
  const before = gene.getGenome();
  gene.updateGenes(['task_deep'], { sessionId: 's', message: 'different', turnId: 'one' });
  assert.deepEqual(gene.getGenome(), before);
  assert.equal(read().observations.events.length, 0);
});
test('turn completion creates qualified proposals without changing baseline', t => {
  const { root, file, sessionId } = fixture(t);
  gene.updateGenes([], { now: Date.now() - 86400000, sessionId, message: 'seed' });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.genes.gentleness.expression = 0.99;
  fs.writeFileSync(file, JSON.stringify(saved));
  gene.initGene(root);
  const now = Date.now();
  for (const [i, offset] of [86400000, 43200000, 0].entries()) gene.updateGenes(['user_frustrated'], { now: now - offset, sessionId, message: '烦', turnId: `turn-${i}` });
  assert.equal(gene.getGenome().proposals.length, 0);
  endYuanshuEmotion(sessionId, '烦', '正在处理');
  const state = gene.getGenome();
  assert.equal(state.proposals.length, 1);
  assert.equal(state.proposals[0].status, 'pending');
  assert.equal(state.genes.gentleness.baseline, 0.8);
});
