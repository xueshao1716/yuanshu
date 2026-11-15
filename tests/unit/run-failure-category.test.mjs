import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure } from '../../engine/run-observability.mjs';

// 2026-11-15：交付门禁拒绝此前被 /确认/ 误判成 approval（复核文案里常有"主代理确认"），
// 看上去像"等人审批"，实际是内容没过门禁。现在 delivery 单独归类，且排在 approval 之前。

test('正文复核未通过归类为 delivery，而不是 approval', () => {
  assert.equal(classifyFailure('正文复核未通过：核心成果缺失，用流程说明替代答案'), 'delivery');
});

test('复核文案里含"确认"也仍是 delivery（不被 /确认/ 抢走）', () => {
  assert.equal(classifyFailure('主代理确认后复核未通过：字数核算不一致'), 'delivery');
});

test('交付门禁/未通过复核等措辞都归 delivery', () => {
  for (const text of ['交付门禁未过', '未通过复核', 'delivery gate rejected', 'review failed on counts']) {
    assert.equal(classifyFailure(text), 'delivery', text);
  }
});

test('真正的审批类仍是 approval', () => {
  for (const text of ['需要用户确认后继续', '权限不足，等待审批', 'sandbox denied']) {
    assert.equal(classifyFailure(text), 'approval', text);
  }
});

test('超时与供应商错误不受影响', () => {
  assert.equal(classifyFailure('执行超过 120 秒，已超时'), 'timeout');
  assert.equal(classifyFailure('401 鉴权失败，api key 无效'), 'provider');
});

test('stopped / interrupted 优先于文本分类', () => {
  assert.equal(classifyFailure('正文复核未通过', 'stopped'), 'stopped');
  assert.equal(classifyFailure('正文复核未通过', 'interrupted'), 'interrupted');
});
