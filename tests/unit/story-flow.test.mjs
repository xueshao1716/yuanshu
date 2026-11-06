// 流水线状态机的契约：它决定"界面上哪些按钮亮着、为什么灰着"，错了就是用户对着屏幕猜。
import test from 'node:test';
import assert from 'node:assert/strict';
import { storyFlow, FLOW_STEPS, FLOW_ACTIONS } from '../../engine/story/flow.mjs';

const mk = (over = {}) => ({
  id: 'p1', title: '测试', logline: '一句话梗概',
  bible: { characters: [{ id: 'c1', name: '林晚', appearance: '三十岁女性' }], locations: [], props: [] },
  scenes: [], films: [],
  ...over,
});
const beat = (id, kind = 'video', over = {}) => ({ id, kind, prompt: '她推门进来', ...over });
const scene = (beats, outputs = []) => ({ id: 's1', index: 1, title: '便利店', summary: '', beats, outputs });
const run = (beatId, kind = 'video', over = {}) => ({ id: `r-${beatId}`, beatId, kind, status: 'succeeded', outputAssets: [{ url: '/api/ws/file/x.mp4' }], ...over });

// 真机核过的形状：产物在 outputAssets 里，run.url 是 undefined；degraded 也算有成品。
test('产物在 outputAssets 里也要算数（真机：run.url 全 undefined，只看它会把出过片的段落当没成品）', () => {
  const withAssets = mk({ scenes: [scene([beat('b1')], [{ id: 'r1', beatId: 'b1', kind: 'video', status: 'succeeded', outputAssets: [{ url: '/api/ws/file/a.mp4' }] }])] });
  assert.equal(storyFlow(withAssets).progress.beats.done, 1, 'outputAssets 里的产物要算完成');
  // degraded = 片子到了但带降级说明，算有成品；failed 不算
  const degraded = mk({ scenes: [scene([beat('b1')], [{ id: 'r1', beatId: 'b1', kind: 'video', status: 'degraded', outputAssets: [{ url: '/x.mp4' }] }])] });
  assert.equal(storyFlow(degraded).progress.beats.done, 1, 'degraded 算有成品');
  const noArtifact = mk({ scenes: [scene([beat('b1')], [{ id: 'r1', beatId: 'b1', kind: 'video', status: 'succeeded' }])] });
  assert.equal(storyFlow(noArtifact).progress.beats.done, 0, '状态说成功但没有产物 → 不算完成');
});

test('阶段顺序与"当前阶段"：没有段落=script，缺定妆照=assets，缺成品=shots，没成片=film', () => {
  assert.deepEqual(FLOW_STEPS.map(s => s.id), ['script', 'assets', 'shots', 'film']);
  assert.equal(storyFlow(mk()).current_step, 'script', '没有段落 → 剧本大纲');
  const withBeats = mk({ scenes: [scene([beat('b1')])] });
  assert.equal(storyFlow(withBeats).current_step, 'assets', '有段落但没定妆照 → 资产库');
  const withPortrait = mk({
    bible: { characters: [{ id: 'c1', name: '林晚', refImage: 'a.png' }] },
    scenes: [scene([beat('b1')])],
  });
  assert.equal(storyFlow(withPortrait).current_step, 'shots', '定妆照齐了但没成品 → 分镜成片');
  const withOutput = mk({
    bible: { characters: [{ id: 'c1', name: '林晚', refImage: 'a.png' }] },
    scenes: [scene([beat('b1')], [run('b1')])],
  });
  assert.equal(storyFlow(withOutput).current_step, 'film', '都有成品 → 成片');
  const done = mk({
    bible: { characters: [{ id: 'c1', name: '林晚', refImage: 'a.png' }] },
    scenes: [scene([beat('b1')], [run('b1')])],
    films: [{ id: 'f1', url: 'x.mp4' }],
  });
  assert.equal(storyFlow(done).current_step, 'done');
  assert.match(storyFlow(done).headline, /走完整条流水线/);
});

test('被挡住的动作必须给出理由和话（不是灰按钮），且理由要具体到数字', () => {
  const f = storyFlow(mk({ scenes: [scene([beat('b1'), beat('b2')], [run('b1')])] }));
  const film = f.blocked_actions.find(b => b.action === 'compose_film');
  assert.ok(film, '只有 1 段可用视频时必须挡住合成');
  assert.equal(film.reason_code, 'not_enough_clips');
  assert.match(film.message, /只有 1 段/, '理由要带数字，不能只说"不可用"');
  const shot = f.blocked_actions.find(b => b.action === 'generate_shot');
  assert.equal(shot, undefined, '还有段落没成品 → 生成当前段是允许的');
  // 全都做完了：生成当前段要被挡住并说明原因
  const allDone = storyFlow(mk({
    bible: { characters: [{ id: 'c1', name: '林晚', refImage: 'a.png' }] },
    scenes: [scene([beat('b1')], [run('b1')])],
  }));
  assert.equal(allDone.blocked_actions.find(b => b.action === 'generate_shot').reason_code, 'all_done');
  // 没有角色：定妆照要说"先登记人物"
  const noCast = storyFlow(mk({ bible: { characters: [] } }));
  assert.equal(noCast.blocked_actions.find(b => b.action === 'generate_portrait').reason_code, 'no_characters');
  // 有段落但没梗概：一键分镜仍然允许（服务端会用已有段落续排）
  assert.ok(storyFlow(mk({ logline: '', scenes: [scene([beat('b1')])] })).allowed_actions.some(a => a.action === 'generate_storyboard'));
  // 连梗概都没有：一键分镜要挡住
  assert.equal(storyFlow(mk({ logline: '', bible: { characters: [] } })).blocked_actions.find(b => b.action === 'generate_storyboard').reason_code, 'no_outline');
});

test('失败与进行中优先于一切：推荐里先给"重试/查看"，并给 failed_recovery_actions', () => {
  const f = storyFlow(mk({
    bible: { characters: [{ id: 'c1', name: '林晚', refImage: 'a.png' }] },
    scenes: [scene([beat('b1'), beat('b2')], [run('b1'), run('b2', 'video', { status: 'failed', url: '' }), run('b2', 'video', { id: 'r3', status: 'running', url: '' })])],
  }));
  assert.equal(f.progress.beats.failed, 1);
  assert.equal(f.progress.beats.running, 1);
  assert.equal(f.recommended_actions[0], 'retry_failed');
  assert.deepEqual(f.failed_recovery_actions, ['retry_failed', 'check_running']);
  assert.match(f.headline, /失败/);
  // 只有进行中的时候，恢复动作是"查看"
  const onlyRunning = storyFlow(mk({ scenes: [scene([beat('b1')], [run('b1', 'video', { status: 'running', url: '' })])] }));
  assert.deepEqual(onlyRunning.failed_recovery_actions, ['check_running']);
  assert.match(onlyRunning.headline, /进行中/);
  assert.equal(storyFlow(mk()).failed_recovery_actions, null);
});

test('外链产物要被认出来并推荐"拉到本地"（本地路径不算外链）', () => {
  const ext = storyFlow(mk({
    scenes: [scene([beat('b1')], [
      run('b1', 'video', { outputAssets: [{ url: 'https://cdn.example.com/a.mp4' }] }),
      run('b1', 'video', { id: 'r2', outputAssets: [{ url: 'http://127.0.0.1:8787/api/ws/file/b.mp4' }] }),
    ])],
  }));
  assert.equal(ext.progress.external, 1, '只算真正的外链');
  assert.ok(ext.allowed_actions.some(a => a.action === 'localize_external'));
});

test('每个动作都有 label 与 panel，界面不用再抄一份文案', () => {
  const f = storyFlow(mk());
  for (const item of [...f.allowed_actions, ...f.blocked_actions]) {
    assert.ok(FLOW_ACTIONS[item.action], `${item.action} 不在动作目录里`);
    assert.ok(item.label, `${item.action} 缺 label`);
    assert.ok(item.panel, `${item.action} 缺 panel（界面靠它跳到对应面板）`);
  }
  assert.ok(f.steps.every(s => s.label && s.hint));
  // 推荐动作只能是允许的动作——推荐一个被挡住的等于自相矛盾
  const allowedIds = new Set(f.allowed_actions.map(a => a.action));
  assert.ok(f.recommended_actions.every(id => allowedIds.has(id)));
  // 已经做完的东西不该再被推荐
  const done = storyFlow(mk({
    bible: { characters: [{ id: 'c1', name: '林晚', refImage: 'a.png' }] },
    scenes: [scene([beat('b1')], [run('b1')])], films: [{ id: 'f1' }],
  }));
  assert.ok(!done.recommended_actions.includes('generate_portrait'));
});
