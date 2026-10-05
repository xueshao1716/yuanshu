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
test('skill loader diagnostics are translated into plain Chinese without leaking paths', async () => {
  const { diagnosticMessages } = await import(new URL('../../frontend/src/soul/diagnostics.mjs', import.meta.url));
  const out = diagnosticMessages([
    { type:'warning', message:'name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)', path:'C:\\Users\\x\\.agents\\skills\\PDF Processing Pro\\SKILL.md' },
    { type:'collision', message:'name "impeccable" collision', path:'C:\\Users\\x\\.agents\\skills\\impeccable\\SKILL.md', collision:{ name:'impeccable' } },
  ]);
  assert.equal(out.length, 2);
  assert.match(out[0], /PDF Processing Pro/); assert.match(out[0], /命名规范/);
  assert.match(out[1], /impeccable/); assert.match(out[1], /两份/);
  for (const line of out) { assert.ok(!/[A-Za-z]:\\/.test(line), 'no private path'); assert.ok(!/collision|invalid characters/.test(line), 'no raw English'); }
});
test('composer separates send from utility controls and labels primary actions', () => {
  const jsx = source('frontend/src/components/SendBox.tsx');
  const css = source('frontend/src/components/composer-toolbar.css');
  assert.ok(jsx.includes('className="composer-submit"'), 'send has a distinct group');
  assert.ok(jsx.includes('aria-label="发送消息"'));
  assert.ok(jsx.includes('aria-label="停止生成"'));
  assert.ok(css.includes('.composer-submit {'));
});
