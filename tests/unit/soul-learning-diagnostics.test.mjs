import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = file => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
test('learning renders normalized diagnostics instead of raw object children', () => {
  const text = source('frontend/src/soul/LiveSections.tsx');
  assert.ok(text.includes('diagnosticMessages(skills.data?.diagnostics)'), 'normalize structured diagnostics before rendering');
  assert.ok(!text.includes('>{d}</p>'), 'raw diagnostic objects cannot be React children');
});
test('diagnostics support legacy strings and typed messages without serializing private paths', async () => {
  const url = new URL('../../frontend/src/soul/diagnostics.mjs', import.meta.url);
  assert.ok(fs.existsSync(url), 'diagnostic normalization module exists');
  const { diagnosticMessages } = await import(url);
  assert.deepEqual(diagnosticMessages(['old', { type:'warning',message:'重复技能',path:'private',collision:{} }, null, 42, {message:{}}, '']), ['old','重复技能']);
  assert.deepEqual(diagnosticMessages({bad:true}), []);
});
test('composer separates send from utility controls and labels primary actions', () => {
  const jsx = source('frontend/src/components/SendBox.tsx');
  const css = source('frontend/src/components/composer-toolbar.css');
  assert.ok(jsx.includes('className="composer-submit"'), 'send has a distinct group');
  assert.ok(jsx.includes('aria-label="发送消息"'));
  assert.ok(jsx.includes('aria-label="停止生成"'));
  assert.ok(css.includes('.composer-submit {'));
});
