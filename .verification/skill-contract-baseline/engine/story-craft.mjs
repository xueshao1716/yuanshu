// engine/story-craft.mjs —— 台词与深度构思这两块"手艺"
//
// 用户的原话是「人物、场景搭上了，对话以及深度构思这些还是不行」。去 GitHub 翻了一圈同行
// 的做法（[manju-laoli-skill](https://github.com/lixiaoxiao9888-create/manju-laoli-skill) 的
// 台词专科七维诊断 / 语速自检，[short-drama-factory](https://github.com/lixiaoxiao9888-create/short-drama-factory)
// 的情绪契约与四账台账，[zenstory-ai/drama-skills](https://github.com/zenstory-ai/drama-skills)
// 的因果节拍与分集地图，[Dramatron](https://github.com/google-deepmind/dramatron) 的分层生成），
// 这几家真正有用的共同点是：**把"手艺"变成能逐条过的规则，并且能机检的先机检**。
//
// 元枢此前的问题不是"没有提示词"，而是：
//   1) 台词被塞在分镜提示词里顺手生成，**没有独立的打磨环节**（Dramatron 相反：台词是单独一层）；
//   2) 没有一把尺子——"这句太长说不完""这句在解释情绪"全靠人肉看；
//   3) 深度构思只有一次改编调用，没有情绪契约、因果节拍、伏笔回收这些可检查的产物。
//
// 这个模块只做两件事，都尽量做成**纯函数**（可测、零成本、不花模型钱）：
//   A. 台词体检：语速/时长/拆镜/七维里能机检的那几维；
//   B. 构思体检：伏笔回收、断章钩子、情绪契约单元划分。
// 模型只负责"改写"和"给方案"，事实与判定尽量由这里给出——否则每次都要花一次调用才能知道
// "这句话说不完"，那是浪费。
import { parseDialogueLines } from './story-screenplay.mjs';

// ── 语速基准（取自 dialogue-speed-check.md 的三档标准）──
// 标准 3.5~5 字/秒；<3.5 慢速重音（金句/遗言/威慑）；>5 快速爆发（争吵/逼问），
// 但快速档**单段连续不得超过 3 秒**（再快听众跟不上，配音也会糊）。
export const SPEECH = { slowMax: 3.5, fastMin: 5, fastBurstMaxSec: 3, lineMax: 24, lineSplitTarget: 18, groupMaxSec: 15 };
const PAUSE = { inner: 0.2, end: 0.45 }; // 句内标点≈0.1~0.3s、句末≈0.3~0.6s，取中值做点估

// 只数**可发音字符**：汉字、字母、数字。标点不计入字速（另按停顿预算处理）——
// 这是那份语速自检里最容易被忽略、但直接影响判断的一条：把标点算进字数会高估时长。
export function speakableChars(text) {
  return (String(text || '').match(/[\u4e00-\u9fa5\u3400-\u4dbfA-Za-z0-9]/g) || []).length;
}
function pauseSec(text) {
  const s = String(text || '');
  const inner = (s.match(/[，、；：,;]/g) || []).length;
  const end = (s.match(/[。！？!?…~—]/g) || []).length;
  return inner * PAUSE.inner + end * PAUSE.end;
}
// 把一段台词拆成小句：按中英文标点断，保留标点用于停顿估算
export function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[。！？!?…；;])|\n/)
    .map(s => s.trim())
    .filter(Boolean);
}

// 单句/整段的语速与时长体检。返回的每一项都能在界面上直接说给用户听。
export function speechCheck(text, { budgetSec = null } = {}) {
  const chars = speakableChars(text);
  const pauses = pauseSec(text);
  const lines = splitSentences(text).map(s => {
    const n = speakableChars(s);
    return { text: s, chars: n, minSec: +(n / SPEECH.fastMin).toFixed(2), maxSec: +(n / SPEECH.slowMax).toFixed(2), pauses: +pauseSec(s).toFixed(2) };
  });
  const minSec = +(chars / SPEECH.fastMin + pauses).toFixed(2);
  const maxSec = +(chars / SPEECH.slowMax + pauses).toFixed(2);
  const longest = lines.reduce((a, b) => (b.chars > (a?.chars || 0) ? b : a), null);
  const issues = [];
  if (!chars) return { chars: 0, lines, minSec: 0, maxSec: 0, pauses: 0, longest: null, issues, level: 'ok' };
  // 超长句：>24 字强制拆镜（每条 ≤18 字）
  for (const l of lines) {
    if (l.chars > SPEECH.lineMax) {
      issues.push({ code: 'line-too-long', level: 'warn', text: l.text, chars: l.chars, message: `这一句 ${l.chars} 字，超过 ${SPEECH.lineMax} 字上限，建议拆成 ${Math.ceil(l.chars / SPEECH.lineSplitTarget)} 个镜头（每镜 ≤${SPEECH.lineSplitTarget} 字）` });
    } else if (l.chars > SPEECH.lineSplitTarget) {
      issues.push({ code: 'line-near-limit', level: 'info', text: l.text, chars: l.chars, message: `这一句 ${l.chars} 字，已接近上限（建议 ≤${SPEECH.lineSplitTarget} 字）` });
    }
  }
  // 整体说不完：超过这一段的时间预算
  if (budgetSec && minSec > budgetSec) {
    issues.push({ code: 'over-budget', level: 'warn', chars, budgetSec, message: `按 5 字/秒最快也要 ${minSec} 秒，而这一段只有 ${budgetSec} 秒——要么删句，要么把这句分到下一段` });
  }
  // 快档连续超时：>5 字/秒的连续段不得超过 3 秒
  const fastRun = lines.find(l => l.chars / SPEECH.fastMin > SPEECH.fastBurstMaxSec);
  if (fastRun && fastRun.chars > SPEECH.fastMin * SPEECH.fastBurstMaxSec) {
    issues.push({ code: 'fast-burst', level: 'info', text: fastRun.text, chars: fastRun.chars, message: `连续快语超过 ${SPEECH.fastBurstMaxSec} 秒（${fastRun.chars} 字），配音会和情绪一起糊掉，中间要有气口` });
  }
  // 缺短句：整段没有 ≤10 字的句子 → 没有气口，也没有能记住的那一句
  const hasBeat = lines.some(l => l.chars > 0 && l.chars <= 10);
  if (lines.length >= 3 && !hasBeat) {
    issues.push({ code: 'no-beat-line', level: 'info', message: '整段没有一句短句（≤10 字）：既没有气口，也留不下能记住的那一句' });
  }
  const level = issues.some(i => i.level === 'warn') ? 'warn' : issues.length ? 'info' : 'ok';
  return { chars, lines, minSec, maxSec, pauses: +pauses.toFixed(2), longest, issues, level };
}

// ── 七维里**能机检**的那几维 ──
// 老实说清楚：这里全是**启发式**，会误报。它的价值是"把明显的问题先揪出来"，
// 而不是替人下判断——所以每条都带命中的原文，人能一眼看出对不对。
const EXPLAIN_MOOD = /(我很|我好|我真|我非常|我特别|十分|非常)(愤怒|生气|难过|伤心|开心|高兴|害怕|恐惧|紧张|失望|绝望|痛苦)/;
const SELF_INTRO = /^(我是|我叫|我就是|我可是)[^，。！？]{0,12}(的|人|师兄|师姐|徒弟|儿子|女儿|老板|董事长|总裁|少爷|小姐)/;
const FILLER = /^(你好|您好|谢谢|多谢|知道了|明白|嗯|哦|好吧|好的|再见|打扰了)[。！？!?]?$/;
const MODERN_WORDS = /(逻辑|经济|项目|数据|系统|流程|效率|心理|概率|成本|预算|团队|方案|机制|指标|沟通|情绪价值)/;

export function dialogueAudit({ dialogue = '', budgetSec = null, genre = '' } = {}) {
  const rows = parseDialogueLines(dialogue).filter(r => r.type === 'dialogue' && r.text);
  const speech = speechCheck(rows.map(r => r.text).join(''), { budgetSec });
  const issues = [];
  const bySpeaker = new Map();
  for (const row of rows) {
    const n = speakableChars(row.text);
    const cur = bySpeaker.get(row.speaker) || { speaker: row.speaker, lines: 0, chars: 0, longest: 0 };
    cur.lines += 1; cur.chars += n; cur.longest = Math.max(cur.longest, n);
    bySpeaker.set(row.speaker, cur);
    if (EXPLAIN_MOOD.test(row.text)) issues.push({ dim: '潜台词', level: 'warn', speaker: row.speaker, text: row.text, message: '把情绪直接说了出来（0 层直白）。情绪写在动作和潜台词里更狠' });
    if (SELF_INTRO.test(row.text)) issues.push({ dim: '信息效率', level: 'warn', speaker: row.speaker, text: row.text, message: '像在向观众自报家门（反向灌输设定）。双方已知的身份不该靠台词交代' });
    if (FILLER.test(row.text)) issues.push({ dim: '冲突推进力', level: 'info', speaker: row.speaker, text: row.text, message: '寒暄/附和这类句子不改变任何东西，删掉通常更好' });
    if (genre && /古装|武侠|古风|仙侠/.test(genre) && MODERN_WORDS.test(row.text)) {
      const hit = row.text.match(MODERN_WORDS)?.[0];
      issues.push({ dim: '类型语感', level: 'warn', speaker: row.speaker, text: row.text, message: `古装题材里出现现代词「${hit}」，出戏` });
    }
  }
  // 辨识度：两个以上说话人、且平均句长几乎一样 → 语言指纹不清（启发式，会误报）
  const cast = [...bySpeaker.values()].filter(c => c.lines >= 2);
  if (cast.length >= 2) {
    const avgs = cast.map(c => c.chars / c.lines);
    const spread = Math.max(...avgs) - Math.min(...avgs);
    if (spread < 2) issues.push({ dim: '辨识度', level: 'info', message: `${cast.map(c => c.speaker).join('、')} 的平均句长几乎一样（差 ${spread.toFixed(1)} 字）：去掉名字可能分不清谁在说。给每人一个说话习惯（长短句/口头禅/用词）` });
  }
  for (const i of speech.issues) issues.push({ dim: '节奏', level: i.level, text: i.text || '', message: i.message, code: i.code });
  const dims = ['辨识度', '潜台词', '冲突推进力', '类型语感', '信息效率', '节奏', '金句潜力'];
  const hitDims = [...new Set(issues.map(i => i.dim))];
  // 哪几维**机检查不了**：「金句潜力」是纯主观判断（没法用规则判"这句够不够狠"）；
  // 其余几维都有启发式规则，但只覆盖**明显**的病灶（比如潜台词只抓得到 0 层直白）。
  // 老实标出来，别让用户以为机检过了就等于台词好。
  const MACHINE_DIMS = ['辨识度', '潜台词', '冲突推进力', '类型语感', '信息效率', '节奏'];
  return {
    rows: rows.map(r => ({ speaker: r.speaker, paren: r.paren, text: r.text, chars: speakableChars(r.text) })),
    speakers: [...bySpeaker.values()],
    speech,
    issues,
    dims,
    hitDims,
    humanDims: dims.filter(d => !MACHINE_DIMS.includes(d)),
    level: issues.some(i => i.level === 'warn') ? 'warn' : issues.length ? 'info' : 'ok',
  };
}

// ── 台词诊断与重构（这一步要模型：机检挑出问题，模型给改写）──
// 输出契约照 dialogue-doctor-7d：原台词 / 改写建议 / **不少于 3 条维度依据**。
// 我们把机检结果一并喂进去，逼模型针对**真问题**改，而不是自由发挥一遍。
export function buildDialogueDoctorPrompt({ scene = {}, rows = [], audit = null, bible = {}, genre = '', method = null } = {}) {
  const cast = (bible.characters || []).map(c => `${c.name || ''}${c.appearance ? `（${String(c.appearance).slice(0, 40)}）` : ''}`).filter(Boolean).join('、');
  const facts = audit ? [
    `可发音字数 ${audit.speech.chars}`,
    `按 3.5~5 字/秒需要 ${audit.speech.minSec}~${audit.speech.maxSec} 秒`,
    audit.speech.longest?.chars ? `最长一句 ${audit.speech.longest.chars} 字` : '',
    audit.issues.filter(i => i.level === 'warn').length ? `机检已发现 ${audit.issues.filter(i => i.level === 'warn').length} 处硬问题` : '',
  ].filter(Boolean).join('；') : '';
  return `你是元枢连续创作的**台词专科医生**。下面是一场戏的台词。请逐句诊断并重构，目标是
“没有全员播音腔、不直白解释、不反向灌输设定、不出现机器翻译味”。

场景：${scene.title || '未命名'}${scene.summary ? `（${String(scene.summary).slice(0, 80)}）` : ''}
题材：${genre || '未指定'}
本场人物：${cast || '（设定里还没登记人物）'}
${method ? `本片方法：${method}` : ''}
${facts ? `机检事实（不用你重复算，按它来判）：${facts}` : ''}

## 台词原文
${rows.map((r, i) => `${i + 1}. ${r.speaker}${r.paren ? `（${r.paren}）` : ''}：${r.text}`).join('\n')}

## 七维诊断标准
1. **辨识度**：每人要有语言指纹（粗人糙话短句、书生引典留白、杀手惜字如金）。全员一个腔调 = 病。
2. **潜台词**：把"我很愤怒，我要杀了你"这种 0 层直白改成 1~3 层（"茶凉了，换杯热的再上路吧"）。
3. **冲突推进力**：每句必须产生信息/立场/情绪/行动上的变动；寒暄、附和、重复 = 删。
4. **类型语感**：古装不许出现现代词，市井要接地气。
5. **信息效率**：双方已知的信息一律不写进台词，转成动作或微表情；禁止自报家门式交代。
6. **节奏**：单句 6~18 字为主，长短交错；**超过 24 字必须拆镜**（每镜 ≤18 字）；
   3.5~5 字/秒是标准档，金句/威慑可慢到 <3.5，争吵可快到 >5 但连续不超过 3 秒。
7. **金句潜力**：整场至少留一句能截图传播的（反常识、极度反差、或一句顶一段）。

## 要求
- 只改**台词**，不要动剧情事实、人物关系与已经确定的信息。
- 有拆分建议时，写清拆成几个镜头、每镜说什么（照上面的字数标准）。
- 改不动或本来就好的句子，就照原样给出并说明"为什么不动"。
- 每条都必须给出**不少于 3 条维度依据**，标明是哪一维。

只返回 JSON，不要 Markdown：
{"summary":"这一场台词的整体判断（两三句，点出最要紧的那个毛病）","lines":[{"speaker":"","original":"","rewritten":"","reasons":["【维度】依据","【维度】依据","【维度】依据"],"shots":[{"shot":"镜1 · 近景","text":"","chars":0}]}],"keep":["哪些句子保持原样、为什么"]}`;
}

const str = v => (v == null ? '' : String(v).trim());
const list = v => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);

// 宽容解析：与分镜/改编/智能填充同一套路数（围栏、前后解释、包一层都认）。
export function parseDialogueDoctor(raw, extractJsonObjects) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const candidates = [];
  try { candidates.push(JSON.parse(text)); } catch { /* 落到抠对象 */ }
  if (typeof extractJsonObjects === 'function') candidates.push(...extractJsonObjects(text));
  if (!candidates.length) throw new Error(`台词诊断返回的内容里找不到 JSON（开头：${text.slice(0, 100) || '(空)'}）`);
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const root = candidate.diagnosis || candidate.data || candidate.result || candidate;
    const lines = list(root.lines).map(l => ({
      speaker: str(l?.speaker),
      original: str(l?.original),
      rewritten: str(l?.rewritten),
      reasons: list(l?.reasons).map(str).filter(Boolean).slice(0, 8),
      shots: list(l?.shots).map(s => ({ shot: str(s?.shot), text: str(s?.text), chars: Number(s?.chars) || speakableChars(s?.text) })).filter(s => s.text),
      // 依据不足的条目要标出来：那份规则要求"不少于 3 条维度依据"，
      // 模型只给一句"更自然"就等于没诊断——界面要能看出这一点。
      thin: list(l?.reasons).map(str).filter(Boolean).length < 3,
    })).filter(l => l.original || l.rewritten);
    if (lines.length) return { summary: str(root.summary), lines, keep: list(root.keep).map(str).filter(Boolean), changed: lines.filter(l => l.rewritten && l.rewritten !== l.original).length };
  }
  throw new Error(`台词诊断的 JSON 里没有可用的逐句结果（原文开头：${text.slice(0, 120)}）`);
}

// ── 深度构思：情绪契约 + 单元 + 因果节拍 + 四账台账 ──
// 参考 short-drama-factory 的两条教训：
//   1) 全剧不变的是**情绪契约**（那口气），矛盾只是单元载具——一条矛盾硬拉 80 集必废；
//      单条矛盾要有硬帽（20~30 集）必须闭环，换单元时用"三缝合一"接上；
//   2) **无台账不开写**：伏笔/人物/道具/规则四账，机检伏笔超期、断章缺失。
export function buildStoryEnginePrompt({ title = '', logline = '', idea = '', bible = {}, episodes = 0, genre = '', episodesPerUnit = 25 } = {}) {
  const cast = (bible.characters || []).map(c => c.name).filter(Boolean).join('、');
  return `你是元枢连续创作的**总编剧**。请为下面这个故事做"深度构思"——不是再写一遍梗概，
而是把**那口气**、**人物**、**矛盾单元**、**分集钩子**、**伏笔账**定下来，让后面每一集都照着长。

项目：${String(title).trim() || '未命名'}
梗概：${String(logline).trim() || '暂无'}
已有想法：${String(idea).trim() || '（无，请自己立一个能撑住的）'}
已有的人物：${cast || '（还没登记）'}
${genre ? `题材：${genre}` : ''}
计划集数：${episodes || '未定'}（每 ${episodesPerUnit} 集左右为一个矛盾单元）

## 要求
1. **情绪契约**：全剧从头到尾不变的是哪一口气（观众要看的是什么爽/什么痛/什么不甘）。
   写清它，并说明什么事**违背**它（不能做的）。
2. **人物圣经**：每个主要人物四件套——**欲望**（他要什么）、**秘密**（别人不知道什么）、
   **弧光**（从什么变成什么）、**语言指纹**（他说话什么样：长短句、口头禅、用词习惯）。
   再标功能位（主角/对手/镜像/催化/代价）。
3. **矛盾按单元跑**：把全剧拆成若干单元，每个单元一条矛盾，写清：这一单元的矛盾、
   单元内回合表（几集一个回合）、**硬帽集数**（约 ${episodesPerUnit} 集必须闭环）、
   以及**接缝**——旧单元收尾时留下的火种、对手换了哪一层、人物的弧光升到哪一步。
   一条矛盾烧满全剧是最常见的废稿原因，不要那样写。
4. **分集地图**：每集写 目标（这一集要完成什么）+ **前 3 秒的冲突** + **断章钩子**（结尾停在什么悬念上）。
   钩子要具体到"停在哪句话/哪个动作"，不要写"留下悬念"。
5. **因果节拍**：事件之间用"因此/但是"连接，不要用"然后"并列。
   每个节拍都要说明它改变了什么（信息/权力/关系/情绪/物理状态/风险 里的哪一项）。
6. **四账台账**：伏笔、人物、道具、规则各一账。
   伏笔账要写 埋在第几集 + **计划第几集回收**（没写回收集的伏笔不许埋）。
   规则账写这个世界/这个故事不许破的规则（破一次，观众就再也不信了）。

只返回 JSON，不要 Markdown：
{"emotionContract":{"line":"","neverDo":["违背这口气的事"]},"characters":[{"name":"","slot":"主角/对手/镜像/催化/代价","desire":"","secret":"","arc":"","voicePrint":""}],"units":[{"no":1,"spine":"这一单元的矛盾","episodes":"1-25","rounds":"几集一个回合","cap":25,"seam":{"ember":"旧单元的残渣留下什么火种","opponent":"对手换了哪一层","arc":"弧光升到哪一步"}}],"episodeMap":[{"no":1,"goal":"","coldOpen":"前 3 秒的冲突","hook":"结尾停在什么悬念上"}],"beats":[{"no":1,"event":"","link":"因此/但是","changes":["信息/权力/关系/情绪/物理/风险 之一"]}],"ledger":{"setups":[{"text":"","setupAt":1,"payoffAt":8,"note":""}],"characters":[{"text":"","at":1}],"props":[{"text":"","at":1}],"rules":[{"text":""}]}}`;
}

export function parseStoryEngine(raw, extractJsonObjects) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const candidates = [];
  try { candidates.push(JSON.parse(text)); } catch { /* 落到抠对象 */ }
  if (typeof extractJsonObjects === 'function') candidates.push(...extractJsonObjects(text));
  if (!candidates.length) throw new Error(`深度构思返回的内容里找不到 JSON（开头：${text.slice(0, 100) || '(空)'}）`);
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const root = candidate.engine || candidate.story || candidate.data || candidate.result || candidate;
    const contract = root.emotionContract || {};
    const lineup = list(root.characters).map(c => ({
      name: str(c?.name), slot: str(c?.slot), desire: str(c?.desire), secret: str(c?.secret), arc: str(c?.arc), voicePrint: str(c?.voicePrint),
    })).filter(c => c.name);
    const units = list(root.units).map((u, i) => ({
      no: Number(u?.no) || i + 1, spine: str(u?.spine), episodes: str(u?.episodes), rounds: str(u?.rounds),
      cap: Number(u?.cap) || null,
      seam: { ember: str(u?.seam?.ember), opponent: str(u?.seam?.opponent), arc: str(u?.seam?.arc) },
    }));
    const episodeMap = list(root.episodeMap).map((e, i) => ({ no: Number(e?.no) || i + 1, goal: str(e?.goal), coldOpen: str(e?.coldOpen), hook: str(e?.hook) }));
    const beats = list(root.beats).map((b, i) => ({ no: Number(b?.no) || i + 1, event: str(b?.event), link: str(b?.link), changes: list(b?.changes).map(str).filter(Boolean) }));
    const ledger = {
      setups: list(root.ledger?.setups).map(s => ({ text: str(s?.text), setupAt: Number(s?.setupAt) || null, payoffAt: Number(s?.payoffAt) || null, note: str(s?.note) })).filter(s => s.text),
      characters: list(root.ledger?.characters).map(s => ({ text: str(s?.text), at: Number(s?.at) || null })).filter(s => s.text),
      props: list(root.ledger?.props).map(s => ({ text: str(s?.text), at: Number(s?.at) || null })).filter(s => s.text),
      rules: list(root.ledger?.rules).map(s => ({ text: str(s?.text) })).filter(s => s.text),
    };
    const hasContent = Boolean(str(contract.line) || lineup.length || units.length || episodeMap.length || beats.length || ledger.setups.length);
    if (!hasContent) continue;
    return {
      emotionContract: { line: str(contract.line), neverDo: list(contract.neverDo).map(str).filter(Boolean) },
      characters: lineup, units, episodeMap, beats, ledger,
    };
  }
  throw new Error(`深度构思的 JSON 里没有可用内容（原文开头：${text.slice(0, 120)}）`);
}

// ── 构思体检（机检，零成本）──
// 这几条是同行机检清单里最要命、且真的能自动判的：
//   · 伏笔没写回收集 → 埋了不收（观众会记住你欠他的）
//   · 伏笔超期 → 说好第 8 集回收，写到第 20 集还没动静
//   · 断章缺失 → 某一集没写钩子
//   · 情绪契约空缺 / 单元硬帽过大 → 一条矛盾想烧满全剧
export function auditEngine(engine, { currentEpisode = 0, plannedEpisodes = 0 } = {}) {
  const issues = [];
  if (!engine) return { issues: [{ code: 'no-engine', level: 'warn', message: '还没有深度构思：先定情绪契约、人物四件套与分集钩子，再往下写' }], level: 'warn' };
  if (!engine.emotionContract?.line) issues.push({ code: 'no-contract', level: 'warn', message: '没写情绪契约（全剧不变的那口气）。没有它，写到中段就会开始"为反转而反转"' });
  // 地图覆盖率：真机上就踩到了——要 60 集，模型只给了 3 集就收工，而当时体检一声不吭。
  // "少给了"必须说出来，否则用户以为 60 集都规划好了。
  if (plannedEpisodes && (engine.episodeMap || []).length && engine.episodeMap.length < plannedEpisodes) {
    issues.push({ code: 'map-incomplete', level: 'warn', message: `分集地图只覆盖 ${engine.episodeMap.length} 集，而计划是 ${plannedEpisodes} 集——缺的 ${plannedEpisodes - engine.episodeMap.length} 集再要一次（模型一次给不全很常见）` });
  }
  // 规则账是空的：这个世界不许破的规则没写下来，后面"破一次观众就再也不信"
  if (!(engine.ledger?.rules || []).length) {
    issues.push({ code: 'no-rules', level: 'info', message: '规则账是空的：这个故事/这个世界不许破的规则（比如"雾里不能发声"）没写下来' });
  }
  for (const c of engine.characters || []) {
    const missing = ['desire', 'secret', 'arc', 'voicePrint'].filter(k => !c[k]);
    if (missing.length) issues.push({ code: 'thin-character', level: 'info', name: c.name, message: `「${c.name}」还缺 ${missing.map(k => ({ desire: '欲望', secret: '秘密', arc: '弧光', voicePrint: '语言指纹' })[k]).join('、')}` });
  }
  for (const s of engine.ledger?.setups || []) {
    if (!s.payoffAt) issues.push({ code: 'setup-unpaid', level: 'warn', text: s.text, message: `伏笔「${s.text}」埋在第 ${s.setupAt ?? '?'} 集，但没写回收集——**没写回收集的伏笔不许埋**` });
    else if (currentEpisode && s.payoffAt < currentEpisode) issues.push({ code: 'setup-overdue', level: 'info', text: s.text, message: `伏笔「${s.text}」说好第 ${s.payoffAt} 集回收，现在已经写到第 ${currentEpisode} 集` });
    else if (s.setupAt && s.payoffAt <= s.setupAt) issues.push({ code: 'setup-order', level: 'warn', text: s.text, message: `伏笔「${s.text}」的回收集（${s.payoffAt}）不晚于埋设集（${s.setupAt}）——那就不叫伏笔了` });
  }
  for (const e of engine.episodeMap || []) {
    if (!e.hook) issues.push({ code: 'no-hook', level: 'warn', episode: e.no, message: `第 ${e.no} 集没写断章钩子：短剧每一集都要停在悬念上` });
    if (!e.coldOpen) issues.push({ code: 'no-coldopen', level: 'info', episode: e.no, message: `第 ${e.no} 集没写前 3 秒的冲突` });
  }
  for (const u of engine.units || []) {
    if (u.cap && u.cap > 30) issues.push({ code: 'unit-cap-too-long', level: 'warn', unit: u.no, message: `第 ${u.no} 单元硬帽 ${u.cap} 集：单条矛盾超过 30 集基本会废（同行经验值 20~30 集），要么拆单元要么换矛盾` });
    if (!u.seam?.ember && (engine.units || []).length > 1 && u.no !== (engine.units || []).length) issues.push({ code: 'no-seam', level: 'info', unit: u.no, message: `第 ${u.no} 单元没写接缝火种：换矛盾时容易"断气"` });
  }
  const thenLinks = (engine.beats || []).filter(b => /然后|接着|之后/.test(b.link || '')).length;
  if (thenLinks && thenLinks >= Math.max(2, Math.ceil((engine.beats || []).length / 3))) {
    issues.push({ code: 'then-links', level: 'info', message: `${thenLinks} 个节拍用"然后"连接：那是并列不是因果。换成"因此/但是"，故事才有推力` });
  }
  const level = issues.some(i => i.level === 'warn') ? 'warn' : issues.length ? 'info' : 'ok';
  return { issues, level };
}

// ── 重复检测（"生成在原地打转"）──
// 2026-09-15 来自一次真机对照：另一家的工具（Pavo）自动写出的 10 集剧本里，
// **第 5 集与第 6 集逐字相同**（5-gram 重合度 100%），全剧 26% 的正文段落跨集重复。
// 这不是文笔问题，是长文本生成卡住之后的**退化**——而且它完全不用模型就能发现，
// 却没有任何一个环节在报：用户要读到第 5 集才知道自己被喂了重复内容。
// 所以这里把它做成可算的一条：单元（集/场）之间的重合度 + 跨单元重复的段落。
const normText = s => String(s || '').replace(/[\s，。！？、；：""''（）()【】\[\]「」『』△▲○●◇◆·…—\-—-]/g, '');
function grams5(text) {
  const set = new Set();
  for (let i = 0; i + 5 <= text.length; i++) set.add(text.slice(i, i + 5));
  return set;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter += 1;
  return inter / (a.size + b.size - inter);
}
const unitLabel = u => (u.title ? `第 ${u.no} 集「${u.title}」` : `第 ${u.no} 段`);

// units: [{ no, title, text }] —— 集也好、场也好、段落也好，只要是"应该各自推进"的单元。
export function repeatCheck(units = [], { unitOverlap = 0.5, paraMinChars = 12 } = {}) {
  const list = (Array.isArray(units) ? units : [])
    .map((u, i) => ({ no: u?.no ?? i + 1, title: String(u?.title || '').trim(), text: String(u?.text || '') }))
    .filter(u => normText(u.text).length >= paraMinChars);
  const issues = [];
  const gs = list.map(u => grams5(normText(u.text)));
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const overlap = jaccard(gs[i], gs[j]);
      if (overlap < unitOverlap) continue;
      issues.push({
        code: 'repeat-unit', level: 'warn', a: list[i].no, b: list[j].no, overlap: +(overlap * 100).toFixed(1),
        message: `${unitLabel(list[i])} 与 ${unitLabel(list[j])} 有 ${(overlap * 100).toFixed(1)}% 逐字重合：正文在重复，不是"呼应"——观众会直接看出你在原地打转`,
      });
    }
  }
  // 段落级：同一段话（去标点后逐字相同）出现在多个单元里。完全匹配才算，避免误报。
  const buckets = new Map();
  let paragraphTotal = 0;
  for (const u of list) {
    const seenInUnit = new Set();
    for (const raw of u.text.split(/\n+/)) {
      const para = String(raw).trim();
      if (normText(para).length < paraMinChars) continue;
      paragraphTotal += 1;
      const key = normText(para);
      if (seenInUnit.has(key)) continue; // 同一单元内重复也记，但只用一次做桶
      seenInUnit.add(key);
      const bucket = buckets.get(key) || { text: para, units: [] };
      bucket.units.push(u.no);
      buckets.set(key, bucket);
    }
  }
  const dupParas = [...buckets.values()].filter(b => b.units.length >= 2);
  const duplicatedOccurrences = dupParas.reduce((n, b) => n + b.units.length, 0);
  if (dupParas.length) {
    const ratio = paragraphTotal ? duplicatedOccurrences / paragraphTotal : 0;
    const worst = [...dupParas].sort((a, b) => b.units.length - a.units.length)[0];
    issues.push({
      code: 'repeat-paragraph', level: 'warn',
      count: dupParas.length, occurrences: duplicatedOccurrences,
      message: `${dupParas.length} 段正文在多个单元里逐字重复（共 ${duplicatedOccurrences} 处，占全部段落的 ${(ratio * 100).toFixed(0)}%）。`
        + `最严重的一段出现在第 ${worst.units.join('、')} ——多是长文生成卡住后的退化，删掉重复段、把信息往前推一步。`,
    });
  }
  const level = issues.some(i => i.level === 'warn') ? 'warn' : issues.length ? 'info' : 'ok';
  return { issues, level, stats: { units: list.length, paragraphs: paragraphTotal, duplicatedParagraphs: dupParas.length, duplicatedOccurrences, ratio: paragraphTotal ? +(duplicatedOccurrences / paragraphTotal).toFixed(3) : 0 } };
}

// 台词七维里"机检不了"的两维，以及构思体检的说明——写在这里，界面直接引用，
// 免得两处各写一份说法。
export const CRAFT_NOTES = {
  dialogueHeuristics: '机检是启发式，会误报：它只负责把明显的问题（太长、在解释情绪、自报家门、古装出现代词）先揪出来，最终判断仍在你。',
  subjective: '「潜台词够不够深」「金句够不够狠」这两件事没有机器判据，只能人看——不要把机检通过当成台词好。',
  engine: '深度构思的机检只查结构（伏笔有没有回收集、每集有没有钩子、单元矛盾有没有硬帽），查不了"好不好看"。',
  repeat: '重复检测是逐字比对（去标点后 5-gram 重合 / 段落完全相同）：它只说"这两处像到不正常"，不会替你判断这是刻意的呼应还是生成退化。',
};
