// engine/color-cards.mjs —— 配色卡（两套 18 组）
//
// 这是配色卡**唯一的数据源**：主题页（壁纸/全局创作配色）与创作流（把「色调」写进提示词）
// 都读这一份。分成两份抄的下场必然是漂移——一边改了一位数字，另一边照旧。
//
// 两套卡：
//   morandi —— 莫兰迪「高级灰」9 组：低饱和、色相差小、明度差大，上深下浅。
//   vivid   —— 高饱和渐变 9 组：亮、撞色、明快（"红配绿"那张就在这套里）。
//
// 色值不是"看着像"估的：把色卡图里每条色值标签裁出来放大逐条读，再用卡片四角的像素采样
// 交叉校验，两读一致才落盘（tests/unit/color-cards.test.mjs 把 18 组逐字钉死）。
// 标签顺序≠渐变方向：莫兰迪第 3 张（灰得很高级）图上就是灰在上、米在下，所以每张卡单独带
// top/bottom，不要拿 from/to 想当然当渐变两端。

// 每套一句"这套色长什么样"，也是"别画成什么样"：配色卡的价值一半在色值，一半在这句约束。
export const CARD_FAMILIES = Object.freeze({
  morandi: {
    id: 'morandi', name: '莫兰迪高级灰', short: '高级灰',
    rule: '低饱和、色相差小、明度差大；不要荧光色与高饱和撞色，也不要脏灰',
  },
  vivid: {
    id: 'vivid', name: '高饱和渐变', short: '高饱和',
    rule: '高饱和、明快、敢于撞色；不要灰蒙蒙的脏色，也不要低饱和的高级灰',
  },
})

export const MORANDI_CARDS = Object.freeze([
  { id: 'morandi-blue-sand', family: 'morandi', name: '蓝沙米', from: '#5D9AB4', to: '#F5D7C4', top: '#5D9AB4', bottom: '#F5D7C4', aliases: ['蓝沙', '雾蓝米'], tone: '低饱和莫兰迪灰调，雾蓝 #5D9AB4 过渡到米沙 #F5D7C4，竖向渐变、上深下浅' },
  { id: 'morandi-deep-teal', family: 'morandi', name: '深蓝加青', from: '#324263', to: '#B0E4ED', top: '#324263', bottom: '#B0E4ED', aliases: ['深蓝', '加青'], tone: '深蓝 #324263 过渡到浅青 #B0E4ED，竖向渐变、上深下浅，冷调低饱和' },
  { id: 'morandi-gray-cream', family: 'morandi', name: '灰得很高级', from: '#FCE5D7', to: '#728B9A', top: '#728B9A', bottom: '#FCE5D7', aliases: ['灰蓝米', '高级灰'], tone: '灰蓝 #728B9A 过渡到奶油米 #FCE5D7，竖向渐变、上深下浅，高级灰' },
  { id: 'morandi-mist-blue', family: 'morandi', name: '雾蓝粉', from: '#5B83B8', to: '#FFD4EA', top: '#5B83B8', bottom: '#FFD4EA', aliases: ['蓝粉', '雾蓝'], tone: '雾蓝 #5B83B8 过渡到浅粉 #FFD4EA，竖向渐变、上深下浅，低饱和' },
  { id: 'morandi-violet-pink', family: 'morandi', name: '蓝紫粉', from: '#6453A1', to: '#FDDCE4', top: '#6453A1', bottom: '#FDDCE4', aliases: ['紫粉', '蓝紫'], tone: '蓝紫 #6453A1 过渡到浅粉 #FDDCE4，竖向渐变、上深下浅，低饱和' },
  { id: 'morandi-lilac-milk', family: 'morandi', name: '紫灰米', from: '#72749A', to: '#FFF5DF', top: '#72749A', bottom: '#FFF5DF', aliases: ['灰紫米', '紫米'], tone: '灰紫 #72749A 过渡到奶米 #FFF5DF，竖向渐变、上深下浅' },
  { id: 'morandi-rose-blue', family: 'morandi', name: '玫瑰雾蓝', from: '#D693A1', to: '#E2F5FF', top: '#D693A1', bottom: '#E2F5FF', aliases: ['玫瑰蓝', '粉雾蓝'], tone: '玫瑰粉 #D693A1 过渡到浅雾蓝 #E2F5FF，竖向渐变、上深下浅' },
  { id: 'morandi-pink-rice', family: 'morandi', name: '粉红加米', from: '#E16668', to: '#FFF4DD', top: '#E16668', bottom: '#FFF4DD', aliases: ['粉米', '粉红米'], tone: '珊瑚粉 #E16668 过渡到米白 #FFF4DD，竖向渐变、上深下浅，低饱和' },
  { id: 'morandi-taupe-cream', family: 'morandi', name: '灰褐米', from: '#BA8D8E', to: '#FAF2D9', top: '#BA8D8E', bottom: '#FAF2D9', aliases: ['灰褐', '褐米'], tone: '灰褐 #BA8D8E 过渡到米黄 #FAF2D9，竖向渐变、上深下浅' },
])

export const VIVID_CARDS = Object.freeze([
  { id: 'vivid-rose-ice', family: 'vivid', name: '粉青', from: '#FF768D', to: '#E5FFFD', top: '#FF768D', bottom: '#E5FFFD', aliases: ['粉的很', '玫瑰冰青'], tone: '高饱和玫粉 #FF768D 过渡到冰青 #E5FFFD，竖向渐变，明快通透' },
  { id: 'vivid-blue-cream', family: 'vivid', name: '蓝紫奶油', from: '#5E6BFF', to: '#FFFEDA', top: '#5E6BFF', bottom: '#FFFEDA', aliases: ['深邃梦幻', '蓝紫奶油'], tone: '高饱和蓝紫 #5E6BFF 过渡到奶油黄 #FFFEDA，竖向渐变，冷暖对撞' },
  { id: 'vivid-teal-cream', family: 'vivid', name: '青蓝奶油', from: '#1899B6', to: '#FFFCCD', top: '#1899B6', bottom: '#FFFCCD', aliases: ['好治愈', '青蓝'], tone: '青蓝 #1899B6 过渡到奶黄 #FFFCCD，竖向渐变，清爽治愈' },
  { id: 'vivid-sky-linen', family: 'vivid', name: '天蓝米白', from: '#30A9FF', to: '#FFF4E3', top: '#30A9FF', bottom: '#FFF4E3', aliases: ['天蓝', '很开门'], tone: '亮天蓝 #30A9FF 过渡到米白 #FFF4E3，竖向渐变，明快干净' },
  { id: 'vivid-orange-ice', family: 'vivid', name: '橙青撞色', from: '#F5600F', to: '#E2FFFD', top: '#F5600F', bottom: '#E2FFFD', aliases: ['被吹爆', '橙青'], tone: '高饱和橙 #F5600F 过渡到冰青 #E2FFFD，竖向渐变，橙青互补撞色' },
  { id: 'vivid-violet-pink', family: 'vivid', name: '紫粉', from: '#5D62CC', to: '#FFDDDD', top: '#5D62CC', bottom: '#FFDDDD', aliases: ['超唯美', '蓝紫粉'], tone: '蓝紫 #5D62CC 过渡到浅粉 #FFDDDD，竖向渐变，唯美通透' },
  { id: 'vivid-green-pink', family: 'vivid', name: '绿粉撞色', from: '#18B670', to: '#FFD0D0', top: '#18B670', bottom: '#FFD0D0', aliases: ['高级感', '绿粉'], tone: '高饱和绿 #18B670 过渡到浅粉 #FFD0D0，竖向渐变，红绿撞色' },
  { id: 'vivid-magenta-ice', family: 'vivid', name: '品红冰蓝', from: '#B61877', to: '#DDFEFF', top: '#B61877', bottom: '#DDFEFF', aliases: ['没想到', '品红'], tone: '品红 #B61877 过渡到冰蓝 #DDFEFF，竖向渐变，浓艳对撞' },
  { id: 'vivid-red-green', family: 'vivid', name: '红绿撞色', from: '#FF3730', to: '#D2FFD2', top: '#FF3730', bottom: '#D2FFD2', aliases: ['红配绿', '不敢想'], tone: '正红 #FF3730 过渡到浅绿 #D2FFD2，竖向渐变，红绿撞色、胆子大' },
])

export const COLOR_CARDS = Object.freeze([...MORANDI_CARDS, ...VIVID_CARDS])

// 认 id、认中文名、认别名；**认不出来返回 null**——绝不硬塞一个默认配色，
// 那会把"用户没选配色"变成"系统替他选了一套"。
export function resolveColorCard(input) {
  if (!input) return null;
  if (typeof input === 'object') {
    const id = String(input.id || '').trim();
    return COLOR_CARDS.find(c => c.id === id) || null;
  }
  const key = String(input).trim();
  if (!key) return null;
  const exact = COLOR_CARDS.find(c => c.id === key || c.name === key);
  if (exact) return exact;
  return COLOR_CARDS.find(c => (c.aliases || []).some(a => key.includes(a)) || key.includes(c.name)) || null;
}

// 这一套的公共约束（"别画成什么样"）
export function colorCardRule(card) {
  const c = typeof card === 'string' ? resolveColorCard(card) : card;
  return c ? String(CARD_FAMILIES[c.family]?.rule || '').trim() : '';
}

// 主题页/壁纸用的 CSS：一律竖向（180deg），和原图一致。
export function colorCardGradient(card) {
  if (!card || !card.top || !card.bottom) return '';
  return `linear-gradient(180deg, ${card.top} 0%, ${card.bottom} 100%)`;
}

// 给镜头提示词的「色调」槽（compileShotPrompt）。
export function colorCardTone(card) {
  const c = typeof card === 'string' ? resolveColorCard(card) : card;
  return c ? String(c.tone || '').trim() : '';
}

// 直接发给生图/生视频模型的一行（它们吃的是提示词，不是文档）。
export function colorCardStyleLine(card) {
  const c = typeof card === 'string' ? resolveColorCard(card) : card;
  if (!c) return '';
  const rule = colorCardRule(c);
  return rule ? `${c.tone}；${rule}` : c.tone;
}

// 给模型看的配色块（compileStoryPrompt）：画面/视频生成前，模型先看到这条。
export function colorCardPromptBlock(card) {
  const c = typeof card === 'string' ? resolveColorCard(card) : card;
  if (!c) return '';
  const family = CARD_FAMILIES[c.family]?.name || '配色';
  return `## 配色方案（${family} · ${c.name}）
- 主色 ${c.top} → 浅底 ${c.bottom}；竖向渐变、上深下浅，画面整体按这套色走
- 约束：${colorCardRule(c)}`;
}

// 给分镜师的一段话（buildStoryboardPrompt）：让 shot.tone 一开始就按配色写，
// 而不是等生成时再被覆盖——分镜里写歪了，后面锁色只是打补丁。
export function colorCardStoryboardNote(card) {
  const c = typeof card === 'string' ? resolveColorCard(card) : card;
  if (!c) return '';
  const family = CARD_FAMILIES[c.family]?.name || '配色';
  return `【本片配色】${family} · ${c.name}（${c.top} → ${c.bottom}，竖向渐变、上深下浅）。每段 shot.tone 都按这套色写：${colorCardRule(c)}。`;
}

// 提示词里是否已经带过配色（避免"故事层写了一次、媒体层又追加一次"）
export function hasColorCardMark(prompt) {
  return /##\s*配色方案|【本片配色】/.test(String(prompt || ''));
}
