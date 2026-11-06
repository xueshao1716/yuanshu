// engine/story-methods.mjs —— 创作方法包（Skill：程序性知识）
//
// 研究 Lovart（lovart.ai）时最值得抄的一条，不是"它接了多少模型"，而是**方法包**：
// 一个 Skill 封装的不是一种视觉效果，而是"完成一个创作任务的整套方法"——
// 任务怎么拆、按什么顺序执行、遵循什么专业标准、修改时从哪一步入手、交付物要满足什么要求。
// 官方口径约 100 个预置方法包，并且**用户自己跑通的一次过程也能一键存成个人 Skill**，
// 下次做同类内容直接调用同一套方法。他们把这叫"垂直 Agent 的竞争从'谁接了最强的模型'
// 走向'谁积累了最多专业工作方法'"。
//
// 元枢此前的"配方"（story-recipes）只存**工艺参数**：类型/模型/尺寸/负向/seed/参考图策略。
// 而"一集多长、每集几场、每场几段、前 3 秒要不要出冲突、每集结尾要不要留钩子"——
// 这些是方法，不是参数，此前没有任何落点，每次都得在提示词里重新交代一遍，
// 于是同一部戏的第一集和第五集往往不是一个打法。
//
// 边界：方法包**只给建议与约束**，不偷偷改用户的工艺选择；套用它只写"目标"这类
// 结构性字段（每集时长），以及一个会被提示词读到的方法段。真正的花费参数仍由配方决定。
import fs from 'node:fs/promises';
import path from 'node:path';

export const METHOD_MAX = 60;
const makeId = () => `mth-${Math.random().toString(36).slice(2, 10)}`;
const fileOf = root => path.join(root, 'story-methods.json');

// 预置方法包。刻意只放"元枢真的能执行"的方法：
// 每一条的 steps 都能对应到界面上真的有的动作（一键分镜 / 分集 / 批量 / 剧本导出 / 试戏），
// checklist 是交付前真的能逐条看的项。写一堆做不到的漂亮步骤，等于把方法包变成文案。
export const BUILTIN_METHODS = [
  {
    id: 'builtin-short-drama-vertical',
    name: '竖屏短剧（90 秒一集）',
    goal: '一集 90 秒的竖屏短剧：开头 3 秒出冲突，每集结尾留钩子，集与集接得上。',
    targetSeconds: 90,
    scenesPerEpisode: 6,
    beatsPerScene: 3,
    reasoning: 'fast',
    styleHint: 'short-drama-hook',
    reference: { images: 4, prefer: 'portrait' },
    steps: [
      { title: '定人物与关系', detail: '先把主要人物的外貌写清，生成定妆照——竖屏全是近景，脸不一致一眼就穿。' },
      { title: '分集', detail: '按 90 秒一集规划集数，每集写清"这一集讲什么、钩子在哪"。' },
      { title: '一键分镜', detail: '每集先出一场，再逐集推进；每场 2–3 段，别把一集写成一场长戏。' },
      { title: '批量出片', detail: '按集批量生成，出片后逐段核对人物与场景是否漂移。' },
      { title: '过剧本', detail: '导出中文剧本，通读一遍台词是不是"人话"。' },
    ],
    rules: [
      '前 3 秒必须出冲突或反常，不要用环境空镜开场。',
      '台词直给、短句，不用旁白解释情绪。',
      '每集最后一段留悬念：一个未解答的问题或一个刚出现的意外。',
      '竖屏构图：人物近景为主，信息一眼可读，别放远景大全景。',
      // 台词按"能不能念出来"写：这是同行用一千多个项目换来的经验值，
      // 也是"对话不行"最常见的病根（写出来漂亮，念出来 8 秒的台词塞进 5 秒的镜头）。
      '台词按 3.5~5 字/秒算：单句以 6~18 字为主，**超过 24 字必须拆镜**（每镜 ≤18 字）。',
      '情绪写进动作和潜台词，不要让人物说"我很生气"这种话；双方已知的信息不要写进台词。',
      '每集至少留一句能截图的（反常识、极度反差，或一句顶一段）；金句后面留半秒反应镜头。',
    ],
    checklist: ['这一集结尾有钩子吗', '有没有旁白在解释情绪', '同一角色在不同段落脸是否一致', '开场 3 秒有没有冲突'],
    deliverables: ['分集大纲', '中文剧本', '每集分镜图', '每集视频片段'],
  },
  {
    id: 'builtin-novel-to-90s',
    name: '小说改编成短剧',
    goal: '把小说原文压缩改编成可拍的短剧：保留主线与关键转折，不新增原著没有的人与事。',
    targetSeconds: 90,
    scenesPerEpisode: 6,
    beatsPerScene: 3,
    reasoning: 'thinking',
    styleHint: 'cinematic-real',
    reference: { images: 4, prefer: 'portrait' },
    steps: [
      { title: '导入原著', detail: '按章导入原文，先看"会占多少字"——超 6 万字会被截断，剩下的章要分批改。' },
      { title: '出总览与关系', detail: '先确认 logline 与人物关系，关系错后面全错。' },
      { title: '核对分集大纲', detail: '逐集看梗概与钩子，不满意的集先改大纲再往下走。' },
      { title: '生成分集剧本', detail: '段落类型交给改编判断：内心戏走文字、场面走出图、动作走出片。' },
      { title: '一致性收口', detail: '给主要角色出定妆照，再按集批量生成。' },
    ],
    rules: [
      '保留原著主线与关键转折，可以合并、压缩、改写，但不凭空新增人物与事件。',
      '每一集都要有自己的小高潮，不能只是"过场"。',
      '原文里的大段心理描写要转成动作或台词，不要直接搬成旁白。',
      '台词要能念出来：按 3.5~5 字/秒算时长，单句超过 24 字就拆镜，别让一句台词塞不进一个镜头。',
      '事件之间用「因此/但是」接上，不要用「然后」并列——那是流水账，不是故事。',
    ],
    checklist: ['有没有原著里不存在的人物', '原著的关键转折都还在吗', '心理描写是否转成了可拍的动作'],
    deliverables: ['总览与人物关系', '分集大纲', '分集剧本', '定妆照'],
  },
  {
    id: 'builtin-brand-film',
    name: '品牌短片（30 秒）',
    goal: '30 秒品牌短片：产品/品牌锚点全程不变形，情绪克制，结尾落到品牌。',
    targetSeconds: 30,
    scenesPerEpisode: 3,
    beatsPerScene: 2,
    reasoning: 'fast',
    styleHint: 'cinematic-real',
    reference: { images: 2, prefer: 'material' },
    steps: [
      { title: '锁锚点', detail: '把产品实拍图/logo 作为素材挂上——它们是"不能改变的元素"，不是风格参考。' },
      { title: '定调性', detail: '选一套画风预设，全片沿用；品牌短片最怕一段一个调。' },
      { title: '三段式', detail: '一个问题 + 一个转折 + 一个落点，总共 30 秒，别塞第四个信息。' },
      { title: '出片核对', detail: '逐段核对产品外观有没有被模型"重新设计"。' },
    ],
    rules: [
      '产品外观与 logo 必须与参考素材一致，不许让模型自由发挥。',
      '不用夸张特效，光线与材质优先。',
      '结尾落到品牌或产品本身，不要停在空镜。',
    ],
    checklist: ['产品外观和实拍一致吗', '整片是不是同一套调子', '结尾有没有落到品牌'],
    deliverables: ['分镜图', '30 秒成片'],
  },
  {
    id: 'builtin-doc-short',
    name: '纪实短片（3 分钟）',
    goal: '3 分钟纪实短片：平视、不煽情，让被拍的人自己说话。',
    targetSeconds: 180,
    scenesPerEpisode: 8,
    beatsPerScene: 3,
    reasoning: 'thinking',
    styleHint: 'documentary',
    reference: { images: 1, prefer: 'material' },
    steps: [
      { title: '找人物', detail: '先定一两个具体的人，不要先定"主题"。' },
      { title: '铺场景', detail: '每个场景都要能回答"他在这里做什么"。' },
      { title: '出画面', detail: '手持纪实风格，构图可以不完美但必须真实。' },
      { title: '配旁白', detail: '旁白只交代必要信息，不替观众下结论。' },
    ],
    rules: [
      '不煽情、不加结论性旁白，把判断留给观众。',
      '采访式台词要口语，不要书面语。',
      '允许"没拍到更好"的不完美镜头。',
    ],
    checklist: ['有没有替观众下结论', '台词像不像真人说话', '有没有一个具体的人'],
    deliverables: ['分集脚本', '纪实画面', '成片'],
  },
];

function cleanList(value, limit = 30, per = 400) {
  return (Array.isArray(value) ? value : [])
    .map(item => {
      if (typeof item === 'string') return item.trim().slice(0, per);
      if (item && typeof item === 'object') return { title: String(item.title || '').trim().slice(0, 80), detail: String(item.detail || item.text || '').trim().slice(0, per) };
      return '';
    })
    .filter(item => (typeof item === 'string' ? item : item.title || item.detail))
    .slice(0, limit);
}

export function normalizeMethod(input = {}, clock = {}) {
  const now = (clock.now || (() => new Date().toISOString()))();
  const source = ['builtin', 'project', 'user'].includes(input.source) ? input.source : 'user';
  const num = (v, min, max, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
  };
  return {
    id: String(input.id || (clock.id || makeId)()),
    name: String(input.name || '').trim().slice(0, 40) || '未命名方法包',
    goal: String(input.goal || '').trim().slice(0, 400),
    source,
    targetSeconds: num(input.targetSeconds, 5, 3600, 90),
    scenesPerEpisode: num(input.scenesPerEpisode, 1, 40, 6),
    beatsPerScene: num(input.beatsPerScene, 1, 12, 3),
    // 推理档位（照 Lovart 的 fast / thinking）：快=轻量单轮，深思=先规划再执行。
    // 它影响的是「一键分镜 / 原著改编」这类要模型做规划的调用预算，与生成时的花费无关。
    reasoning: input.reasoning === 'thinking' ? 'thinking' : 'fast',
    styleHint: String(input.styleHint || '').trim().slice(0, 40),
    reference: input.reference && typeof input.reference === 'object'
      ? { images: num(input.reference.images, 0, 4, 0), prefer: input.reference.prefer === 'material' ? 'material' : 'portrait' }
      : undefined,
    steps: cleanList(input.steps, 20),
    rules: cleanList(input.rules, 30, 300),
    checklist: cleanList(input.checklist, 30, 200),
    deliverables: cleanList(input.deliverables, 20, 120),
    createdAt: String(input.createdAt || now),
  };
}

// 内置 + 用户存的。文件读不出来不算错：一套方法丢了不该让整个创作台打不开。
export async function listMethods(root) {
  let saved = [];
  try {
    const raw = JSON.parse(await fs.readFile(fileOf(root), 'utf8'));
    saved = (Array.isArray(raw?.methods) ? raw.methods : []).map(m => normalizeMethod(m)).slice(0, METHOD_MAX);
  } catch { saved = []; }
  return [...BUILTIN_METHODS.map(m => normalizeMethod({ ...m, source: 'builtin' })), ...saved];
}

export async function methodOf(root, id) {
  if (!id) return null;
  return (await listMethods(root)).find(m => m.id === id) || null;
}

async function readSaved(root) {
  try {
    const raw = JSON.parse(await fs.readFile(fileOf(root), 'utf8'));
    return (Array.isArray(raw?.methods) ? raw.methods : []).map(m => normalizeMethod(m));
  } catch { return []; }
}

export async function saveMethod(root, input = {}, clock = {}) {
  const id = String(input.id || '');
  // 内置方法包是不可变的：改它等于改了所有项目的标准，而且升级会被覆盖。
  // 想改就"复制成自己的"（界面上的按钮就是这么做的）。
  if (BUILTIN_METHODS.some(m => m.id === id)) {
    throw Object.assign(new Error('内置方法包不能改；先「存成我的方法包」再改'), { statusCode: 400 });
  }
  const saved = await readSaved(root);
  const method = normalizeMethod({ ...input, id: id || undefined }, clock);
  const next = [...saved.filter(m => m.id !== method.id), method];
  if (next.length > METHOD_MAX) throw Object.assign(new Error(`方法包最多 ${METHOD_MAX} 个`), { statusCode: 400 });
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(fileOf(root), JSON.stringify({ format: 'yuanshu-story-methods', version: 1, methods: next }, null, 2), 'utf8');
  return { method, methods: next };
}

export async function deleteMethod(root, id) {
  if (BUILTIN_METHODS.some(m => m.id === id)) throw Object.assign(new Error('内置方法包不能删'), { statusCode: 400 });
  const saved = await readSaved(root);
  const next = saved.filter(m => m.id !== id);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(fileOf(root), JSON.stringify({ format: 'yuanshu-story-methods', version: 1, methods: next }, null, 2), 'utf8');
  return { ok: saved.length !== next.length, methods: next };
}

// 从**当前项目**反推一份方法包：这是 Lovart 的"把一次成功的过程存成个人 Skill"。
// 只统计结构（几集、每集几场、每场几段、用了哪些类型、目标时长），
// 不把提示词/台词抄进去——方法要能跨项目用，抄了内容就变成"这一个项目的快照"。
export function captureFromProject(project, { name = '', clock = {} } = {}) {
  const episodes = Array.isArray(project?.episodes) ? project.episodes : [];
  const scenes = Array.isArray(project?.scenes) ? project.scenes : [];
  const beats = scenes.flatMap(s => s.beats || []);
  const kinds = { novel: 0, image: 0, video: 0 };
  for (const b of beats) if (kinds[b.kind] != null) kinds[b.kind] += 1;
  const dominant = Object.entries(kinds).sort((a, b) => b[1] - a[1]).filter(([, n]) => n > 0)[0]?.[0] || 'image';
  const perEpisode = episodes.length ? Math.max(1, Math.round(scenes.length / episodes.length)) : scenes.length;
  const perScene = scenes.length ? Math.max(1, Math.round(beats.length / scenes.length)) : 0;
  const targetSeconds = episodes.find(e => e.targetSeconds)?.targetSeconds || 90;
  const mix = Object.entries(kinds).filter(([, n]) => n).map(([k, n]) => `${k === 'novel' ? '文字' : k === 'image' ? '画面' : '视频'} ${n}`).join('、');
  return normalizeMethod({
    name: String(name || project?.title || '').trim().slice(0, 40) || '我的方法包',
    goal: `按这个项目跑通的打法：${episodes.length ? `${episodes.length} 集、` : ''}每集约 ${perEpisode} 场、每场约 ${perScene} 段，单集目标 ${targetSeconds} 秒。段落配比：${mix || '无'}`,
    source: 'project',
    targetSeconds,
    scenesPerEpisode: perEpisode,
    beatsPerScene: perScene,
    reasoning: beats.length >= 12 ? 'thinking' : 'fast',
    styleHint: String(project?.bible?.style?.visual || '').trim().slice(0, 40),
    steps: [
      { title: '照这个结构排集', detail: `${episodes.length || 1} 集，每集约 ${perEpisode} 场` },
      { title: '照这个粒度分段', detail: `每场约 ${perScene} 段，段落类型按需分配（${mix || '未定'}）` },
      { title: '批量出片后核对一致性', detail: '逐段看人物与场景有没有漂移' },
    ],
    rules: [
      `单集目标时长 ${targetSeconds} 秒。`,
      `段落配比参考：${mix || '按剧情需要'}`,
    ],
    checklist: ['每集结尾有钩子吗', '人物在不同段落是否一致', '有没有段落类型被配方的默认值抹平'],
    deliverables: ['分集大纲', '剧本'],
  }, clock);
}

// 给提示词用的一段方法说明。**只有真的写了内容的项才会出现**——
// 空方法包不该往提示词里塞一段空标题。
export function methodBrief(method) {
  if (!method) return '';
  const lines = [`## 创作方法：${method.name}`];
  if (method.goal) lines.push(method.goal);
  const structure = [
    method.targetSeconds ? `单集目标 ${method.targetSeconds} 秒` : '',
    method.scenesPerEpisode ? `每集约 ${method.scenesPerEpisode} 场` : '',
    method.beatsPerScene ? `每场约 ${method.beatsPerScene} 段` : '',
  ].filter(Boolean).join('；');
  if (structure) lines.push(`结构：${structure}`);
  if (method.rules?.length) lines.push('必须遵守：', ...method.rules.map(r => `- ${typeof r === 'string' ? r : r.detail || r.title}`));
  return lines.join('\n');
}

// 方法包怎么作用到一次模型调用上（照 Lovart 的 --mode fast / thinking）：
// 快=轻量单轮（省 token、够用），深思=先规划再执行（要更多输出余量）。
// 注意它**不改生成模型的花费**，只改"做规划"这一步的预算。
export function reasoningBudget(reasoning, kind = 'plan') {
  const thinking = reasoning === 'thinking';
  if (kind === 'storyboard') return thinking ? { maxTokens: 6000, timeout: 180000 } : { maxTokens: 3000, timeout: 90000 };
  return thinking ? { maxTokens: 16000, timeout: 300000 } : { maxTokens: 8000, timeout: 180000 };
}
