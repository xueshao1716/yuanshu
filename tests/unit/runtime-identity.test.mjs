import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runtimeIdentity } from '../../engine/runtime-identity.mjs';
import { assembleYuanshuSystem } from '../../engine/yuanshu-seams.mjs';

test('execution identity distinguishes product, engine and text model', () => {
  const text = runtimeIdentity({ engine: 'yuanshu', model: { provider: 'test', id: 'model' } });
  assert.match(text, /执行引擎：元枢自制循环/);
  assert.match(text, /文本模型：test\/model/);
  assert.match(runtimeIdentity({ engine: 'pi' }), /执行引擎：pi SDK 兼容适配器/);
  assert.match(runtimeIdentity({ engine: 'dsh' }), /执行引擎：dsh/);
  assert.equal(runtimeIdentity({ engine: 'unknown' }), '');
});

test('runtime facts are present even with an existing persona and runtime directive', () => {
  const sections = assembleYuanshuSystem({ persona: '原有人格', runtime: '任务策略' }, null,
    { engine: 'yuanshu', model: { provider: 'test', id: 'model' } });
  assert.equal(sections.persona, '原有人格');
  assert.match(sections.runtime, /任务策略/);
  assert.match(sections.runtime, /执行引擎：元枢自制循环/);
  assert.match(sections.runtime, /文本模型：test\/model/);
});

test('chat adapters supply execution facts and the real persona workspace', () => {
  const unified = readFileSync(new URL('../../engine/unified-chat.mjs', import.meta.url), 'utf8');
  const sdk = readFileSync(new URL('../../engine/context-loader.mjs', import.meta.url), 'utf8');
  const call = unified.split('\n').find(line => line.includes('gateway?.registry, {'));
  assert.ok(call?.includes("engine: 'yuanshu'"));
  assert.ok(call?.includes('wsRoot: _cwd'));
  assert.ok(sdk.includes("runtimeIdentity({ engine: 'pi' })"));
});
