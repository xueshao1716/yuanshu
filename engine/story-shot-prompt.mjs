// engine/story-shot-prompt.mjs —— 镜头提示词编译器
//
// 为什么要有这个文件（2026-09-15，拿另一家产品的真实产物对照出来的）：
// 同样的视频模型，人家出片质感更好，差别不在模型，在**发什么给它**。
// 那边一个 4 秒镜头的提示词长这样（原文抄回来）：
//
//   全景，俯拍斜角机位。画面采用教室内窗外折射的柔和自然光，呈现温暖复古的色调与略带怀旧的压抑氛围，
//   具有90年代写实电影质感与轻微的胶片颗粒，使用35mm Panavision镜头。在 @云海一中教室-基础形象 的角落里，
//   @林小夏-基础形象 独自蜷缩在座位上，低头局促地整理着桌上的课本。镜头缓缓推近……
//   落幅定格在她落寞无助的侧脸。
//
// 而元枢此前把 beat.prompt（一段偏"描写"的散文）直接发出去，缺八样东西：
//   ① 摄影机语言前置（景别+机位）② 光线 ③ 色调 ④ 质感（胶片颗粒/镜头型号）
//   ⑤ 运镜 ⑥ **落幅**（这一镜最后定格在哪——镜头之间不跳的关键）
//   ⑦ **承接**（下一镜开头写明承接上一镜的落点）⑧ 全局负向约束（不要字幕/保留 BGM/禁止静音段）
//
// 所以这里做一件事：把已经结构化的字段（景别/机位/运镜/光线/色调/时长/落幅/承接）
// 加上风格库条目、`@资产` 引用，**按固定顺序编译成一条提示词**。
//
// 三条刻意的设计取舍：
//   1. **输出是散文，不是带标签的规格表**。视频模型吃的是一段话；
//      `【景别】全景` 这种写法是给人看的，写进提示词只会稀释画面描述。
//   2. **老项目也要受益**：没有结构化字段时，从散文里**认**出景别/运镜/落幅（见 inferShotFromProse），
//      而不是要求用户重新生成一遍分镜。
//   3. **认不出来就什么都不加**，绝不编造一个不存在的机位——宁缺勿编。

import { resolveColorCard, colorCardTone } from './color-cards.mjs';

// ── 风格库 ──
// 每条 = 这个风格"长什么样"的四句话：质感(look) / 光线(light) / 色调(tone) / 附带约束(tail)。
// 风格不是形容词堆砌：它要能落在"用什么镜头、什么颗粒、什么光比"上。
export const STYLE_LIBRARY = Object.freeze({
  realistic_90s_film: {
    name: '90年代写实电影风格', aliases: ['90年代', '九十年代'],
    look: '90年代写实电影质感，轻微胶片颗粒', light: '自然光为主，柔和不打轮廓光', tone: '温暖复古、略带怀旧',
    tail: '使用35mm 电影镜头',
  },
  realistic_modern_urban: {
    name: '现代都市写实风', aliases: ['现代都市写实'],
    look: '写实电影质感，画面干净', light: '自然光与实景灯光混合', tone: '冷暖平衡、克制',
  },
  realistic_hk_film: {
    name: '港风电影写实风', aliases: ['港风'],
    look: '港片质感，微微颗粒，高对比', light: '霓虹与街灯为光源，反差大', tone: '青绿偏冷、霓虹暖点缀',
  },
  realistic_kdrama_urban: {
    name: '韩剧都市写实风', aliases: ['韩剧', '韩系'],
    look: '柔焦电影质感，皮肤质感干净', light: '大面积柔光，弱阴影', tone: '低饱和、干净通透',
  },
  suspense_movie: {
    name: '悬疑电影风格', aliases: ['悬疑'],
    look: '电影质感，暗部保留细节', light: '侧逆光与局部光源，明暗对比强', tone: '冷调为主、局部暖色提示',
    tail: '尽量用固定镜头与缓慢运动制造压迫感',
  },
  bw_film_photography: {
    name: '黑白胶片摄影风格', aliases: ['黑白'],
    look: '黑白胶片质感，细颗粒，层次丰富', light: '硬光塑形，重光比', tone: '纯黑白，无彩色',
    tail: '画面内不要出现任何彩色元素',
  },
  blue_orange_cinematic: {
    name: '蓝橙色调影视风格', aliases: ['蓝橙'],
    look: '商业电影质感，锐利', light: '主光暖、环境冷', tone: '蓝橙互补，肤色暖、环境冷',
  },
  high_key_absurd: {
    name: '荒诞高调白色色调电影风格', aliases: ['高调', '荒诞'],
    look: '高调布光，几乎无阴影', light: '均匀漫射强光，过曝一点', tone: '大面积白与浅灰，低饱和',
  },
  japanese_documentary: {
    name: '是枝裕和日式纪实', aliases: ['日式纪实', '日系纪实'],
    look: '纪实质感，手持轻微晃动，自然颗粒', light: '全自然光，不打灯', tone: '安静、低饱和、通透',
    tail: '不要戏剧化打光与滤镜感',
  },
  retro_scifi_60s: {
    name: '60年代复古科幻', aliases: ['复古科幻'],
    look: '60年代科幻片质感，模型感与硬边造型', light: '硬光与彩色滤片', tone: '高饱和原色、复古印刷感',
  },
  horror_film: {
    name: '恐怖电影风格', aliases: ['恐怖'],
    look: '高对比电影质感，暗部压死', light: '单光源、大面积黑', tone: '冷绿/冷蓝，极少暖色',
  },
  costume_live_ancient: {
    name: '古装真人写实风', aliases: ['古装真人'],
    look: '实拍古装剧质感，布料与器物细节清楚', light: '烛火/天光为主，柔和', tone: '低饱和暖褐',
    tail: '服化道必须符合年代，不要出现现代物件',
  },
  xianxia_live_realistic: {
    name: '古风仙侠写实风', aliases: ['仙侠'],
    look: '电影级实拍仙侠质感，云雾体积光', light: '逆光勾边、体积光', tone: '青白为底、暖金点缀',
  },
  cg3d_ancient: {
    name: '3D写实CG古装风', aliases: ['3D古装', 'CG古装'],
    look: '3D写实CG渲染，材质与布料解算清晰', light: '三点布光 + 环境光遮蔽', tone: '沉稳古雅',
  },
  anime_2d_guofeng: {
    name: '2D古风国漫风', aliases: ['国漫', '古风动漫'],
    look: '2D国漫赛璐璐上色，线条干净', light: '平光 + 局部高光', tone: '雅致中国色',
  },
  anime_ghibli: {
    name: '宫崎骏画风', aliases: ['吉卜力'],
    look: '手绘动画质感，背景细节丰富', light: '柔和自然光，云隙光', tone: '清透高饱和',
  },
  anime_pixel: {
    name: '像素风', aliases: ['像素'],
    look: '像素点阵画面，边缘不带抗锯齿', light: '硬边明暗块', tone: '有限色板',
  },
  claymation: {
    name: '粘土动画风格', aliases: ['黏土', '定格'],
    look: '定格粘土质感，表面可见手工痕迹与指纹', light: '棚拍硬光，阴影清晰', tone: '温和的实物色',
    tail: '角色动作应是逐帧摆拍感，不要丝滑运镜',
  },
});

// 风格解析：认 code、认中文名、认别名；认不出来返回 null（**绝不硬塞一个默认风格**，
// 那样会把"用户没选风格"变成"系统替他选了一个"）。
export function resolveStyle(input) {
  const key = String(input || '').trim();
  if (!key) return null;
  if (STYLE_LIBRARY[key]) return { code: key, ...STYLE_LIBRARY[key] };
  const hit = Object.entries(STYLE_LIBRARY).find(([, s]) =>
    s.name === key || (s.aliases || []).some(a => key.includes(a)) || key.includes(s.name));
  return hit ? { code: hit[0], ...hit[1] } : null;
}

// ── 全局约束 ──
// 视频与图片要防的不是同一件事：视频怕的是"字幕/静音段"（生成出来就得返工），
// 图片怕的是"画面里冒出文字"（中文字形崩得最厉害的地方）。
export const GLOBAL_CONSTRAINTS = Object.freeze({
  video: ['画面内不要出现任何字幕或屏幕文字', '保留协调统一的 BGM 与环境音，禁止静音段'],
  image: ['画面内不要出现任何文字、字幕或水印'],
});

// ── 从散文里认结构化字段（老项目/旧分镜的补丁路）──
// 只认**明确写出来的词**，不猜。认到的字段会前置到提示词最前面——
// 这恰好是原句里最容易被后面一大段描写淹没的部分。
const SIZE_RE = /(大远景|大特写|中近景|中全景|全景|远景|中景|近景|特写|极特写)/;
const ANGLE_RE = /(俯拍斜角|俯拍|俯视|仰拍|仰视|平视|过肩|主观视角|主观镜头|斜角机位|齐腰机位|低角度|高角度)/;
const MOVE_RE = /(镜头缓缓推近|镜头缓慢推进|缓缓推近|缓慢推进|推近|拉远|后拉|摇镜|横移|平移|跟拍|跟镜|升降|环绕|手持|固定镜头|镜头固定|镜头保持不动)/;
const END_RE = /(落幅[^。；\n]{0,40})/;
const LIGHT_RE = /((?:自然光|逆光|侧光|顶光|暖光|冷光|霓虹|烛火|天光|柔光|硬光|窗光|夕照|晨光)[^。；\n]{0,20})/;

export function inferShotFromProse(text) {
  const s = String(text || '');
  return {
    size: s.match(SIZE_RE)?.[1] || '',
    angle: s.match(ANGLE_RE)?.[1] || '',
    move: s.match(MOVE_RE)?.[1] || '',
    ending: s.match(END_RE)?.[1] || '',
    light: s.match(LIGHT_RE)?.[1] || '',
  };
}

// beat（或分镜 JSON 的 shot 字段）→ 结构化镜头字段。
// 优先级：beat.shot 显式字段 > 从 beat.prompt 散文里认出来的 > 空。
export function shotFieldsFromBeat(beat = {}) {
  const explicit = beat?.shot && typeof beat.shot === 'object' ? beat.shot : {};
  const inferred = inferShotFromProse(beat?.prompt || beat?.action || '');
  const pick = key => String(explicit[key] ?? '').trim() || inferred[key] || '';
  const size = pick('size');
  // 老分镜常常把景别写在内容开头（「镜头特写：林默趴在…」）。景别一旦被提到句首，
  // 这个前缀就成了重复——真机验收时编出来是「特写。镜头特写：林默趴在…」，同一个词两遍。
  // 只削**开头那一个**（削完是空就还原，宁可重复也不能把内容吃没）。
  let content = String(beat?.prompt || beat?.action || '').trim();
  if (size && content.startsWith('镜头')) {
    const stripped = content.replace(new RegExp(`^(?:镜头|画面|摄影机)?\\s*${size}\\s*[：:，,。]?\\s*`), '').trim();
    if (stripped) content = stripped;
  }
  return {
    size, angle: pick('angle'), move: pick('move'),
    light: pick('light'), tone: pick('tone'), texture: pick('texture'),
    ending: pick('ending'), carry: String(explicit.carry ?? '').trim(),
    content,
    dialogue: String(beat?.dialogue || '').trim(),
  };
}

// 资产引用：`@名字` 或 `@名字-形象变体`。
// 为什么用 @：它把"这段画面里出现谁/哪个场景"从描述里**提出来变成可解析的引用**，
// 上游可以（也应当）据此挂参考图，人也一眼看得出挂没挂上。
export function assetRefsForShot({ bible = {}, scene = null, text = '', limit = 6 } = {}) {
  const hay = `${text} ${scene?.title || ''} ${scene?.summary || ''}`;
  const refs = [];
  const push = (name, variant, hasRef = false) => {
    const n = String(name || '').trim();
    if (!n || refs.some(r => r.name === n)) return;
    const v = String(variant || '').trim();
    refs.push({ name: n, variant: v, hasRef, ref: `@${n}${v ? `-${v}` : ''}` });
  };
  // 形象变体：这一段提到哪张形象就用哪张（「林默-战斗装束」或直接出现「战斗装束」），
  // 没提到就用基础形象。`looks` 是对象数组，别当成字符串拼——那会拼出 "[object Object]"。
  const lookOf = (item) => {
    const looks = Array.isArray(item?.looks) ? item.looks.filter(l => l?.name) : [];
    return looks.find(l => hay.includes(String(l.name))) || null;
  };
  const refImageOf = (item) => Boolean(item?.refImage || item?.ref || item?.portrait || item?.anchor || (Array.isArray(item?.looks) && item.looks.some(l => l?.refImage)));
  const lookNameOf = (item) => String(lookOf(item)?.name || '');
  // 只挂**名字真的出现在这一段里**的资产：全挂等于没挂（这一点在 pickBeatReferences 里已经吃过亏）
  for (const c of bible.characters || []) {
    if (hay.includes(String(c?.name || ''))) push(c.name, lookNameOf(c), refImageOf(c));
  }
  for (const l of bible.locations || []) {
    if (hay.includes(String(l?.name || '')) || scene?.title === l?.name) push(l.name, '', refImageOf(l));
  }
  for (const p of bible.props || []) {
    if (hay.includes(String(p?.name || ''))) push(p.name, '', refImageOf(p));
  }
  return refs.slice(0, limit);
}

// ── 编译 ──
// 输出顺序（照同行那份有效提示词的顺序，不再自创）：
//   ① 景别 + 机位  ② 光线  ③ 色调  ④ 质感/镜头  ⑤ 场景与人物动作（含 @引用）
//   ⑥ 运镜  ⑦ 落幅  ⑧ 承接  然后另起短行给 台词 / 全局约束 / 必须避免
export function compileShotPrompt({ style = null, shot = {}, refs = [], kind = 'video', durationSec = null, negative = '', colorCard = null } = {}) {
  const st = typeof style === 'string' ? resolveStyle(style) : style;
  const card = typeof colorCard === 'string' ? resolveColorCard(colorCard) : colorCard;
  const s = shot || {};
  const sent = [];
  const j = (...parts) => parts.map(p => String(p || '').trim()).filter(Boolean).join('，');

  // ① 景别 + 机位（这一句必须在最前）
  const framing = j(s.size, s.angle ? `${s.angle}机位` : '');
  if (framing) sent.push(`${framing}。`);
  // ②③④ 光线 / 色调 / 质感
  // 优先级：这一段显式写的 > 项目选的配色卡 > 风格库自带的色调。
  // 配色卡之所以排第二：它是用户**这一部戏**的选择，比风格的通用色调更具体；
  // 但段落自己写了 tone 就说明那一镜要破格，破格优先。
  const light = j(s.light || st?.light);
  const tone = j(s.tone || (card ? colorCardTone(card) : '') || st?.tone);
  const look = j(s.texture || st?.look, st?.tail);
  const lookParts = [light ? `画面采用${light}` : '', tone ? `呈现${tone}的色调` : '', look ? `具有${look}` : ''].filter(Boolean);
  if (lookParts.length) sent.push(`${lookParts.join('，')}。`);
  // ⑤ 场景与动作（@引用放在正文里，和同行一样）
  const sceneRef = refs.find(r => r.role === 'scene')?.ref || '';
  const body = String(s.content || '').trim();
  if (body) sent.push(sceneRef ? `在 ${sceneRef} 里，${body}` : body);
  else if (sceneRef) sent.push(`在 ${sceneRef} 里。`);
  // ⑥ 运镜
  if (s.move) sent.push(j(s.move).startsWith('镜头') ? `${s.move}。` : `镜头${s.move}。`);
  // ⑦ 落幅（镜头之间不跳的关键）
  if (s.ending) sent.push(/^落幅/.test(s.ending) ? `${s.ending}。` : `落幅${s.ending}。`);
  // ⑧ 承接
  if (s.carry) sent.push(`承接上一镜：${s.carry}。`);

  const head = sent.join('');
  const tail = [];
  if (kind === 'video' && s.dialogue) {
    tail.push(`【台词】${s.dialogue.split('\n').map(l => l.trim()).filter(Boolean).join(' / ')}`);
  }
  if (durationSec) tail.push(`【时长】${durationSec}s`);
  // 资产引用单独列一行：正文里的 @ 是给模型看的指代，这一行是给"挂参考图"用的清单，
  // 也让用户一眼看出这段挂了谁（正文里 @ 了但没挂图的，看这一行就知道）。
  if (refs.length) tail.push(`【资产引用】${refs.map(r => `${r.ref}${r.hasRef ? '' : '（未挂参考图）'}`).join('、')}`);
  const globals = GLOBAL_CONSTRAINTS[kind] || GLOBAL_CONSTRAINTS.video;
  if (globals?.length) tail.push(`【全局约束】${globals.join('；')}`);
  const neg = String(negative || '').trim();
  if (neg) tail.push(`【必须避免】${neg.split(/[\n；;]+/).map(x => x.trim()).filter(Boolean).join('；')}`);

  return [head, ...tail].filter(Boolean).join('\n');
}

// 把 refs 分成"场景引用"和"人物/道具引用"，供编译器决定 @场景 放在句首
export function splitRefs(refs = [], sceneName = '') {
  const out = [];
  for (const r of refs) out.push({ ...r, role: sceneName && r.name === sceneName ? 'scene' : 'character' });
  return out;
}

// 面向人的一行说明（界面提示用）：这次编译到底补上了什么
export function describeShotCompile({ style = null, shot = {}, refs = [], colorCard = null } = {}) {
  const st = typeof style === 'string' ? resolveStyle(style) : style;
  const card = typeof colorCard === 'string' ? resolveColorCard(colorCard) : colorCard;
  const bits = [];
  if (st) bits.push(`风格：${st.name}`);
  if (card) bits.push(`配色：${card.name}（${card.top} → ${card.bottom}）`);
  for (const [k, label] of [['size', '景别'], ['angle', '机位'], ['move', '运镜'], ['light', '光线'], ['ending', '落幅'], ['carry', '承接']]) {
    if (String(shot?.[k] || '').trim()) bits.push(`${label}：${shot[k]}`);
  }
  if (refs.length) bits.push(`资产引用 ${refs.length} 个：${refs.map(r => r.ref).join('、')}`);
  return bits;
}
