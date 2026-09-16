const list = (value) => Array.isArray(value) ? value : [];

export function normalizeBible(input = {}) {
  const normalizeEntry = (item) => {
    if (typeof item === 'string') return { text: item.trim() };
    if (!item || typeof item !== 'object') return null;
    const out = { ...item };
    if (out.id != null) out.id = String(out.id);
    if (out.name != null) out.name = String(out.name);
    return out;
  };
  const entries = key => list(input[key]).map(normalizeEntry).filter(Boolean);
  const style = input.style && typeof input.style === 'object' && !Array.isArray(input.style) ? { ...input.style } : {};
  return {
    characters: entries('characters'),
    locations: entries('locations'),
    props: entries('props'),
    wardrobe: entries('wardrobe'),
    style,
    rules: entries('rules'),
  };
}

function entryText(item) {
  if (!item || typeof item !== 'object') return '';
  const values = Object.entries(item)
    .filter(([key, value]) => key !== 'id' && value != null && String(value).trim())
    .map(([key, value]) => `${key}: ${String(value).trim()}`);
  return values.join('，');
}

function section(label, values) {
  const lines = values.map(entryText).filter(Boolean);
  return lines.length ? `## ${label}\n${lines.map(v => `- ${v}`).join('\n')}` : '';
}

// 对话优先：台词单独成块，**不混进画面描述**。
// 为什么较这个真：`prompt` 会整段发给生成模型。台词写进画面描述，生图模型会试着把字画出来
// （或者把真正的视觉指令稀释掉）；而台词本身是这个故事真正的骨头——
// 一段戏站着不站着，看的是人物说了什么，不是镜头怎么推。
// 所以：文字段落（novel）以对白推进；画面（image）不出现在提示词里；视频（video）作为台词上送。
export function dialogueBlock(beat, kind) {
  const raw = String(beat?.dialogue || '').trim();
  if (!raw) return '';
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 40).map(l => `- ${l}`).join('\n');
  if (!lines) return '';
  if (kind === 'image') return '';
  const head = kind === 'video' ? '## 本段台词（画外/口播，不要当成画面内容去画）' : '## 本段台词（必须按这些台词写成戏，不要改写成旁白）';
  return `${head}\n${lines}`;
}

// 负向提示词（ComfyUI 里 negative 是一等公民，元枢此前完全没有）。
// 这里先落成**提示词块**：任何生图/生视频通道都吃文本，也不会因为某家上游不认
// `negative_prompt` 字段而整单失败。同时编排层还会把它作为 negative 传给图像通道
// （见 story-orchestrator 的 buildRunPlan），两处都看得见。
export function negativeBlock(negative) {
  const text = String(negative || '').trim();
  if (!text) return '';
  const lines = text.split(/[\n；;]+/).map(l => l.trim()).filter(Boolean).slice(0, 20).map(l => `- ${l}`).join('\n');
  return lines ? `## 必须避免\n- 以下内容**不要**出现在这一段的成品里：\n${lines}` : '';
}

export function compileStoryPrompt({ bible, scene, beat, inherited, negative, shotSpec = '' } = {}) {
  const b = normalizeBible(bible);
  const refs = [];
  for (const item of [...(inherited?.referenceIds || []), ...(beat?.references || [])]) {
    const id = typeof item === 'string' ? item : item?.id;
    if (id && !refs.includes(id)) refs.push(id);
  }
  const style = Object.entries(b.style).filter(([, value]) => value != null && String(value).trim()).map(([k, v]) => `${k}: ${String(v).trim()}`).join('，');
  const blocks = [
    // 镜头规格（由 story-shot-prompt.mjs 编译）放在**最前面**：上游对开头的权重最高，
    // 而景别/机位/光线/色调/质感/落幅正是决定"出片像不像电影"的那几样。
    // 没有它时这一段为空——不占位置，也不假装有。
    String(shotSpec || '').trim() ? `## 镜头规格（优先据此生成，不要改写成别的镜头）\n${String(shotSpec).trim()}` : '',
    '你正在执行元枢连续创作，请严格保持故事状态一致。',
    section('角色', b.characters),
    section('场景资产', b.locations),
    section('道具', b.props),
    section('服装', b.wardrobe),
    style ? `## 视觉与叙事风格\n- ${style}` : '',
    section('连续性规则', b.rules),
    scene?.title ? `## 当前场景\n- 标题: ${scene.title}\n- 摘要: ${scene.summary || '无'}` : '',
    // 全剧至今（story-context.mjs）：接得上前面，但不能变成复述比赛
    inherited?.storySoFar?.text ? inherited.storySoFar.text : '',
    inherited?.prompt ? `## 继承镜头上下文\n${inherited.prompt}` : '',
    beat?.prompt ? `## 当前镜头要求\n${beat.prompt}` : '',
    dialogueBlock(beat, beat?.kind),
    negativeBlock(negative ?? beat?.negative),
    // 素材：别的工作台产出的图/视频/文本被挂到这一段上时，正文里要能看见它们是什么，
    // 否则模型只知道"有素材"，写出来的东西对不上。
    materialBlock(inherited?.materials),
    refs.length ? `## 参考资产\n${refs.map(id => `- ${id}`).join('\n')}` : '',
  ].filter(Boolean);
  return { text: blocks.join('\n\n'), referenceIds: refs };
}

// 挂载素材的文本说明。图/视频只说"有什么"，正文素材直接把内容给模型看（截断）。
export function materialBlock(materials) {
  const list = Array.isArray(materials) ? materials.filter(m => m && (m.text || m.name || m.url)) : [];
  if (!list.length) return '';
  const lines = [];
  for (const m of list) {
    const kind = m.type === 'image' ? '画面' : m.type === 'video' ? '视频' : '文本';
    if (m.type === 'text' && m.text) lines.push(`### 素材（文本）：${m.name || '未命名'}\n${String(m.text).trim().slice(0, 4000)}`);
    else lines.push(`- ${kind}素材：${m.name || m.url}`);
  }
  return `## 本段已挂载素材\n- 这些素材是创作依据，请与之保持一致（人物长相、场景、已发生的事）。\n${lines.join('\n')}`;
}

// 角色定妆照提示词：产出「后续所有镜头可复用的形象参考」，不是一张插画。
// 因此限定单人/正面/中性表情/纯色背景/均匀柔光，并禁止文字与多人。
// look：形象变体（基础形象 / 战斗装束 / 便装…）。一个角色只锁一张脸是不够的——
// 换装段落必须有一张对应的形象图，否则模型只能靠文字猜，一致性立刻掉。
export function buildPortraitPrompt({ bible, character, look = null } = {}) {
  const b = normalizeBible(bible);
  const style = Object.entries(b.style).filter(([, value]) => value != null && String(value).trim()).map(([k, v]) => `${k}: ${String(v).trim()}`).join('，');
  const self = entryText(character);
  const lookName = String(look?.name || '').trim();
  const blocks = [
    '生成一张角色定妆照（character sheet）。它的用途是作为后续所有镜头的人物形象参考，因此必须稳定、可复用，而不是一张有情绪有场景的插画。',
    self ? `## 角色设定\n- ${self}` : '',
    lookName ? `## 这一张形象\n- 形象名：${lookName}\n- **这一张的服装与装备以「${lookName}」为准**，覆盖角色设定里的服装描述（上面那段设定常写着日常穿着，那是基础形象，不是这一张）。\n- 脸、发型、体格必须与角色设定完全一致——同一张脸的不同形象，不是另一个人。` : '',
    style ? `## 统一视觉风格\n- ${style}` : '',
    '## 硬性要求\n- 单人、正面半身、中性表情、纯色背景、均匀柔光，无强投影。\n- 服装与外貌严格按设定，不要自由发挥或美化。\n- 画面里不要出现任何文字、水印、分镜格、多人。',
    // 结构锚点（借 hypit 的 Person 段写法）：半身像最容易毁在"窄肩配大脑袋"，
    // 而"身形挺拔/气质出众"这种笼统赞美对模型等于没说——必须落到可量的结构上。
    '## 身体比例\n- **肩要宽、头肩比要好**：肩线要撑得住画面，不要窄肩配大脑袋的半身像。\n- 体型按角色设定如实呈现（年龄、体格、是否佝偻），不要一律套"标准模特身材"。\n- 不要用"身形挺拔/气质出众/well presented"这类笼统赞美代替具体的结构描述。',
    // Shot 段（同样借 hypit）：模型对"什么镜头、什么景别"很敏感，写清楚比让它自己猜稳。
    '## 镜头\n- 85mm 人像镜头等效，半身构图、胸口以上入画；轻微景深，不要广角畸变（广角会把脸拍宽）。',
  ].filter(Boolean);
  return blocks.join('\n\n');
}

// 场景 / 道具参考图：与定妆照同一个思路，只是对象从"人"换成"地方"和"东西"。
// 为什么需要它：定妆照只锁住了人物，**场景和道具一直只有文字**——于是同一间屋子在两段里
// 长得不一样（对手产品都在解决这件事：PINNGOO 叫"资产库"、LibTV 叫"角色三视图"）。
// 要求：无人物、构图中性、光线均匀、细节完整，这样它才能当"同一个地方"的锚点。
export function buildAssetPrompt({ bible, assetType, item } = {}) {
  const b = normalizeBible(bible);
  const style = Object.entries(b.style).filter(([, value]) => value != null && String(value).trim()).map(([k, v]) => `${k}: ${String(v).trim()}`).join('，');
  const self = entryText(item);
  const isLocation = assetType === 'location';
  const what = isLocation ? '场景' : '道具';
  const label = isLocation ? '场景参考图（location sheet）' : '道具参考图（prop sheet）';
  const blocks = [
    `生成一张${what}${label}。它的用途是作为后续所有相关镜头的 ${what} 参考，因此必须稳定、可复用，而不是一张有剧情有情绪的画面。`,
    self ? `## ${what}设定\n- ${self}` : '',
    style ? `## 统一视觉风格\n- ${style}` : '',
    isLocation
      ? '## 硬性要求\n- 构图中性、视角平视，把这个地方**整体交代清楚**（空间关系、材质、光线氛围）。\n- 画面里**不要出现任何人物或动物**（有人物就没法当场景锚点）。\n- 不要出现文字、水印、分镜格。'
      : '## 硬性要求\n- 单一物件居中、完整入画、细节清晰（材质、磨损、标识都要能用）。\n- 纯净背景，**不要出现人物**，也不要出现无关杂物。\n- 不要出现文字、水印、分镜格。',
  ].filter(Boolean);
  return blocks.join('\n\n');
}
