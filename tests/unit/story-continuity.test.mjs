// 连续创作「人物一致性」升级契约（2026-09-14）
//
// 背景：界面自己写着「尚不能锁定人物外貌」，根因不是没写这个功能，而是两层都没通：
//  1) 编排层的 references 只是把 id 拼进提示词文本，从未把图当图片输入；
//  2) modelCapabilities 只产出 chat/image/video/tts/asr，**从不产出 reference/keyframe/seed**，
//     于是 negotiateCapabilities 对每一个图像/视频任务都报「当前模型不支持参考资产」——
//     能力协商层在问一个没有任何代码去填的字段，用户看到的是假的降级提示。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageAdapter, createVideoAdapter } from '../../engine/story-adapters.mjs';
import { modelCapabilities } from '../../engine/model-probe.mjs';
import { negotiateCapabilities, pickReferenceImages } from '../../engine/story-orchestrator.mjs';
import { buildPortraitPrompt } from '../../engine/story-prompts.mjs';

test('图像适配器把角色定妆照作为真实 image 参数传给上游（图生图），而不是只拼文本', async () => {
  let got = null;
  const adapter = createImageAdapter({
    generateImage: async (provider, modelId, prompt, size, image) => { got = { prompt, size, image }; return 'data:image/png;base64,aGk='; },
    saveArtifact: async () => '/signed/img.png',
  });
  await adapter.generate({ prompt: '电影感车站', model: { provider: 'p', id: 'm' }, referenceImages: ['/ref/hero.png'] });
  assert.equal(got.image, '/ref/hero.png', '必须把参考图当图片参数传下去，否则人物一致性无从谈起');
  assert.match(got.prompt, /已附角色定妆照参考图/);
});

test('没有参考图时如实说明一致性有限，不假装锁定了人物', async () => {
  let got = null;
  const adapter = createImageAdapter({
    generateImage: async (provider, modelId, prompt, size, image) => { got = { prompt, image }; return 'data:image/png;base64,aGk='; },
    saveArtifact: async () => '/signed/img.png',
  });
  await adapter.generate({ prompt: '电影感车站', model: { provider: 'p', id: 'm' } });
  assert.equal(got.image, undefined);
  assert.match(got.prompt, /无参考图/);
});

test('视频适配器把定妆照放进 images[]，交由 videoCreateBody 落成 reference 模式', async () => {
  let body = null;
  const adapter = createVideoAdapter({
    generateVideo: async (provider, modelId, prompt, b) => { body = b; return { video: 'https://cdn.example/v.mp4' }; },
    saveArtifact: async () => '/signed/v.mp4',
  });
  await adapter.generate({ prompt: '车站告别', model: { provider: 'p', id: 'm' }, params: { seconds: '5' }, referenceImages: ['/ref/hero.png'] });
  assert.deepEqual(body.images, ['/ref/hero.png']);
  assert.equal(body.seconds, '5', '原有生成参数必须保留，不能被参考图覆盖');
});

test('能力声明补齐 reference/keyframe/seed，降级提示不再无差别误报', () => {
  const image = modelCapabilities('agnes-image-2.5-flash');
  const video = modelCapabilities('agnes-video-2.5-flash');
  const text = modelCapabilities('glm-5.3-flash');
  assert.equal(image.reference, true, '图像模型应声明会转发参考图');
  assert.equal(image.seed, true);
  assert.equal(video.keyframe, true, '视频模型额外支持关键帧');
  assert.equal(text.reference, undefined, '纯文本模型不得声明参考图能力');
  assert.deepEqual(negotiateCapabilities({ reference: true, keyframe: false, seed: true }, image).degradation, []);
  assert.deepEqual(negotiateCapabilities({ reference: true, keyframe: true, seed: false }, video).degradation, []);
});

test('出场角色判定：名字出现在提示词里就带它的定妆照，否则退回主角，没图的不算', () => {
  const project = { bible: { characters: [
    { id: 'c1', name: '阿宁', refImage: '/ref/aning.png' },
    { id: 'c2', name: '小雨', refImage: '/ref/xiaoyu.png' },
    { id: 'c3', name: '路人', refImage: '/ref/passer.png' },
    { id: 'c4', name: '没图角色' },
  ] } };
  assert.deepEqual(pickReferenceImages(project, '## 角色\n- name: 小雨，appearance: 短发'), ['/ref/xiaoyu.png']);
  // 一个名字都没命中 → **退回主角（就一张）**，不是"退回前 N 个"。
  // 旧期望是 ['aning','xiaoyu']，那是把"退回首 limit 个"当成了"退回主角"；
  // 2026-09-15 同时发现这条判定在真实调用里是退化的（compileStoryPrompt 会把整个 bible 列进
  // 提示词，于是每个名字都"出现"），所以判定改为基于**段落自己的文本**，见 pickReferenceImages 的注释。
  assert.deepEqual(pickReferenceImages(project, '没有任何名字命中'), ['/ref/aning.png']);
  assert.deepEqual(pickReferenceImages({ bible: { characters: [{ id: 'x', name: '甲' }] } }, '甲'), [], '没有定妆照就返回空，不能编一个');
});

test('定妆照提示词限定单人正面纯色背景并可复用，避免生成成一张插画', () => {
  const text = buildPortraitPrompt({ bible: { style: { visual: '胶片颗粒' } }, character: { id: 'c1', name: '阿宁', appearance: '黑发，左脸有痣' } });
  assert.match(text, /定妆照/);
  assert.match(text, /单人/);
  assert.match(text, /纯色背景/);
  assert.match(text, /不要出现任何文字/);
  assert.match(text, /胶片颗粒/, '统一视觉风格必须带进去');
  assert.match(text, /左脸有痣/, '角色自身设定必须带进去');
});

// 2026-09-16（借 hypit 的 Person/Shot 写法）：半身像最容易毁在"窄肩配大脑袋"，
// 而"身形挺拔/气质出众"这种笼统赞美对模型等于没说。所以提示词里必须有**可量的结构**
// 与**明确的镜头**，并且要显式禁止用笼统词代替结构描述。
test('定妆照提示词带身体结构锚点与镜头写法，并禁止笼统赞美', () => {
  // 故意**不**在 appearance 里写结构词，否则断言会被角色设定本身的文字满足，
  // 测不到新加的段落——这是这条用例存在的意义。
  const text = buildPortraitPrompt({ bible: {}, character: { id: 'c1', name: '阿宁', appearance: '25岁东亚男性，短发' } });
  assert.match(text, /## 身体比例/, '要有独立的身体比例段');
  assert.match(text, /肩要宽/, '肩宽是最关键的结构锚点');
  assert.match(text, /头肩比/, '头肩比要写出来');
  assert.match(text, /## 镜头/, '要有独立的镜头段');
  assert.match(text, /85mm/, '焦距写具体，模型对镜头很敏感');
  assert.match(text, /不要用"身形挺拔\/气质出众\/well presented"/, '必须显式反对笼统赞美');
});

test('定妆照带形象变体时：形象名在提示词里，且"换装不换脸"的约束不能丢', () => {
  const text = buildPortraitPrompt({
    bible: { style: { visual: '胶片颗粒' } },
    character: { id: 'c1', name: '阿宁', appearance: '黑发', wardrobe: '灰色卫衣' },
    look: { id: 'l2', name: '战斗装束', refImage: '/signed/l2.png' },
  });
  assert.match(text, /战斗装束/, '这一张的形象名必须在提示词里');
  assert.match(text, /这一张的服装与装备以「战斗装束」为准/, '形象是这一张服装的权威来源');
  assert.match(text, /同一张脸的不同形象/, '换装不能换脸');
  assert.match(text, /肩要宽/, '换装也一样受身体结构约束');
});
