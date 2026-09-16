// engine/story-lint.mjs —— 连续创作「连续性体检」
//
// 目的：把"这次生成能不能保住人物一致性"的已知条件**提前摊开**给用户，
// 而不是等生成失败、或者看到人物一段一个样才发现。
// 纯函数，不碰磁盘、不调模型，因此可以完整单元测试。
//
// 2026-09-16 扩展：用户说「人物、场景搭上了，对话与深度构思还是不行」。
// 台词那部分最要命的几条**本来就是能算的**（同行也是这么做的：语速 3.5~5 字/秒、
// 单句 >24 字必须拆镜），以前却要花一次模型调用才能从"听起来别扭"里猜出来。
// 现在并进体检：不花钱就能看到"这一句 37 字，最快也要 7.4 秒，而这段只有 5 秒"。
import { dialogueAudit, auditEngine, repeatCheck } from './story-craft.mjs';
import { beatAction } from './story-screenplay.mjs';

const text = value => String(value ?? '').trim();
const list = value => (Array.isArray(value) ? value : []);

// 这一段的时间预算：优先用段落自己写的时长，其次方法的单集时长/场数折算，最后给个保守默认
function budgetOf(beat, project) {
  const own = Number(beat?.params?.seconds);
  if (Number.isFinite(own) && own > 0) return own;
  return null;
}

export function lintStoryProject(project, { kind = 'image', capabilities = null } = {}) {
  const issues = [];
  const add = (level, code, message) => issues.push({ level, code, message });

  const characters = list(project?.bible?.characters);
  const scenes = list(project?.scenes);
  const beats = scenes.flatMap(scene => list(scene?.beats));

  if (!text(project?.logline)) add('info', 'no-logline', '故事还没有梗概：AI 续写容易跑偏');

  if (!characters.length) {
    add('warn', 'no-characters', '还没有角色设定，先补一段设定再谈人物一致性');
  }
  for (const character of characters) {
    const name = text(character?.name) || text(character?.id) || '未命名角色';
    if (!text(character?.appearance) && !text(character?.description)) {
      add('warn', 'character-no-appearance', `角色「${name}」没有外貌描述：不同镜头容易走样`);
    }
    // 形象变体也算定妆照：一个角色有多张形象（基础/战斗装束）时，别再说他"没有定妆照"
    const hasLookImage = Array.isArray(character?.looks) && character.looks.some(l => text(l?.refImage));
    if (!text(character?.refImage) && !text(character?.ref) && !hasLookImage) {
      add('info', 'character-no-portrait', `角色「${name}」还没有定妆照：生成时只能用文字描述`);
    }
    // 身体结构锚点：定妆照是半身像，没有肩宽/头肩比/体型这几个词，模型就自由发挥比例，
    // 最常见的翻车是"窄肩配大脑袋"。只提示、不阻塞——一句话的角色设定也能出图。
    const STRUCT = /(宽肩|窄肩|肩宽|头肩比|肩线|身高|体型|身材|微胖|偏瘦|清瘦|魁梧|壮实|矮小|高挑|娇小|驼背|佝偻|肌肉)/;
    if (text(character?.appearance) && !STRUCT.test(text(character.appearance))) {
      add('info', 'character-no-structure', `角色「${name}」的外貌缺身体结构（肩宽/头肩比/身高体型）：半身像容易出"窄肩配大脑袋"`);
    }
  }

  for (const scene of scenes) {
    const title = text(scene?.title) || text(scene?.id) || '未命名场景';
    if (!text(scene?.summary)) add('info', 'scene-no-summary', `场景「${title}」没有摘要`);
    list(scene?.beats).forEach((beat, index) => {
      if (index > 0 && !text(beat?.inheritFromBeatId)) {
        add('warn', 'beat-not-inherited', `「${title}」第 ${index + 1} 段没有继承前文：续写会缺上下文`);
      }
    });
  }

  if (!beats.length) add('warn', 'no-beats', '还没有任何段落');

  // 只有图像/视频才谈参考图能力；文本段落不需要
  if (kind !== 'novel' && capabilities && capabilities.reference === false) {
    add('warn', 'model-no-reference', '当前模型声明不支持参考资产：定妆照不会被使用，人物一致性只能靠文字');
  }

  const portraits = characters.filter(c => text(c?.refImage) || text(c?.ref)).length;

  // ── 台词体检（不花钱的那部分）──
  // 只对"有话可说的段落"报：没台词的段落不该被扣分。
  let dialogueIssues = 0;
  for (const scene of scenes) {
    const title = text(scene?.title) || text(scene?.id) || '未命名场景';
    for (const [index, beat] of list(scene?.beats).entries()) {
      const dialogue = text(beat?.dialogue);
      if (!dialogue) continue;
      const audit = dialogueAudit({ dialogue, budgetSec: budgetOf(beat, project), genre: text(project?.genre) });
      for (const issue of audit.issues) {
        // 只把 warn 与"说不完/超长"这类硬问题抬进体检；info 级的风格提示留在台词面板里，
        // 免得体检被一堆"可以更好"淹没。
        if (issue.level !== 'warn') continue;
        dialogueIssues += 1;
        add('warn', `dialogue-${issue.code || issue.dim || 'issue'}`, `「${title}」第 ${index + 1} 段台词：${issue.message}${issue.text ? `（原句：${String(issue.text).slice(0, 30)}…）` : ''}`);
      }
    }
  }

  // ── 重复体检（"生成在原地打转"）──
  // 真机对照踩到的：另一家工具自动写的 10 集剧本里第 5 集与第 6 集逐字相同，全剧 26% 的
  // 段落跨集重复，而没有任何环节在报。这里按"场"做单元：场与场之间高度重合，
  // 或者同一段话在多场里逐字出现，就抬进体检。
  const repeatUnits = scenes.map((scene, i) => ({
    no: i + 1,
    title: text(scene?.title) || text(scene?.id) || '',
    text: [text(scene?.summary), ...list(scene?.beats).map(b => `${text(b?.dialogue)}\n${beatAction(b)}`)].filter(Boolean).join('\n'),
  }));
  const repeat = repeatCheck(repeatUnits);
  for (const issue of repeat.issues) add('warn', `repeat-${issue.code}`, issue.message);

  // ── 构思体检（结构性的那几条）──
  const engine = auditEngine(project?.craft, { currentEpisode: list(project?.episodes).length });
  if (!project?.craft) {
    // 标 advisory：缺深度构思是**建议**，不是"不能开拍"。它不该把体检的总级别拉下来——
    // 总级别的含义是"现在能不能生成"，被一堆建议染黄就没人看了。
    issues.push({ level: 'info', code: 'no-craft', advisory: true, message: '还没有深度构思（情绪契约 / 人物四件套 / 分集钩子 / 伏笔账）：写到中段容易松' });
  } else {
    for (const issue of engine.issues) {
      if (issue.level !== 'warn') continue;
      add('warn', `craft-${issue.code}`, `构思：${issue.message}`);
    }
    const unpaid = list(project?.craft?.ledger?.setups).filter(s => !s?.payoffAt).length;
    if (unpaid) issues.push({ level: 'info', code: 'craft-open-setups', advisory: true, message: `${unpaid} 条伏笔还没写回收集` });
  }

  const blocking = issues.filter(i => !i.advisory);
  const level = blocking.some(i => i.level === 'warn') ? 'warn' : blocking.length ? 'info' : 'ok';
  return {
    issues,
    summary: { characters: characters.length, portraits, scenes: scenes.length, beats: beats.length, dialogueIssues, craftLevel: engine.level, level, repeatParagraphs: repeat.stats.duplicatedParagraphs, repeatRatio: repeat.stats.ratio },
  };
}
