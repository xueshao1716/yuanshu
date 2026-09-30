import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProject, writeProject } from '../../engine/story-store.mjs';
import { createStoryOrchestrator, handleStoryAssist } from '../../engine/story-orchestrator.mjs';

const catalog = [
  { provider: 'p', id: 'text', capabilities: { chat: true } },
  { provider: 'p', id: 'flux-1' },
  { provider: 'p', id: 'off', enabled: false, capabilities: { image: true } },
  { provider: 'p', id: 'legacy', capabilities: ['image'] },
];
async function fixture(t, models = catalog) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-story-selection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await writeProject(root, createProject({ title: 'selection', scenes: [{ id: 's', beats: [{ id: 'b', kind: 'image', prompt: '画一片海' }], outputs: [] }] }, { id: () => 'p' }));
  const ctx = { root, getModelList: () => models, getDefaultModel: () => catalog[0] };
  return { ctx, api: createStoryOrchestrator(ctx) };
}

test('story rejects missing, disabled and wrong-kind explicit choices before generation', async t => {
  const { api } = await fixture(t);
  for (const model of [
    { provider: 'p', id: 'removed' },
    { provider: 'p', id: 'off' },
    { provider: 'p', id: 'text', capabilities: { image: true } },
  ]) {
    await assert.rejects(api.previewRun('p', { sceneId: 's', beatId: 'b', kind: 'image', model }), /模型/);
    await assert.rejects(api.runGeneration('p', { sceneId: 's', beatId: 'b', kind: 'image', model }), /模型/);
    assert.equal((await api.get('p')).scenes[0].outputs.length, 0);
  }
});

test('story auto selection recognizes inferred and legacy image models, never text default', async t => {
  for (const models of [[catalog[0], catalog[1]], [catalog[2], catalog[3]]]) {
    const { api } = await fixture(t, models);
    const result = await api.previewRun('p', { sceneId: 's', beatId: 'b', kind: 'image' });
    assert.equal(result.plan.find(s => s.label === '模型').detail, `p/${models[1].id}`);
  }
  const { api } = await fixture(t, [catalog[0]]);
  await assert.rejects(api.previewRun('p', { sceneId: 's', beatId: 'b', kind: 'image' }), /模型/);
});

test('story assist never silently substitutes an explicitly selected failed model', async t => {
  const { ctx } = await fixture(t, [catalog[0], { provider: 'p', id: 'other' }]);
  const seen = [];
  const res = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
  await handleStoryAssist({ ...ctx, directChat: async model => { seen.push(model.id); throw new Error('fixture upstream failure'); } }, res, 'p', { idea: '开场', model: { provider: 'p', id: 'other' } });
  assert.equal(res.status, 502);
  assert.deepEqual(seen, ['other']);
  seen.length = 0;
  await handleStoryAssist({ ...ctx, directChat: async model => { seen.push(model.id); } }, res, 'p', { idea: '开场', model: catalog[1] });
  assert.equal(res.status, 400);
  assert.deepEqual(seen, []);
});

test('workshop selectors retain unavailable saved choices and expose recovery', () => {
  const read = p => fs.readFileSync(new URL('../../frontend/src/' + p, import.meta.url), 'utf8');
  const story = read('pages/StoryWorkbench.tsx');
  assert.ok(!story.split('\n').some(line => line.includes('useEffect') && line.includes('availableModels.some') && line.includes("setSelectedModel('')")));
  assert.ok(story.includes('selectedModelMissing'));
  assert.ok(story.includes('planningModelMissing'));
  const workshop = read('components/WorkshopModelPicker.tsx');
  assert.ok(workshop.includes('saved || fallback'));
  assert.ok(workshop.includes('已选模型不可用'));
});
