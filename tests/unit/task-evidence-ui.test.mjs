import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = name => { try { return fs.readFileSync(new URL(`../../frontend/src/${name}`, import.meta.url), 'utf8'); } catch { return ''; } };
test('evolution page offers explicit review with unchecked skill labels and visible invalidation', () => {
  const panel = source('components/TaskEvidencePanel.tsx');
  const editor = source('components/TaskEvidenceEditor.tsx');
  const page = source('pages/Apps.tsx');
  assert.ok(page.includes('<TaskEvidencePanel />'));
  for (const text of ['真实任务验收', '进化进度', '天团', 'holdout', 'canary']) assert.ok(panel.includes(text), text);
  assert.ok(editor.includes('useState<string[]>([])'));
  for (const text of ['reviewable', '合格', '有问题', '撤销验收', '验收说明', 'min-h-11']) assert.ok(editor.includes(text), text);
  assert.ok(editor.includes('artifact.error'));
  assert.ok(editor.includes('evolutionError'));
});
