// 台词与深度构思的"手艺"契约。
//
// 用户说「人物、场景搭上了，对话以及深度构思还是不行」。去同行那儿翻到的可执行规则
// （语速 3.5~5 字/秒、单句 >24 字强制拆镜、标点不计入字数、伏笔必须写回收集、单条矛盾硬帽 20~30 集），
// 这里全部钉成机检——**这些本来就是能算的**，不该花一次模型调用才知道"这句说不完"。
import test from 'node:test';
import assert from 'node:assert/strict';
import { speakableChars, splitSentences, speechCheck, dialogueAudit, auditEngine, parseDialogueDoctor, parseStoryEngine, buildDialogueDoctorPrompt, buildStoryEnginePrompt, SPEECH } from '../../engine/story/craft.mjs';
import { extractJsonObjects } from '../../engine/story/assist.mjs';
import { lintStoryProject } from '../../engine/story/lint.mjs';

test('语速自检：只数可发音字符（标点不计入字数，另算停顿）', () => {
  // 同行那条规则最容易忽略的一点：把标点算进字数会高估时长
  assert.equal(speakableChars('你为什么不走？'), 6);
  assert.equal(speakableChars('走哪儿。'), 3);
  assert.equal(speakableChars('A/B 测试：3 次'), 6); // A B 测 试 3 次 → 字母与数字都算，斜杠冒号空格不算
  const one = speechCheck('你为什么不走？');
  assert.equal(one.chars, 6);
  assert.equal(one.minSec, +(6 / 5 + 0.45).toFixed(2), '口播 + 句末停顿');
  assert.ok(one.maxSec > one.minSec);
});

test('语速自检：>24 字强制拆镜；接近上限给提示；>5 字/秒连续超 3 秒要给气口', () => {
  const long = speechCheck('三年前你杀我师父灭我师门占我武馆今日我陈烬归来倒要看看谁该灭门偿命');
  assert.ok(long.chars > SPEECH.lineMax);
  const tooLong = long.issues.find(i => i.code === 'line-too-long');
  assert.ok(tooLong, '超过 24 字必须报拆镜');
  assert.match(tooLong.message, /拆成 \d+ 个镜头/);
  assert.match(tooLong.message, /每镜 ≤18 字/);
  assert.equal(long.level, 'warn');
  // 18~24 字之间的句子只提示、不当硬问题
  const near = speechCheck('我今天一定要把这件事说清楚你听好了');
  assert.ok(!near.issues.some(i => i.code === 'line-too-long'));
  // 拆句：按标点断
  assert.deepEqual(splitSentences('一。二！三？'), ['一。', '二！', '三？']);
});

test('语速自检：超出这一段的时间预算要说清"最快也要几秒"', () => {
  const over = speechCheck('我今天一定要把这件事说清楚你听好了别打断我', { budgetSec: 3 });
  const issue = over.issues.find(i => i.code === 'over-budget');
  assert.ok(issue, '说不完必须报');
  assert.match(issue.message, /按 5 字\/秒最快也要/);
  assert.equal(issue.budgetSec, 3);
  assert.equal(over.level, 'warn');
});

test('台词七维里能机检的：0 层直白 / 自报家门 / 寒暄 / 古装出现现代词 / 句子长短无差别', () => {
  const audit = dialogueAudit({
    dialogue: [
      '阿宁：我很愤怒，我要杀了你。',
      '阿宁：我是你师兄，这是我应该做的。',
      '老周：你好。',
      '阿宁：这个项目的逻辑和成本结构需要重新评估一下，否则我们没有效率。',
      '阿宁：走。',
      '老周：好。',
    ].join('\n'),
    genre: '古装武侠',
  });
  const dims = audit.issues.map(i => `${i.dim}:${i.level}`);
  assert.ok(dims.includes('潜台词:warn'), '把情绪直接说出来 = 0 层直白');
  assert.ok(dims.includes('信息效率:warn'), '自报家门式交代必须报');
  assert.ok(dims.includes('冲突推进力:info'), '寒暄/附和要提示（不改变任何东西）');
  assert.ok(dims.includes('类型语感:warn'), '古装出现"逻辑/成本/效率"要报');
  // 金句潜力无法机检 —— 必须老实标出来，别让人以为机检过了就等于台词好
  assert.deepEqual(audit.humanDims, ['金句潜力']);
  assert.equal(audit.rows.length, 6);
  assert.equal(audit.rows[0].speaker, '阿宁');
  assert.ok(audit.speakers.find(s => s.speaker === '阿宁').lines >= 2);
});

test('台词体检接进连续性体检：只报硬问题，且指到具体哪一段', () => {
  const project = {
    logline: '有梗概',
    genre: '古装武侠',
    bible: { characters: [{ id: 'c1', name: '阿宁', appearance: '黑发', refImage: '/p.png' }] },
    craft: { emotionContract: { line: '不甘', neverDo: [] }, characters: [{ name: '阿宁', desire: 'd', secret: 's', arc: 'a', voicePrint: 'v' }], units: [], episodeMap: [], beats: [], ledger: { setups: [], characters: [], props: [], rules: [] } },
    scenes: [{
      id: 's1', title: '第一场', summary: '摘要',
      beats: [
        { id: 'b1', kind: 'novel', prompt: '开场', dialogue: '阿宁：三年前你杀我师父灭我师门占我武馆今日我陈烬归来倒要看看谁该灭门偿命' },
        { id: 'b2', kind: 'novel', prompt: '继续', dialogue: '老周：走哪儿。', inheritFromBeatId: 'b1' },
      ],
    }],
  };
  const r = lintStoryProject(project, { kind: 'novel' });
  const hit = r.issues.find(i => i.code === 'dialogue-line-too-long');
  assert.ok(hit, '超长句要进体检');
  assert.match(hit.message, /第一场.*第 1 段/);
  assert.equal(r.summary.dialogueIssues, 1);
  assert.equal(r.summary.level, 'warn');
  // 没有深度构思时只给 advisory（不该把总级别染黄）
  const noCraft = lintStoryProject({ ...project, craft: undefined }, { kind: 'novel' });
  assert.ok(noCraft.issues.some(i => i.code === 'no-craft' && i.advisory));
  assert.deepEqual(noCraft.issues.filter(i => i.level === 'warn' && i.code !== 'dialogue-line-too-long'), []);
});

test('构思体检：伏笔没回收集 / 回收集不晚于埋设集 / 单元硬帽过大 / 每集缺钩子 / 然后式并列', () => {
  const engine = {
    emotionContract: { line: '', neverDo: [] },
    characters: [{ name: '阿宁', desire: '找到父亲', secret: '', arc: '', voicePrint: '' }],
    units: [{ no: 1, spine: '找父亲', cap: 60, seam: { ember: '', opponent: '', arc: '' } }],
    episodeMap: [{ no: 1, goal: '登车', coldOpen: '', hook: '' }],
    beats: [
      { no: 1, event: '上车', link: '然后', changes: [] },
      { no: 2, event: '遇阻', link: '然后', changes: [] },
      { no: 3, event: '被救', link: '因此', changes: ['关系'] },
    ],
    ledger: { setups: [{ text: '旧钥匙', setupAt: 1, payoffAt: null }, { text: '车票', setupAt: 5, payoffAt: 3 }], characters: [], props: [], rules: [] },
  };
  const r = auditEngine(engine, { currentEpisode: 2 });
  const codes = r.issues.map(i => i.code);
  assert.ok(codes.includes('no-contract'), '没写情绪契约要报');
  assert.ok(codes.includes('thin-character'), '人物缺秘密/弧光/语言指纹要报');
  assert.ok(codes.includes('setup-unpaid'), '没写回收集的伏笔要报（没写回收集的不许埋）');
  assert.ok(codes.includes('setup-order'), '回收集不晚于埋设集要报');
  assert.ok(codes.includes('no-hook'), '每集必须有断章钩子');
  assert.ok(codes.includes('unit-cap-too-long'), '单元硬帽超 30 集要拦一下');
  assert.ok(codes.includes('then-links'), '"然后"式并列要提示换成因果');
  assert.ok(codes.includes('no-rules'), '规则账空着要说出来');
  assert.equal(r.level, 'warn');
  // 地图覆盖率：真机上要 60 集、模型只给了 3 集，体检当时一声不吭——现在必须报
  const short = auditEngine({ ...engine, episodeMap: [{ no: 1, goal: 'g', coldOpen: 'c', hook: 'h' }] }, { plannedEpisodes: 60 });
  const coverage = short.issues.find(i => i.code === 'map-incomplete');
  assert.ok(coverage, '地图覆盖不全必须报');
  assert.match(coverage.message, /只覆盖 1 集.*计划是 60 集/);
  assert.equal(coverage.level, 'warn');
  // 结构齐备时不该报 warn
  const clean = auditEngine({ ...engine, emotionContract: { line: '不甘' }, units: [{ no: 1, cap: 25, seam: { ember: 'e', opponent: 'o', arc: 'a' } }], episodeMap: [{ no: 1, goal: 'g', coldOpen: 'c', hook: 'h' }], beats: [{ no: 1, event: 'e', link: '因此', changes: ['信息'] }], ledger: { setups: [{ text: '钥匙', setupAt: 1, payoffAt: 8 }], characters: [], props: [], rules: [{ text: '雾里不能发声' }] }, characters: [{ name: '阿宁', desire: 'd', secret: 's', arc: 'a', voicePrint: 'v' }] });
  assert.deepEqual(clean.issues.filter(i => i.level === 'warn'), []);
  assert.equal(clean.level, 'ok');
});

test('台词诊断：提示词要带上机检事实与七维标准，并要求每条 ≥3 条依据', () => {
  const p = buildDialogueDoctorPrompt({
    scene: { title: '夜站台' }, rows: [{ speaker: '阿宁', text: '你为什么不走？' }],
    audit: dialogueAudit({ dialogue: '阿宁：你为什么不走？', budgetSec: 5 }), bible: { characters: [{ name: '阿宁', appearance: '短发' }] }, genre: '古装武侠',
  });
  assert.match(p, /台词专科医生/);
  assert.match(p, /3\.5~5 字\/秒/);
  assert.match(p, /超过 24 字必须拆镜/);
  assert.match(p, /不少于 3 条维度依据/);
  assert.match(p, /机检事实/);
  assert.match(p, /可发音字数/);
  assert.match(p, /古装不许出现现代词/);
});

test('台词诊断解析：宽容 + 依据不足要标出来（只给一句"更自然"等于没诊断）', () => {
  const raw = `好的，我逐句看一下：\n${JSON.stringify({
    summary: '最大的问题是两句都在解释情绪',
    lines: [
      { speaker: '阿宁', original: '我很愤怒，我要杀了你。', rewritten: '茶凉了。换杯热的再上路。', reasons: ['【潜台词】把情绪藏进动作', '【辨识度】符合她惜字的说话习惯', '【节奏】12 字，标准语速 2.5~3.4 秒'], shots: [{ shot: '镜1 · 近景', text: '茶凉了。', chars: 4 }] },
      { speaker: '老周', original: '我明白你的意思。', rewritten: '嗯。', reasons: ['【信息效率】双方已知，不必说'], shots: [] },
    ],
    keep: ['阿宁：走。'],
  })}\n以上。`;
  const r = parseDialogueDoctor(raw, extractJsonObjects);
  assert.equal(r.lines.length, 2);
  assert.equal(r.lines[0].thin, false, '给了 3 条依据就不算薄');
  assert.equal(r.lines[1].thin, true, '只给 1 条依据要标出来');
  assert.equal(r.changed, 2);
  assert.deepEqual(r.keep, ['阿宁：走。']);
  assert.throws(() => parseDialogueDoctor('我不知道怎么写', extractJsonObjects), /找不到 JSON/);
});

test('深度构思解析：包一层也认；空内容不算成功', () => {
  const engine = { emotionContract: { line: '不甘' }, characters: [{ name: '阿宁' }], units: [{ no: 1, spine: '找父亲', cap: 25 }], episodeMap: [{ no: 1, goal: 'g', hook: 'h' }], beats: [], ledger: { setups: [{ text: '钥匙', setupAt: 1, payoffAt: 8 }] } };
  assert.equal(parseStoryEngine(JSON.stringify({ engine }), extractJsonObjects).emotionContract.line, '不甘');
  assert.equal(parseStoryEngine(`先说明一下：${JSON.stringify(engine)}`, extractJsonObjects).units[0].cap, 25);
  assert.throws(() => parseStoryEngine('没有 JSON', extractJsonObjects), /找不到 JSON/);
  assert.throws(() => parseStoryEngine('{}', extractJsonObjects), /没有可用内容/);
  const prompt = buildStoryEnginePrompt({ title: '钥匙', episodes: 60, episodesPerUnit: 25 });
  assert.match(prompt, /情绪契约/);
  assert.match(prompt, /欲望/);
  assert.match(prompt, /语言指纹/);
  assert.match(prompt, /硬帽/);
  assert.match(prompt, /没写回收集的伏笔不许埋/);
  assert.match(prompt, /因此\/但是/);
});
