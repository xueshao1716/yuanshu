// 2026-11-08：前台聊天链路常驻形象事实。
// 以前只有消息命中「公仔|立绘|形象|长什么样|外观|姿态」才注入形象，普通轮次模型没有任何外貌事实，
// 于是 人格定义.json 里的最新外貌在对话里听不到。现在：每条消息一条精简事实（≤60 字），
// 命中关键词时再叠完整块（母提示词 + 立绘动作），两者不冲突。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildAppearanceFact, planAppearanceInjection, appearanceCatalog,
  APPEARANCE_FACT_LIMIT, APPEARANCE_FACT_PREFIX,
} from '../../engine/companion-appearance.mjs';

// 与 记忆/人格定义.json 同形的四项：第一句是主描述，后面是补充说明（精简版只取主描述）
const DEF = {
  appearance: '20 岁上下的中国女生，皮肤白净偏冷调。\n脸型偏小、下颌线干净。',
  hairstyle: '齐耳短发，深棕近黑、带一点冷调（不是暖棕），发尾自然内扣。\n前额有细碎的空气刘海。',
  clothing: '日常主穿搭：宽松的雾蓝灰连帽卫衣（低饱和的蓝），袖口宽松。\n下身穿黑色直筒短裤。',
  scenarioOutfits: '工作：同一件卫衣，袖子推得更高。\n阅读：加一件薄的灰色外套。\n外出：外搭短款深灰风衣。',
};

test('任意普通消息都有常驻精简事实（不靠关键词）', () => {
  for (const message of ['今天天气', '帮我写个脚本', '']) {
    const { fact, full } = planAppearanceInjection(message, DEF);
    assert.ok(fact.startsWith(APPEARANCE_FACT_PREFIX), `缺【形象】前缀：${message}`);
    assert.ok(fact.length <= APPEARANCE_FACT_LIMIT, `精简事实超出 ${APPEARANCE_FACT_LIMIT} 字：${fact.length}`);
    assert.match(fact, /齐耳短发/, '发型要进常驻事实');
    assert.match(fact, /雾蓝灰连帽卫衣/, '服装要进常驻事实');
    assert.equal(full, '', '普通消息不该注入完整块');
  }
});

test('关键词消息：常驻事实 + 完整块都要有', () => {
  for (const message of ['你长什么样', '你的形象是什么', '这个立绘是谁', '公仔外观', '姿态']) {
    const { fact, full } = planAppearanceInjection(message, DEF);
    assert.ok(fact.length <= APPEARANCE_FACT_LIMIT);
    assert.match(full, /【公仔形象事实】/, `关键词没触发完整块：${message}`);
    assert.match(full, /母提示词/, '完整块要保留母提示词说明');
    assert.match(full, /齐耳短发/, '完整块要带形象描述');
    assert.ok(full.length > fact.length, '完整块应比常驻事实长');
  }
});

test('完整块保留立绘动作目录与不可协商的约束（回归：别把旧块删了）', () => {
  const catalog = appearanceCatalog();
  const { full } = planAppearanceInjection('你长什么样', DEF, { catalog });
  assert.match(full, /静候（neutral）/, '立绘动作目录不能丢');
  assert.match(full, /不要声称看到了图片/, '视觉边界说明不能丢');
  assert.match(full, /不要编造衣着、发型、背景等未提供细节/, '防编造约束不能丢');
});

test('四项都能落进常驻事实；定义缺项时不注入空壳', () => {
  const fact = buildAppearanceFact(DEF);
  assert.match(fact, /20 岁上下的中国女生/);
  assert.match(fact, /齐耳短发，深棕近黑/);
  assert.match(fact, /宽松的雾蓝灰连帽卫衣/);
  assert.match(fact, /按场景换装（工作\/阅读\/外出）/, '场景穿搭应以场景名概括');
  assert.ok(fact.endsWith('。'));
  // 定义里什么都没有：返回空串，不写"未知形象"这种假事实
  assert.equal(buildAppearanceFact({}), '');
  assert.equal(planAppearanceInjection('今天天气', {}).fact, '');
  // 只有一项时也只给那一项，不编造
  assert.equal(buildAppearanceFact({ hairstyle: '及肩长发' }), '【形象】及肩长发。');
});

test('server.mjs 的 handleChat 常驻注入不再被关键词 if 包住', () => {
  const src = fs.readFileSync(new URL('../../server.mjs', import.meta.url), 'utf8');
  assert.match(src, /planAppearanceInjection\(message, def/, 'handleChat 要调用统一的注入计划');
  assert.doesNotMatch(src, /if \(\/\(公仔\|立绘\|形象\|长什么样\|外观\|姿态\)\/\.test\(message\)\) \{/,
    '常驻事实不该再被关键词条件包住');
});
