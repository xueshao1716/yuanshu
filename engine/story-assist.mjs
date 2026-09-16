export function buildStoryAssistPrompt({ title = '', logline = '', idea = '', current = {} } = {}) {
  return `你是元枢连续创作的故事设定助手。请根据用户想法生成一份“可编辑草稿”，由人类确认后才会保存。不要改写既有设定，只补充空缺。\n\n项目：${String(title).trim() || '未命名故事'}\n梗概：${String(logline).trim() || '暂无'}\n用户想法：${String(idea).trim() || '请补齐一个可拍摄的开端'}\n已有状态：${JSON.stringify(current).slice(0, 5000)}\n\n要求：\n1. **重视对话**：beat.dialogue 写这一段的实际台词，要具体、有语气和潜台词，能看出说话人是谁；不要写“他们交谈了几句”这种概述。\n2. beat.prompt 只写画面与动作（构图、光线、人物动作），不要把台词塞进画面描述。\n3. 内容要具体、可执行；kind 只能是 novel/image/video。\n\n只返回 JSON，不要 Markdown：{"characters":[{"name":"","appearance":""}],"locations":[{"name":"","description":""}],"props":[{"name":"","description":""}],"wardrobe":[{"name":"","description":""}],"style":{"visual":"","tone":""},"rules":[{"text":""}],"scene":{"title":"","summary":""},"beat":{"kind":"image","prompt":"","dialogue":""}}。`;
}

function cleanEntry(item) {
  if (!item || typeof item !== 'object') return null;
  const allowed = ['id', 'name', 'text', 'appearance', 'description'];
  const out = {};
  for (const key of allowed) if (item[key] != null && String(item[key]).trim()) out[key] = String(item[key]).trim();
  return Object.keys(out).length ? out : null;
}

// 台词（对白）：与画面提示词分开存。
// 为什么要分开：`prompt` 是发给图像/视频模型的**画面描述**，把台词写进去会被生图模型
// 当画面内容画出来（或者稀释掉真正的视觉指令）。台词本身是要留下来的剧作内容——
// 它决定这段戏成不成立，也决定后续配音/口播有没有东西可念。
export const DIALOGUE_KEYS = ['dialogue', 'dialog', 'lines', 'line', 'script', '台词', '对白'];
export function cleanDialogue(value) {
  if (value == null) return '';
  // 数组要逐个复用同一套处理：直接 String(element) 会把 [{name,text}] 变成 "[object Object]"
  if (Array.isArray(value)) return value.map(v => cleanDialogue(v)).filter(Boolean).join('\n').slice(0, 2000);
  if (typeof value === 'object') {
    const name = String(value.name || value.speaker || value.who || '').trim();
    const text = String(value.text || value.line || value.content || '').trim();
    return (name && text) ? `${name}：${text}` : (text || name);
  }
  return String(value).trim().slice(0, 2000);
}

// 设定块清洗：assist（补一段）与 storyboard（一键分镜）共用，避免两处形状判断漂移。
export function cleanBible(source) {
  const src = source && typeof source === 'object' ? source : {};
  const list = key => Array.isArray(src[key]) ? src[key].map(cleanEntry).filter(Boolean).slice(0, 30) : [];
  const style = src.style && typeof src.style === 'object' ? Object.fromEntries(Object.entries(src.style).slice(0, 12).map(([k, v]) => [String(k), String(v).trim()]).filter(([, v]) => v)) : {};
  return { characters: list('characters'), locations: list('locations'), props: list('props'), wardrobe: list('wardrobe'), style, rules: list('rules') };
}

// 智能填充的解析：**与一键分镜、原著改编共用同一套宽容逻辑**。
// 这里曾经是个害过人的不一致：storyboard/adapt 早就能从"先复述一段再给 JSON"里把答案抠出来，
// 而 assist 只做一次 JSON.parse——模型多写一句"好的，以下是草稿"就报
// 「智能填充返回的内容不是有效 JSON」，用户手里一条线索都没有。
// 真实模型给的东西五花八门：包一层 assist/draft/data、带 ```json 围栏、前后各写一段解释、
// 甚至先把提示词里的"已有状态"复述一遍再给答案（取第一个 JSON 就会拿错）。全部宽容处理。
export function parseStoryAssist(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const candidates = [];
  try { candidates.push(JSON.parse(text)); } catch { /* 落到逐个抠对象 */ }
  candidates.push(...extractJsonObjects(text));
  if (!candidates.length) {
    throw new Error(`智能填充返回的内容里找不到 JSON（开头：${text.slice(0, 100) || '(空)'}）。可以换一个构思模型再试，或把想法写具体一些。`);
  }
  const failures = [];
  let anyContent = null;
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const parsed = candidate.assist || candidate.draft || candidate.data || candidate.result || candidate;
    const scene = parsed.scene && typeof parsed.scene === 'object'
      ? { title: String(parsed.scene.title || '').trim(), summary: String(parsed.scene.summary || '').trim() }
      : {};
    const beat = parsed.beat && typeof parsed.beat === 'object'
      ? {
        kind: ['novel', 'image', 'video'].includes(parsed.beat.kind) ? parsed.beat.kind : 'image',
        prompt: String(parsed.beat.prompt || '').trim(),
        dialogue: cleanDialogue(firstDialogue(parsed.beat)),
      }
      : {};
    const bible = cleanBible(parsed);
    const hasSceneOrBeat = Boolean(scene.title || scene.summary || beat.prompt || beat.dialogue);
    const hasContent = Boolean(
      hasSceneOrBeat
      || bible.characters.length || bible.locations.length || bible.props.length || bible.wardrobe.length
      || bible.rules.length || Object.keys(bible.style).length,
    );
    if (!hasContent) { failures.push(Object.keys(parsed).slice(0, 8).join('/') || '无键'); continue; }
    // **优先取带 scene/beat 的那个候选**：那才是"这一段的可编辑草稿"。
    // 模型常常先把提示词里的「已有状态」复述一遍再给答案，而那份复述里也有
    // characters/locations（看名字完全像一份合格的回答）——唯一的区别是它没有 scene/beat，
    // 因为 bible 里根本没有这两个字段。只按"有没有内容"挑，就会把复述当成草稿（实测即踩到）。
    if (hasSceneOrBeat) return { ...bible, scene, beat };
    if (!anyContent) anyContent = { ...bible, scene, beat };
  }
  if (anyContent) return anyContent;
  throw new Error(`智能填充返回的 JSON 里没有可用内容（试过 ${candidates.length} 个 JSON，顶层键：${failures.join(' | ').slice(0, 140)}；原文开头：${text.slice(0, 120)}）。可以换一个构思模型再试。`);
}

export function firstDialogue(source) {
  if (!source || typeof source !== 'object') return '';
  for (const key of DIALOGUE_KEYS) if (source[key] != null) return source[key];
  return '';
}

// ── 一键分镜：从梗概一次生成整场分镜表（多段），而不是只给一段 ──
// 之前 assist 只产出 1 个 beat，用户得一段一段点「从此处继续」。
// 2026-09-14：分镜同时登记设定（characters/locations/props/wardrobe）。
// 只出段落不建角色库的话，「定妆照」和「参考图锁定」都拿不到数据——功能在界面上存在却用不了。
// 2026-09-15：每段必须带**台词**。此前提示词只要求"动作/构图/镜头/光线"，
// 出来的是一串漂亮的画面说明、一句人话都没有——戏不成戏，后续配音也没东西可念。
export function buildStoryboardPrompt({ title = '', logline = '', idea = '', current = {}, count = 6 } = {}) {
  const n = Math.max(2, Math.min(12, Number(count) || 6));
  return `你是元枢连续创作的**编剧兼分镜师**。请把故事拆成 ${n} 段可直接生成的分镜，并登记其中出现的人物与场景。

项目：${String(title).trim() || '未命名故事'}
梗概：${String(logline).trim() || '暂无'}
用户想法：${String(idea).trim() || '请补齐一个可拍摄的开场'}
已有设定：${JSON.stringify(current).slice(0, 4000)}

要求：
1. **重视对话创作**：每段都要写 dialogue——这一段**真正说出来**的台词，一行一句，写成「角色名：台词」。
   台词是这个故事的骨头：要有具体用词、语气和潜台词，让人不看画面也知道说话人是谁、在图什么。
   禁止"两人交谈了几句""她表达了不满"这类概述，也禁止把台词写成旁白解说。
2. prompt 只写**画面与动作**（动作、构图、镜头、光线），不要写文学评论，也不要把台词塞进画面描述。
3. **shot 要把镜头语言拆成字段**（画面/视频段落必填，别留空、别把整段塞进一个字段）：
   - size 景别：大远景/远景/全景/中全景/中景/中近景/近景/特写/大特写
   - angle 机位：平视/俯拍/仰拍/斜角/过肩/主观
   - move 运镜：固定/缓缓推近/拉远/横移/跟拍/摇镜/升降/环绕/手持（一次只写一个主要运镜）
   - light 光线：这段画面的光从哪来（窗外折射的柔和自然光 / 单侧硬光 / 霓虹与街灯…）
   - tone 色调：冷暖与情绪（温暖复古略带怀旧 / 冷调局部暖色提示…）
   - ending **落幅**：这一镜的最后一个画面定格在哪（镜头之间不跳的关键，必须写）
   - carry **承接**：从第 2 段起，写明"承接上一段哪个落点"（上一段的 ending 就是这一段的入场状态）
   - seconds 时长（秒，整数，4–15）
   写 shot 的依据是"摄影指导会怎么拍"，不是你希望观众感觉到什么。
4. 段与段之间必须接得上：第 2 段起承接上一段结尾，推进新事件，不重复开场。
5. kind 只能是 novel（文字段落）/ image（画面）/ video（视频片段）；整场同一种 kind 更连贯。
6. bible 里登记**本片真正出场**的人物与场景：characters 的 appearance 要写清年龄、体型、发型、服装、辨识特征（供后续生成定妆照锁定长相）；**虚构人物要写出强美感，但必须落到身体结构上**——写清肩宽/头肩比（例：宽肩、头肩比好）与身高体型，长相用**具体类比**（例：参考韩国男团门面的清冷感），不要用"气质出众/身形挺拔"这种笼统赞美代替结构描述——半身像最容易因此出"窄肩配大脑袋"；已在「已有设定」里的角色按原名原样重复一遍，不要改名，也不要凭空新增没出场的角色。
7. 段落提示词里要**写出角色姓名**，后续靠姓名把定妆照挂到对应段落上。

只返回 JSON，不要 Markdown：
{"bible":{"characters":[{"name":"","appearance":""}],"locations":[{"name":"","description":""}],"props":[{"name":"","description":""}],"style":{"visual":"","tone":""}},"scenes":[{"title":"","summary":"","beats":[{"kind":"video","prompt":"","shot":{"size":"","angle":"","move":"","light":"","tone":"","ending":"","carry":""},"seconds":4,"dialogue":"角色名：台词"}]}]}`;
}

// 收集文本里**所有**配平的 JSON 对象。
// 只取第一个是不够的：模型常常先复述一段上下文（例如我提示词里的「已有设定」JSON），
// 再给答案；取第一个就会把复述当成结果（2026-09-14 真实调用即踩到，
// 报出来的顶层键正是设定形状 characters/locations/props/…）。
export function extractJsonObjects(raw) {
  const s = String(raw || '');
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        // 只有配平到 0 才算一个完整对象；之前把 break 写在了这个分支里，
        // 于是遇到第一个嵌套 } 就跳出，外层对象永远抓不到（2026-09-14 自测抓到）。
        if (depth === 0) {
          try { out.push(JSON.parse(s.slice(i, j + 1))); } catch { /* 不完整就跳过 */ }
          i = j;
          break;
        }
      }
    }
  }
  return out;
}

export function extractJsonObject(raw) {
  return extractJsonObjects(raw)[0] || null;
}

// 真实模型不照理想形状出牌：可能包一层 storyboard/data/result、scenes 给成对象而不是数组、
// 段落提示词叫 content/description/shot 而不是 prompt。这里全部宽容处理，
// 因为「解析不出来」对用户来说就是功能不可用（2026-09-14 首次真实调用即踩到）。
const BEAT_KEYS = ['beats', 'shots', 'segments'];
const PROMPT_KEYS = ['prompt', 'content', 'description', 'text', 'shot', 'action'];
const KIND_HINT = [[/video|视频|镜头运动|运镜/i, 'video'], [/image|画面|分镜图|静帧/i, 'image']];

function firstString(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return '';
}

// 镜头语言字段白名单：size/angle/move/light/tone/texture/ending/carry（见 story-shot-prompt.mjs）。
// 为什么要在这里收：这些字段进项目后会被"镜头提示词编译器"读走，
// 变成发往视频模型的提示词最前面那几句（景别/机位/光线/质感/落幅）。丢掉它们 = 白让模型写一遍。
const SHOT_KEYS = ['size', 'angle', 'move', 'light', 'tone', 'texture', 'ending', 'carry'];
export function cleanShotFields(src) {
  if (!src || typeof src !== 'object' || Array.isArray(src)) return {};
  const out = {};
  for (const key of SHOT_KEYS) {
    const value = src[key];
    if (value != null && String(value).trim()) out[key] = String(value).trim().slice(0, 120);
  }
  return out;
}

const cleanBeat = (item) => {
  if (typeof item === 'string') return item.trim() ? { kind: 'image', prompt: item.trim() } : null;
  if (!item || typeof item !== 'object') return null;
  const prompt = firstString(item, PROMPT_KEYS);
  const dialogue = cleanDialogue(firstDialogue(item));
  // 只有台词、没有画面描述时也算一段：台词是硬内容，画面可以后补；
  // 反过来把整段丢掉，等于把编剧刚写的对白扔了。
  if (!prompt && !dialogue) return null;
  let kind = ['novel', 'image', 'video'].includes(item.kind) ? item.kind
    : ['novel', 'image', 'video'].includes(item.type) ? item.type : '';
  if (!kind) {
    const hit = KIND_HINT.find(([re]) => re.test(String(item.kind || item.type || '')));
    kind = hit ? hit[1] : 'image';
  }
  const shot = cleanShotFields(item.shot || item.camera || item.shot_spec);
  const asked = Number(item.seconds ?? item.duration ?? item.duration_sec ?? item.durationSec);
  const seconds = Number.isFinite(asked) && asked > 0 ? Math.max(1, Math.min(60, Math.round(asked))) : null;
  return {
    kind, prompt,
    ...(dialogue ? { dialogue } : {}),
    ...(Object.keys(shot).length ? { shot } : {}),
    ...(seconds ? { params: { seconds } } : {}),
  };
};

function beatsOf(scene) {
  for (const key of BEAT_KEYS) {
    const value = scene?.[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

// 场次标题（slug）：interior / location / timeOfDay。
// 模型可能给对象、给一行完整场次标题（「外景 站台 夜」或「INT. 车内 - 凌晨」）、或干脆不给；
// 缺了不影响生成，但**一行标题也不能白扔**——它是剧本里唯一写清"这场在哪、什么时间"的东西。
const TIME_WORDS = /^(日|夜|晨|清晨|早|上午|中午|下午|傍晚|黄昏|晚|深夜|凌晨|day|night|dawn|dusk|morning|evening|noon|afternoon|sunset|sunrise)$/i;
function parseSlugLine(text) {
  let rest = String(text || '').trim();
  let interior = '';
  const head = rest.match(/^(int\.?\s*\/\s*ext\.?|ext\.?\s*\/\s*int\.?|int\.?|ext\.?|内外景|内景|外景|日外|日内|夜外|夜内)\s*[.。:：、]?\s*/i);
  if (head) {
    const tag = head[1].toLowerCase();
    interior = tag.startsWith('内外') || tag.includes('/') ? 'mixed'
      : tag.startsWith('ext') || tag.startsWith('外') || tag.startsWith('日外') || tag.startsWith('夜外') ? 'exterior' : 'interior';
    rest = rest.slice(head[0].length).trim();
  }
  // 先按分隔号切（「车内 - 凌晨」），没有分隔号再按空白切，末段是时间就单拎出来
  const parts = rest.split(/\s*[-—–－]{1,2}\s*/).map(s => s.trim()).filter(Boolean);
  let location = rest, timeOfDay = '';
  if (parts.length >= 2) {
    location = parts[0];
    timeOfDay = parts[parts.length - 1];
  } else {
    const tokens = rest.split(/\s+/).filter(Boolean);
    if (tokens.length >= 2 && TIME_WORDS.test(tokens[tokens.length - 1])) {
      timeOfDay = tokens[tokens.length - 1];
      location = tokens.slice(0, -1).join(' ');
    }
  }
  return { ...(interior ? { interior } : {}), ...(location ? { location: location.slice(0, 60) } : {}), ...(timeOfDay ? { timeOfDay: timeOfDay.slice(0, 30) } : {}) };
}

function cleanSlug(scene) {
  const raw = scene?.slug ?? scene?.heading ?? scene?.sceneHeading;
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'object') return Object.keys(parseSlugLine(raw)).length ? parseSlugLine(raw) : null;
  const src = raw;
  const intExt = String(src.interior ?? src.intExt ?? src.int_ext ?? '').trim();
  const interior = /^(ext|exterior|外)/i.test(intExt) ? 'exterior'
    : /^(int|interior|内)/i.test(intExt) ? 'interior'
      : /^(mixed|混合|内外)/i.test(intExt) ? 'mixed' : '';
  const location = firstString(src, ['location', 'place', 'where']);
  const timeOfDay = firstString(src, ['timeOfDay', 'time', 'when']);
  const out = {
    ...(interior ? { interior } : {}),
    ...(location ? { location: location.slice(0, 60) } : {}),
    ...(timeOfDay ? { timeOfDay: timeOfDay.slice(0, 30) } : {}),
  };
  return Object.keys(out).length ? out : null;
}

// 场景清洗**只此一份**：一键分镜（storyboard）与原著改编（adapt）共用。
// 真实模型返回的形状五花八门，宽容逻辑一旦写成两份必然漂移——
// 到时候「分镜能解析、改编解析不出来」这种差异修一个漏一个。
export function cleanScenes(rawScenes, { maxScenes = 12, maxBeats = 40 } = {}) {
  const src = Array.isArray(rawScenes) ? rawScenes : (rawScenes && typeof rawScenes === 'object' ? [rawScenes] : []);
  return src.slice(0, maxScenes).map(scene => {
    const slug = cleanSlug(scene);
    return {
      title: firstString(scene, ['title', 'name']),
      summary: firstString(scene, ['summary', 'description', 'synopsis']),
      ...(slug ? { slug } : {}),
      beats: beatsOf(scene).slice(0, maxBeats).map(cleanBeat).filter(Boolean),
    };
  }).filter(scene => scene.beats.length);
}

export function parseStoryboard(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const candidates = [];
  try { candidates.push(JSON.parse(text)); } catch { /* 落到逐个抠对象 */ }
  candidates.push(...extractJsonObjects(text));
  if (!candidates.length) {
    throw new Error(`分镜返回的内容不是有效 JSON（开头：${text.slice(0, 80) || '(空)'}）`);
  }
  const seen = new Set();
  const failures = [];
  // 逐个候选试：取第一个真能解析出段落的（模型可能先复述上下文再给答案）
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || seen.has(candidate)) continue;
    seen.add(candidate);
    const root = candidate.storyboard || candidate.data || candidate.result || candidate;
    let scenes = root.scenes ?? root.shots ?? root.episodes ?? root;
    if (!Array.isArray(scenes)) scenes = [scenes];
    const out = cleanScenes(scenes, { maxScenes: 12 });
    const beatCount = out.reduce((n, scene) => n + scene.beats.length, 0);
    if (beatCount) return { scenes: out, beatCount, bible: cleanBible(candidate.bible || root.bible) };
    failures.push(Object.keys(candidate).slice(0, 8).join('/') || '无键');
  }
  throw new Error(`分镜里没有任何可生成的段落（试过 ${candidates.length} 个 JSON，顶层键：${failures.join(' | ').slice(0, 120)}；原文开头：${text.slice(0, 120)}）`);
}

// ── 原著改编：小说原文 → 总览 + 人物关系 + 分集大纲（每集内含分场与段落）──
// 元枢此前只能把小说工坊的章节挂在项目上，不会分集：一整本小说进来就是一个大平铺，
// 用户得自己数着第几场属于第几集。这是 PINNGOO「小说转分集短剧」的核心四步。
export function buildAdaptPrompt({ title = '', sourceText = '', episodes = 4, secondsPerEpisode = 90, idea = '' } = {}) {
  const ep = Math.max(1, Math.min(60, Number(episodes) || 4));
  const secs = Math.max(15, Math.min(1800, Number(secondsPerEpisode) || 90));
  const text = String(sourceText || '').slice(0, 60000);
  return `你是元枢连续创作的**改编编剧**。下面是一部小说的原文（可能不完整）。请把它改编成 ${ep} 集短剧，每集目标时长约 ${secs} 秒。

项目：${String(title).trim() || '未命名故事'}
${String(idea).trim() ? `改编要求：${String(idea).trim().slice(0, 500)}\n` : ''}
## 小说原文
${text}

要求：
1. **先梳理再改编**：overview.logline 写清这个故事一句话讲的是什么；overview.characters 登记主要人物，appearance 要写清年龄、体型、发型、服装、辨识特征（后续要据此生成定妆照锁定长相）；overview.relationships 写人物关系。
2. **按集组织**：episodes 每集要有 no（从 1 开始）、title、summary（这一集讲什么、钩子在哪），
   以及 scenes——每场要有 title、summary，slug 写清 interior（interior / exterior / mixed）、location、timeOfDay。
3. **每段都要能直接生成**：beats 里每段 kind（novel / image / video）、prompt 写清动作、构图、镜头、光线，dialogue 写这一段的台词（一行一句「角色名：台词」）。
4. **保留原著的主线与关键转折**，可以压缩、合并、改写，但不要凭空新增原著里没有的人物与事件。
5. **每集结尾留钩子**，集与集之间要接得上；按目标时长决定每集放几场、每场几段。
6. 段落提示词里要写出**角色姓名**，后续靠姓名把定妆照挂到对应段落上。

只返回 JSON，不要 Markdown：
{"overview":{"logline":"","characters":[{"name":"","appearance":""}],"relationships":[{"from":"","to":"","note":""}]},"episodes":[{"no":1,"title":"","summary":"","scenes":[{"title":"","summary":"","slug":{"interior":"interior","location":"","timeOfDay":""},"beats":[{"kind":"video","prompt":"","dialogue":"角色名：台词"}]}]}]}`;
}

// 宽容解析改编结果：只要有一集能解析出场景就算成功（哪怕第 5 集塌了，前 4 集也是可用产出）；
// 解析不出来的集数如实带回 failures，让界面能说清「哪几集没出来」，而不是整体报失败让用户重跑全部。
export function parseAdapt(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const candidates = [];
  try { candidates.push(JSON.parse(text)); } catch { /* 落到逐个抠对象 */ }
  candidates.push(...extractJsonObjects(text));
  if (!candidates.length) {
    throw new Error(`改编返回的内容不是有效 JSON（开头：${text.slice(0, 80) || '(空)'}）`);
  }
  const failures = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const root = candidate.story || candidate.data || candidate.result || candidate;
    let eps = root.episodes ?? root.episode ?? [];
    if (!Array.isArray(eps)) eps = [eps];
    const episodes = [];
    for (const [i, e] of eps.entries()) {
      const scenes = cleanScenes(e?.scenes ?? e?.shots ?? e?.sceneList ?? [], { maxScenes: 40 });
      if (!scenes.length) { failures.push(`第 ${i + 1} 集无场次`); continue; }
      const no = Number(e?.no ?? e?.episode ?? e?.index);
      episodes.push({
        no: Number.isFinite(no) && no > 0 ? Math.round(no) : i + 1,
        title: firstString(e, ['title', 'name']) || `第 ${i + 1} 集`,
        summary: firstString(e, ['summary', 'description', 'synopsis']),
        scenes,
      });
    }
    if (episodes.length) {
      const overview = root?.overview && typeof root.overview === 'object' ? root.overview : {};
      const bibleSource = {
        ...(candidate.bible && typeof candidate.bible === 'object' ? candidate.bible : {}),
        ...(root.bible && typeof root.bible === 'object' ? root.bible : {}),
        ...(Array.isArray(overview.characters) ? { characters: overview.characters } : {}),
        ...(overview.style ? { style: overview.style } : {}),
      };
      return {
        episodes,
        overview: {
          logline: firstString(overview, ['logline', 'summary', 'synopsis']),
          relationships: (Array.isArray(overview.relationships) ? overview.relationships : [])
            .slice(0, 40)
            .map(r => ({
              from: firstString(r, ['from', 'a', 'left', 'name']),
              to: firstString(r, ['to', 'b', 'right', 'target']),
              note: firstString(r, ['note', 'relation', 'relationship', 'description']),
            }))
            .filter(r => r.from || r.to),
        },
        bible: cleanBible(bibleSource),
        episodeCount: episodes.length,
        sceneCount: episodes.reduce((n, e) => n + e.scenes.length, 0),
        beatCount: episodes.reduce((n, e) => n + e.scenes.reduce((m, s) => m + s.beats.length, 0), 0),
        failures,
      };
    }
    failures.push(`顶层键 ${Object.keys(root).slice(0, 8).join('/') || '无'}`);
  }
  throw new Error(`改编结果里没有任何能用的分集场景（试过 ${candidates.length} 个 JSON；${failures.slice(0, 6).join(' | ').slice(0, 140)}；原文开头：${text.slice(0, 120)}）`);
}
