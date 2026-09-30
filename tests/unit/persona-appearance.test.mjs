import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_DEFINITION, renderPersonaSection } from '../../engine/persona-def.mjs';
import { createPersonaGovernance } from '../../engine/persona-governance.mjs';
import { personaPatch } from '../../frontend/src/soul/draft.mjs';

test('optional character design preserves legacy authority, approval, snapshots and rollback', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-design-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '记忆')); fs.mkdirSync(path.join(root, '.pi'));
  fs.writeFileSync(path.join(root, '记忆/人格定义.json'), JSON.stringify(DEFAULT_DEFINITION));
  const api = createPersonaGovernance({ wsRoot: root, agentDir: path.join(root, '.pi') });
  const original = api.read();
  assert.deepEqual(original.problems, []);
  assert.equal(original.definition.appearance, undefined);
  const design = { appearance:'鹅蛋脸，沉静自然', hairstyle:'黑色中长发', clothing:'墨绿衬衣', scenarioOutfits:'工作：衬衣\n休闲：卫衣' };
  const plan = api.prepare('apply', { expectedRevision:original.revision, definition:design, reason:'更新人物设计' });
  assert.throws(() => api.commit(plan, 'agent'), /人工确认/);
  const applied = api.commit(plan, 'human-confirm:fixture:design');
  for (const [key,value] of Object.entries(design)) assert.equal(applied.definition[key],value);
  assert.equal(applied.definition.name, original.definition.name);
  const rendered = renderPersonaSection(applied.definition);
  for (const value of Object.values(design)) assert.ok(rendered.includes(value));
  assert.ok(rendered.includes('不代表现有立绘已更新'));
  assert.throws(() => api.prepare('apply', { expectedRevision:applied.revision, definition:{appearance:{}}, reason:'invalid' }), /文字/);
  const rolled = api.commit(api.prepare('rollback', { expectedRevision:applied.revision, snapshot_id:applied.history[0].snapshot_id, reason:'撤回设计' }), 'human-confirm:fixture:rollback');
  assert.equal(rolled.definition.appearance, undefined);
  assert.equal(rolled.history.length, 2);
});

test('design draft fields share the existing patch flow and editor lifetime', () => {
  assert.deepEqual(personaPatch({}, {appearance:'自然',hairstyle:'短发',clothing:'衬衫',scenarioOutfits:'工作：制服'}),
    {appearance:'自然',hairstyle:'短发',clothing:'衬衫',scenarioOutfits:'工作：制服'});
  const editor = fs.readFileSync(new URL('../../frontend/src/soul/PersonaEditor.tsx', import.meta.url),'utf8');
  assert.ok(editor.includes('designMode'));
  assert.ok(editor.includes('htmlFor={`${fieldId}-${key}`}'), 'field label must exclude the editable value');
  assert.ok(editor.includes('id={`${fieldId}-${key}`} aria-labelledby={`${fieldId}-${key}-label`}'), 'edited controls keep a stable accessible name');
  const soul = fs.readFileSync(new URL('../../frontend/src/pages/Soul.tsx', import.meta.url),'utf8');
  assert.ok(soul.includes("section === 'identity' || section === 'voice'"), 'one shared editor must own both drafts');
});
