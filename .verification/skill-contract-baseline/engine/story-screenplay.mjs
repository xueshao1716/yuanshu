// engine/story-screenplay.mjs —— 剧本要素与导出
//
// 对照 Laper（laper.ai）时最刺眼的一条：它整个产品的地基是**剧本要素**——
// 场景标题（Scene Heading）/ 动作（Action）/ 角色（Character）/ 对话（Dialogue）/
// 括号（Parenthetical）/ 转场（Transition），自动套行业格式，再导出成 FDX/PDF。
// 而元枢的连续创作里，一个段落只有两样东西：`prompt`（生成指令）和 `dialogue`（台词），
// 于是**能出图、出片、出正文，却拿不出一个能给人看的剧本文件**。
//
// 这里补的就是那层：把提示词与台词拆成剧本要素，然后导出。
//
// 两条刻意的边界：
// - **不发明屏幕排版引擎**（缩进/等宽/分页那些）。屏幕上看排版收益小，
//   而"能导出成行业格式"收益大——先把数据模型和导出做对，屏幕样式后置。
// - **不硬塞没用的要素**。字幕（Subtitle）这类元枢当前没有任何数据来源的，先不做，
//   而不是加一个永远为空的字段充数。

export const INTERIOR_LABELS = { interior: 'INT', exterior: 'EXT', mixed: 'INT/EXT' };
export const INTERIOR_CN = { interior: '内景', exterior: '外景', mixed: '内外景' };

// 台词行 → 角色 / 括号提示 / 台词。
// 支持的写法（都由真实输入习惯而来）：
//   阿宁：我不走了。        阿宁: 我不走了。
//   阿宁（低声）：我不走了。  阿宁 (低声): 我不走了。
//   画外音：车不会来了。     ← 当角色名处理，不特殊化
//   没有冒号的行：若上一行有说话人 → 当作同一人的台词续行；否则当作动作行。
//   动作行标记（△ ▲ ○ ● ·）：**永远是动作**，不参与说话人判定。
// 动作行标记这条是 2026-09-15 补的，来自一份从别的工具导出的真剧本：它把动作写成
// `△ 记忆画面：年轻的林默穿着…`——带全角冒号，于是被认成"说话人 △ 记忆画面"；
// 更糟的是，一旦有了这个假说话人，后面每一行没有冒号的动作描述都被并进它名下，
// 整段动作变成一句 190 字的"台词"，台词机检（语速/拆镜）全被带偏。
// 所以动作行既要**先于**冒号规则拦下，也要**清掉** lastSpeaker——
// 否则下一行无冒号的动作还是会被算进上一句台词里。
const ACTION_MARK = /^([△▲○●◇◆・·※]|\*(?=\s))\s*/;
export function parseDialogueLines(dialogue) {
  const out = [];
  let lastSpeaker = '';
  for (const raw of String(dialogue || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (ACTION_MARK.test(line)) {
      out.push({ type: 'action', text: line.replace(ACTION_MARK, '').trim() });
      lastSpeaker = '';
      continue;
    }
    const m = line.match(/^([^：:（）()]{1,24}?)\s*(?:[（(]([^）)]{1,40})[）)])?\s*[：:]\s*(.+)$/);
    if (m) {
      lastSpeaker = m[1].trim();
      out.push({ type: 'dialogue', speaker: lastSpeaker, paren: (m[2] || '').trim(), text: m[3].trim() });
      continue;
    }
    if (lastSpeaker) out.push({ type: 'dialogue', speaker: lastSpeaker, paren: '', text: line });
    else out.push({ type: 'action', text: line });
  }
  return out;
}

// 场景标题要素。没填就用场景名兜底——**不许因为缺字段就导不出东西**。
export function sceneSlug(scene) {
  const s = scene?.slug && typeof scene.slug === 'object' ? scene.slug : {};
  const interior = INTERIOR_LABELS[s.interior] ? s.interior : 'interior';
  const location = String(s.location || scene?.title || '未命名场景').trim();
  const timeOfDay = String(s.timeOfDay || '').trim();
  return { interior, location, timeOfDay };
}

export function slugHollywood(scene) {
  const { interior, location, timeOfDay } = sceneSlug(scene);
  return `${INTERIOR_LABELS[interior]}. ${location}${timeOfDay ? ` - ${timeOfDay}` : ''}`;
}

export function slugChinese(scene) {
  const { interior, location, timeOfDay } = sceneSlug(scene);
  return `${INTERIOR_CN[interior]} ${location}${timeOfDay ? ` ${timeOfDay}` : ''}`;
}

// 一个段落的动作行：优先用显式 action（剧作内容），退回 prompt（生成指令）。
// 为什么要有显式 action：`prompt` 是发给图像/视频模型的「动作、构图、镜头、光线」，
// 把它整段当剧本动作，会把"镜头怎么推"写进剧本——那不是剧作该写的东西。
export function beatAction(beat) {
  const action = String(beat?.action || '').trim();
  if (action) return action;
  return String(beat?.prompt || '').trim();
}

// ── 组装：把项目摊成一份有序的剧本元素流（三种导出共用，避免各自漂移）──
// 分集（story-episodes）：有集就在每个集的开头插一条集标题元素，
// 于是导出的剧本是"第 1 集 / 第 2 集"分好的——短剧投稿要的就是这个形状。
export function projectToElements(project) {
  const episodes = new Map((project?.episodes || []).map(e => [String(e.id), e]));
  const elements = [];
  let currentEpisode = null;
  (project?.scenes || []).forEach((scene, sceneIndex) => {
    const epId = scene?.episodeId ? String(scene.episodeId) : '';
    const ep = epId && episodes.has(epId) ? episodes.get(epId) : null;
    if (ep && (!currentEpisode || currentEpisode !== ep.id)) {
      currentEpisode = ep.id;
      elements.push({ type: 'episode', text: `第 ${ep.no} 集 ${ep.title || ''}`.trim(), cn: `第 ${ep.no} 集 ${ep.title || ''}`.trim(), episodeId: ep.id });
    } else if (!ep && currentEpisode) {
      currentEpisode = null;
      elements.push({ type: 'episode', text: '（未分集）', cn: '（未分集）' });
    }
    elements.push({ type: 'scene_heading', text: slugHollywood(scene), cn: slugChinese(scene), index: sceneIndex + 1, sceneId: scene.id });
    if (scene.summary) elements.push({ type: 'synopsis', text: String(scene.summary).trim() });
    for (const beat of scene.beats || []) {
      const action = beatAction(beat);
      if (action) elements.push({ type: 'action', text: action, beatId: beat.id });
      for (const line of parseDialogueLines(beat.dialogue)) {
        if (line.type === 'action') elements.push({ type: 'action', text: line.text, beatId: beat.id });
        else elements.push({ type: 'dialogue', speaker: line.speaker, paren: line.paren, text: line.text, beatId: beat.id });
      }
      const transition = String(beat.transition || '').trim();
      if (transition) elements.push({ type: 'transition', text: transition, beatId: beat.id });
    }
  });
  return elements;
}

// ── Fountain（纯文本，规范公开且可机读）──
export function toFountain(project, { withSynopsis = true } = {}) {
  const lines = [`Title: ${project?.title || '未命名'}`, ''];
  const elements = projectToElements(project);
  for (const el of elements) {
    if (el.type === 'episode') { lines.push('', `# ${el.text}`, ''); continue; }
    if (el.type === 'scene_heading') { lines.push('', el.text, ''); continue; }
    if (el.type === 'synopsis') { if (withSynopsis) lines.push(`= ${el.text}`, ''); continue; }
    if (el.type === 'action') { lines.push(el.text, ''); continue; }
    if (el.type === 'transition') { lines.push(`> ${el.text}`, ''); continue; }
    // 角色名按 Fountain 惯例大写；中文没有大小写，原样即可
    lines.push(el.speaker.toUpperCase());
    if (el.paren) lines.push(`(${el.paren})`);
    lines.push(el.text, '');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// ── 中文剧本（给人看/给国内团队看的那种）──
export function toChineseScript(project, { withSynopsis = true } = {}) {
  const lines = [String(project?.title || '未命名').trim(), ''];
  if (project?.logline) lines.push(String(project.logline).trim(), '');
  let sceneNo = 0;
  for (const el of projectToElements(project)) {
    if (el.type === 'episode') { lines.push('', `【${el.cn}】`, ''); continue; }
    if (el.type === 'scene_heading') { sceneNo += 1; lines.push('', `${sceneNo}、${el.cn}`, ''); continue; }
    if (el.type === 'synopsis') { if (withSynopsis) lines.push(`（${el.text}）`, ''); continue; }
    if (el.type === 'action') { lines.push(`　　${el.text}`, ''); continue; }
    if (el.type === 'transition') { lines.push(`　　${el.text}`, ''); continue; }
    lines.push(`　　${el.speaker}${el.paren ? `（${el.paren}）` : ''}：${el.text}`);
    lines.push('');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

const escapeXml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// ── Final Draft (.fdx)：影视工业投稿用的 XML ──
// 结构按 FDX 的公开约定：<FinalDraft><Content> 下每个段落带 Type，
// 场景标题="Scene Heading"、动作="Action"、角色="Character"、括号="Parenthetical"、
// 台词="Dialogue"、转场="Transition"。
// **诚实说明**：本机没有 Final Draft，无法真机打开验证；这里保证结构正确、XML 合法，
// 并且不写任何我们没把握的属性（宁可少写，也别导出一个软件打不开的文件）。
export function toFdx(project) {
  const paragraphs = [];
  for (const el of projectToElements(project)) {
    // 分集：FDX 里用一段居中的 Action 承载集标题（不发明自定义 Type，免得软件打不开）
    if (el.type === 'episode') { paragraphs.push(['Action', el.text]); continue; }
    if (el.type === 'scene_heading') { paragraphs.push(['Scene Heading', el.text]); continue; }
    if (el.type === 'synopsis') continue; // FDX 正文里不写梗概，那是大纲视图的事
    if (el.type === 'action') { paragraphs.push(['Action', el.text]); continue; }
    if (el.type === 'transition') { paragraphs.push(['Transition', el.text]); continue; }
    paragraphs.push(['Character', el.speaker]);
    if (el.paren) paragraphs.push(['Parenthetical', `(${el.paren})`]);
    paragraphs.push(['Dialogue', el.text]);
  }
  const body = paragraphs
    .map(([type, text]) => `    <Paragraph Type="${type}">\n      <Text>${escapeXml(text)}</Text>\n    </Paragraph>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<FinalDraft DocumentType="Script" Template="No" Version="1">\n  <Content>\n${body}\n  </Content>\n</FinalDraft>\n`;
}

export const SCRIPT_FORMATS = {
  txt: { ext: 'txt', mime: 'text/plain; charset=utf-8', label: '中文剧本（.txt）', render: toChineseScript },
  fountain: { ext: 'fountain', mime: 'text/plain; charset=utf-8', label: 'Fountain（.fountain）', render: toFountain },
  fdx: { ext: 'fdx', mime: 'application/xml; charset=utf-8', label: 'Final Draft（.fdx）', render: toFdx },
};

export function renderScript(project, format = 'txt') {
  const spec = SCRIPT_FORMATS[format] || SCRIPT_FORMATS.txt;
  return { format: SCRIPT_FORMATS[format] ? format : 'txt', ext: spec.ext, mime: spec.mime, body: spec.render(project) };
}

// 导出统计：给界面显示"这部戏有多少场、多少台词"，也顺手当作导出的自检
export function scriptStats(project) {
  const elements = projectToElements(project);
  return {
    scenes: elements.filter(e => e.type === 'scene_heading').length,
    actions: elements.filter(e => e.type === 'action').length,
    dialogueLines: elements.filter(e => e.type === 'dialogue').length,
    transitions: elements.filter(e => e.type === 'transition').length,
    speakers: [...new Set(elements.filter(e => e.type === 'dialogue').map(e => e.speaker))],
  };
}
