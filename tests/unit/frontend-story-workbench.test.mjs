import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('frontend/src/pages/StoryWorkbench.tsx', 'utf8');
const apiSource = fs.readFileSync('frontend/src/api.ts', 'utf8');
test('story workbench exposes timeline and a guided primary flow', () => {
  assert.match(source, /分镜时间线/);
  assert.match(source, /StoryStart/);
  assert.match(source, /生成当前/);
  assert.match(source, /从此处继续/);
  // 旧契约断言的是「版本对比」——那是一个 <select> 版本下拉。
  // 意图（旧版本必须看得见）没变，呈现方式变了：2026-09 起所有版本平铺，新的在最上面，
  // 下拉被删掉了，所以这里锁"平铺 + 不再有隐藏版本的下拉"，而不是锁那个词。
  const results = fs.readFileSync('frontend/src/components/story/StoryResults.tsx', 'utf8');
  assert.match(results, /全部保留/);
  // 只看代码行：注释里还留着"此前藏在 <select> 里"的说明，不该被当成代码证据
  const resultsCode = results.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.ok(!/<select/.test(resultsCode), '版本不能再藏进下拉里');
});

test('台词与跨工作台素材必须留在界面上（这是台前的入口，掉了就等于功能没了）', () => {
  assert.match(source, /aria-label="本段台词"/, '台词要有独立的可编辑字段');
  assert.match(source, /StoryMaterials/, '素材挂载面板要挂在制作台里');
  assert.match(source, /dialogue:dialogueDraft/, '台词要跟着段一起存盘');
  assert.match(source, /inputs:inputDrafts/, '素材要跟着段一起存盘');
  const materials = fs.readFileSync('frontend/src/components/story/StoryMaterials.tsx', 'utf8');
  assert.match(materials, /WsApi\.artifacts/, '素材来源之一：别的工作台的产物（生成物）');
  assert.match(materials, /NovelApi\.chapter/, '素材来源之二：小说工坊的正文');
  assert.match(materials, /text: '文本'/, '文本素材要能挂进来');
  const types = fs.readFileSync('frontend/src/types.ts', 'utf8');
  assert.match(types, /dialogue\?: string/);
  assert.match(types, /inputs\?: StoryBeatInput\[\]/);
});

test('产线参数必须留在界面上：负向 / seed / 变体数 / 执行链 / 同参重跑', () => {
  assert.match(source, /aria-label="本段负向提示词"/, '负向提示词要有输入框');
  assert.match(source, /aria-label="seed"/, 'seed 要能填（留空=现掷并记下）');
  assert.match(source, /aria-label="变体数量"/, '一次出几版要有选择');
  assert.match(source, /seed:negativeDraft|negative:negativeDraft/, '负向要跟着段一起存盘');
  assert.match(source, /StoryApi\.previewRun\([^)]*runExtras/, '预览必须带上和实跑同一套参数');
  assert.match(source, /setPlan\(r\.plan/, '执行链要显示出来');
  const results = fs.readFileSync('frontend/src/components/story/StoryResults.tsx', 'utf8');
  assert.match(results, /照这版重跑/, '同参重跑要有入口');
  assert.match(results, /onRerun/, '重跑要接回编排层');
  const types = fs.readFileSync('frontend/src/types.ts', 'utf8');
  assert.match(types, /negative\?: string/);
  assert.match(types, /StoryPlanStep/);
});

test('配方必须留在界面上：保存 / 套用 / 套用到全项目 / 导出 / 导入', () => {
  assert.match(source, /StoryRecipes/, '配方面板要挂在制作台里');
  const rec = fs.readFileSync('frontend/src/components/story/StoryRecipes.tsx', 'utf8');
  for (const need of ['StoryApi.saveRecipe', 'StoryApi.deleteRecipe', 'StoryApi.exportRecipes', 'StoryApi.importRecipes', '套用到本项目所有段落', '导入 JSON', '导出全部']) {
    assert.ok(rec.includes(need), `配方面板缺「${need}」`);
  }
  assert.match(source, /applyRecipe/, '套用要接回制作台');
  // 工艺参数要真的能选：params 以前是个没人填的空字段，配方要携带它就必须先有它
  assert.match(source, /aria-label="尺寸"/);
  assert.match(source, /aria-label="时长"/);
  assert.match(source, /params: paramDraft/);
  const api = fs.readFileSync('frontend/src/api.ts', 'utf8');
  assert.match(api, /recipes: \(\) => api<\{ recipes: StoryRecipe\[\] \}>/);
  assert.match(api, /\/api\/story\/recipes\/import/);
});

test('参考图策略与项目默认配方必须留在界面上', () => {
  assert.match(source, /aria-label="参考图张数"/, '张数要能设（0 = 明确不用参考图）');
  assert.match(source, /aria-label="参考图优先"/, '谁优先要能设');
  assert.match(source, /reference: refDraft/, '策略要跟着这次生成上送');
  assert.match(source, /setDefaultRecipe/, '要能设为项目默认');
  assert.match(source, /recipeBeatPatch\(currentDefaultRecipe\)/, '新段落要盖上默认配方的类型与负向');
  const rec = fs.readFileSync('frontend/src/components/story/StoryRecipes.tsx', 'utf8');
  assert.match(rec, /设为项目默认/);
  assert.match(rec, /取消项目默认/);
  assert.match(rec, /refStrategyLabel/, '配方卡上要看得见参考图策略');
  // 前端默认值必须和后端一致，否则界面显示的和真正发出去的不是一回事
  const lib = fs.readFileSync('frontend/src/lib/story-ref.ts', 'utf8');
  assert.match(lib, /kind === 'image' \? 1 : kind === 'video' \? 4 : 0/);
  const be = fs.readFileSync('engine/story-recipes.mjs', 'utf8');
  assert.match(be, /images: kind === 'image' \? 1 : kind === 'video' \? 4 : 0/, '后端那份是权威，两处必须同一套默认值');
  const types = fs.readFileSync('frontend/src/types.ts', 'utf8');
  assert.match(types, /defaultRecipeId\?: string/);
  assert.match(types, /reference: \{ images: number; prefer: 'material' \| 'portrait' \}/);
});

test('视频异步：创建与收尾分开，超窗不等于失败', () => {
  assert.match(source, /StoryApi\.checkRun/, '要有收尾查询的调用');
  assert.match(source, /pollRuns/, '启动后要短轮询');
  assert.match(source, /pollWindowMs/, '轮询窗口用后端给的值，前端不自己写常量');
  assert.match(source, /查一次/, '排队中的版本要有人工「查一次」的入口');
  assert.match(source, /排上队/, '创建成功只是排队，不能报成"出片了"');
  const results = fs.readFileSync('frontend/src/components/story/StoryResults.tsx', 'utf8');
  assert.match(results, /onCheck/, '结果卡片要把「查一次」接出去');
  assert.match(results, /run\.taskId/, '只有带任务号的运行才谈得上查');
  const api = fs.readFileSync('frontend/src/api.ts', 'utf8');
  assert.match(api, /run-check/);
  // 不再用"一条请求干等三分钟"的长超时
  assert.doesNotMatch(api, /run: \(id[^\n]*timeoutMs: 900000/, '创建不该再阻塞几分钟');
});

test('剧本要素 / 导出 / 试戏 必须留在界面上（照 Laper 补的地基）', () => {
  assert.match(source, /StoryScript/, '剧本与导出的面板要挂在制作台');
  assert.match(source, /StoryPlayground/, '试戏面板要挂在制作台');
  assert.match(source, /aria-label="本段动作"/, '动作行要能单独写（它和画面描述不是一回事）');
  assert.match(source, /aria-label="转场"/);
  assert.match(source, /aria-label="内外景"/);
  assert.match(source, /aria-label="场景地点"/);
  assert.match(source, /aria-label="场景时间"/);
  const script = fs.readFileSync('frontend/src/components/story/StoryScript.tsx', 'utf8');
  for (const need of ['StoryApi.exportScript', 'StoryApi.scriptStats', 'fdx', 'fountain', '没有真机打开验证过']) {
    assert.ok(script.includes(need), `剧本面板缺「${need}」`);
  }
  const pg = fs.readFileSync('frontend/src/components/story/StoryPlayground.tsx', 'utf8');
  for (const need of ['StoryApi.playground', 'StoryApi.playgroundClear', '不许编新设定', '最多 20 句']) {
    assert.ok(pg.includes(need), `试戏面板缺「${need}」`);
  }
  const api = fs.readFileSync('frontend/src/api.ts', 'utf8');
  assert.match(api, /script-export/);
  assert.match(api, /playground-clear/);
});

test('作品列表：段号取生成时的定格值、失败可见、成片落回项目', () => {  const products = fs.readFileSync('frontend/src/components/story/StoryProducts.tsx', 'utf8');
  // 段号优先用 run.beatNo（生成时刻定格），只在旧数据上按当前分镜顺序回退
  assert.match(products, /run\.beatNo/);
  assert.match(products, /run\.sceneTitle/);
  // 没有产物的运行默认折叠但不丢弃：失败的必须看得见
  assert.match(products, /只看有产物的/);
  assert.match(products, /degradation/);
  // 成片是作品，写在项目里而不是一次性的本地状态
  assert.match(products, /project\.films/);
  assert.match(fs.readFileSync('frontend/src/types.ts', 'utf8'), /films\?: StoryFilm\[\]/);
});

test('story workbench exposes model selection and forwards it to generation', () => {
  assert.match(source, /ModelsApi/);
  assert.match(source, /自动选择模型/);
  assert.match(source, /模型/);
  assert.match(source, /selectedModel/);
  assert.match(source, /model:/);
  assert.match(apiSource, /assist:.*model\?/);
  assert.match(apiSource, /body: \{ idea, model \}/);
});

test('story workbench renders generated media in an inline preview surface', () => {
  assert.match(source, /StoryResults/);
});

test('story workbench lets the current shot choose output type and edit its prompt', () => {
  assert.match(source, /selectedKind/);
  assert.match(source, /输出类型/);
  assert.match(source, /本段内容/);
  assert.match(source, /setGenerationKind/);
  assert.match(source, /kind: selectedKind/);
});

test('story smart fill applies bible, scene and shot in one save', () => {
  assert.match(source, /applyStoryDraft/);
  assert.match(source, /hydrateBible/);
  assert.ok(!source.includes('fixed inset-x-3 bottom-20'));
});

// 配色卡（2026-09-16）：台前必须有入口，否则"选了配色才进提示词"这件事根本没法发生
test('配色卡必须留在制作台上，并且真的存进项目', () => {
  const settings = fs.readFileSync('frontend/src/components/story/StorySettings.tsx', 'utf8');
  assert.match(settings, /COLOR_CARDS/, '设置面板要列出色卡（两套 18 组）');
  assert.match(settings, /colorCardGradient/, '色块用共享渐变函数，页面不自己拼 CSS');
  assert.match(settings, /onColorCard\?\.\(card\.id\)/, '点色卡要把 id 交出去');
  assert.match(settings, /不指定/, '要能取消——选了就必须能退回"没有配色"');
  assert.match(settings, /aria-label=\{`配色卡 \$\{card\.name\}/, '色块要有可读的名字（无障碍 + 真机核对靠它定位）');

  assert.match(source, /colorCardId=\{project\.colorCardId\}/, '要把项目上的配色传给设置面板');
  assert.match(source, /StoryApi\.patchProject\(project\.id, \{ colorCardId \}\)/, '选完立刻存进项目（不跟设定文本框一起等保存）');
});

// 示意缩略图（2026-09-16）：一组 hex 看不出"落在画面里什么感觉"，
// 提示词面板里要有一块真的渐变，并且分清"按整片配色"和"这一段破格"。
test('提示词面板要有配色示意缩略图，且分清按整片 / 这一段破格', () => {
  const chip = fs.readFileSync('frontend/src/components/story/StoryColorCardChip.tsx', 'utf8');
  assert.match(chip, /colorCardGradient/, '缩略图要用共享渐变函数');
  assert.match(chip, /story-color-chip-swatch/, '要有真的色块，而不是一行字');
  assert.match(chip, /本段破格|这一段破格/, '破格必须显式标出');
  assert.match(chip, /跟随全局/, '跟随全局的要标出来');
  assert.match(chip, /resolveColorCard\(colorCardId\)/, '没选配色就什么都不渲染');

  assert.match(source, /<StoryColorCardChip /, '提示词面板要挂上它');
  assert.match(source, /aria-label="色调"/, '镜头规格要能写这一镜的色调（留空=按整片配色）');
  assert.match(source, /tone: sh\.tone \|\| ''/, '色调要跟着段落读回来，不能只写不读');
});
