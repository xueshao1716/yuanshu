// 内置技能库必须**真的到得了模型眼前**。
//
// 2026-09-15 实测踩到的坑：元枢的技能分两个来源——
//   · 仓库根 `skills/`（元枢内置，17 个）→ 只有「元枢技能」页面和元枢自研引擎看得到；
//   · Pi SDK 自己扫的 `cwd/skills` 与 `agentDir/skills`（用户的技能商店/全局技能，一百多个）
//     → 主引擎（兼容适配器）的会话**只**看得见这一份。
// 后果：问"用提示词架构师的办法…"，模型答"列表里没有 prompt-architect 技能"，转身读了
// SDK 目录里的 multi-agent-meeting；`activate_skill` 这个工具一直注册着，却永远等不到调用。
// 所以这里锁三件事：目录文本本身能用、匹配器认得这两族概念名、handleChat 真的会注入一次。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadSkillIndex } from '../../engine/context-loader.mjs';
import { formatSkillIndexPrompt, matchSkillsForTask } from '../../engine/yuanshu-protocol.mjs';

test('新增本机技能后目录仍保留全部名称，并在 4000 字预算内显示触发摘要', () => {
  const list = Array.from({ length: 44 }, (_, i) => ({ name: `local-skill-${i}`, desc: '当需要设计时使用，' + '完整设计要求'.repeat(20) }));
  const text = formatSkillIndexPrompt(list);
  assert.ok(text.length < 4000, `实际 ${text.length} 字`);
  for (const s of list) assert.ok(text.includes(`- ${s.name}：当需要设计时使用`));
});

test('目录压缩应保留位于说明末尾的适用条件', () => {
  const list = Array.from({ length: 44 }, (_, i) => ({ name: `local-skill-${i}`, desc: '完整设计要求'.repeat(12) + '。当用户需要优化提示词时使用。' }));
  const text = formatSkillIndexPrompt(list);
  assert.ok(text.length < 4000);
  for (const s of list) {
    const row = text.split('\n').find(line => line.startsWith(`- ${s.name}：`));
    assert.ok(row.includes('当用户需要优化提示词时使用。'), '压缩不能删除完整适用条件');
  }
});

test('注入给模型的技能目录：列全、每条 ≤90 字（注入时按 90 截）、写明 activate_skill', async t => {
  const list = loadSkillIndex();
  const text = formatSkillIndexPrompt(list);
  assert.ok(list.length >= 15, `内置技能只有 ${list.length} 个`);
  assert.match(text, /activate_skill/, '目录里必须写明"对得上就 activate_skill"，否则模型不知道有这条通路');
  for (const s of list) {
    await t.test(s.name, () => {
    // 取"这一条"而不是整份文本：格式化时每条按 90 字截，超出的部分模型看不到，
    // 所以触发语必须落在前 90 字里（契约测试锁的是 120——那是加载器进技能页的口径）。
    const line = text.split('\n').find(l => l.startsWith(`- ${s.name}：`));
    assert.ok(line, `目录里漏了 ${s.name}`);
    const shown = line.slice(`- ${s.name}：`.length);
    assert.ok(shown.length <= 90, `${s.name} 注入时会显示 ${shown.length} 字（应 ≤90）：${shown.slice(0, 40)}…`);
    assert.ok(/当用户|使用时|当需要|use (when|this|for)/i.test(shown), `${s.name} 的触发语被截到 90 字之外了：${shown}`);
    });
  }
  // 注入口径：一次注入整份目录（每会话一次，不重复占上下文）。
  assert.ok(text.length < 4000, `目录文本 ${text.length} 字，太长了——每会话虽只注一次，也不该压过正事`);
});

test('匹配器必须认得出内置技能里那两族"概念名"（实测曾经零命中）', () => {
  const list = loadSkillIndex();
  const top = m => matchSkillsForTask(m, list)[0]?.name || '';
  assert.equal(top('用多AI角色扮演系统（创世版）帮我判断：这个项目要不要从 Vue 迁到 React。'), 'multi-ai-roleplay');
  assert.equal(top('用提示词架构师的办法，把「给团队写周报」这个需求做成一份生产级提示词。'), 'prompt-architect');
  // 老规则不能被挤掉：视频/图片/小说三族仍要命中对口技能。
  assert.equal(top('帮我写个爆款短视频脚本'), 'aigc-video-production');
  assert.equal(top('给我出几张古代仕女写真，要证件照那种'), 'wanxiang-portrait');
  assert.equal(top('帮我写小说第 3 章'), 'novel-forge-v10');
  // 寒暄不该乱匹配（否则每轮都往上下文里塞一句无用提示）。
  assert.deepEqual(matchSkillsForTask('嗯', list), []);
  assert.deepEqual(matchSkillsForTask('谢谢', list), []);
});

// 2026-09-17：agent 自己沉淀的那批"工作纪律"技能（复盘 / 交付前验证 / 排障 / 收尾沉淀）
// 也是纯概念名，名字是英文 slug、描述是整句中文，分词永远命中不了。补了四条窄规则，
// 同时给它们关掉"媒体域"那几条加分——否则「做个视频」会因为描述里出现"视频"把它们也带上（实测噪声）。
test('匹配器要认得出"工作纪律"类技能，且不被媒体域规则误伤', () => {
  const list = loadSkillIndex();
  const top = m => matchSkillsForTask(m, list)[0]?.name || '';
  const names = m => matchSkillsForTask(m, list).map(s => s.name);
  // 复盘类技能现在有两个（daily-retrospective 与它自己后来沉淀的 daily-retro-exec-loop），
  // 断言锁"这一族要命中"，不锁具体哪个——否则元枢每沉淀一个新技能，这条就得改一次。
  assert.match(top('今天复盘一下'), /^daily-retro/, '复盘类任务要命中复盘技能');
  assert.ok(names('服务起不来帮我排障').includes('misleading-error-debugging'), '排障要命中排障守则');
  assert.ok(names('这个会话收尾沉淀一下').includes('delivery-session-closeout-review'), '收尾沉淀要命中收尾检查');
  assert.ok(names('这条链接真的能用吗，先验证再交付').includes('verify-before-delivery'), '先验证再交付要命中');
  // 纯媒体任务不许被纪律技能沾上
  for (const q of ['做个视频', '画一张海报']) {
    assert.ok(!names(q).some(n => /retrospective|closeout|verify-before-delivery|misleading-error/.test(n)), `${q} 不该命中纪律技能：${names(q).join('、')}`);
  }
  // 但"做视频 + 交付前验证"这种复合诉求要两个都点出来
  const mixed = names('做个视频，交付前先验证');
  assert.ok(mixed.includes('aigc-video-production'), '复合诉求仍要命中对口技能');
  assert.ok(mixed.includes('verify-before-delivery'), '复合诉求也该带出交付纪律');
});

test('handleChat 必须把内置技能目录注入 Pi SDK 会话（否则页面列着、模型看不见）', () => {
  const src = fs.readFileSync('server.mjs', 'utf8');
  assert.match(src, /skills: loadSkillIndex\(\)|const builtinSkills = loadSkillIndex\(\)/, 'handleChat 要取内置技能索引');
  assert.match(src, /formatSkillIndexPrompt\(/, '注入文本必须用统一的目录格式化函数（保证口径一致）');
  assert.match(src, /【元枢内置技能库】/, '注入的正文要标明来源，别和 SDK 自己那份目录混为一谈');
  assert.match(src, /matchSkillsForTask\(message/, '命中匹配时要补一句"本轮可能匹配"，把候选点名给模型');
  // "每会话一次"：只用 add-and-check 的集合，不能每轮都灌一遍整份目录。
  assert.match(src, /const skillCatalogSent = new Set\(\)/, '要有一个"已注入过的会话"集合');
  assert.match(src, /skillCatalogSent\.has\(sessKey\)/, '注入前必须判重（每会话一次）');
  assert.match(src, /skillCatalogSent\.add\(sessKey\)/, '注入后要记账');
  // 注入通道与情绪/时间/PPT 护栏同一条：nextTurn，不污染会话历史。
  assert.match(src, /【元枢内置技能库】[\s\S]{0,400}?deliverAs: "nextTurn"/, '注入必须走 nextTurn 通道');
});
