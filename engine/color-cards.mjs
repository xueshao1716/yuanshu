// engine/color-cards.mjs —— 配色卡（莫兰迪「高级灰」9 组）
//
// 这是配色卡**唯一的数据源**：主题页（前端把它套成壁纸渐变）与创作流（把「色调」写进
// 分镜/画面提示词）都读这一份。分成两份抄的下场必然是漂移——一边改了一位数字，另一边照旧。
//
// 色值不是"看着像"估的：把用户给的色卡图里每条色值标签裁出来放大逐条读，再用卡片四角的
// 像素采样交叉校验，两读一致才落盘（tests/unit/wallpaper.test.mjs 把这 9 组钉死）。
// 规律：9 张都是**竖向渐变（上深下浅）**、色相差很小、明度差拉满。
// 第 3 张的标签顺序和渐变方向相反（图上就是灰在上、米在下），所以卡片单独带 top/bottom，
// 不要拿 from/to 想当然当渐变两端。

// 一句"这套色长什么样"的公共约束：配色卡的价值一半在色值，一半在这句"别画成什么样"。
const CARD_RULE = '低饱和、色相差小、明度差大；不要荧光色与高饱和撞色，也不要脏灰';

export const COLOR_CARDS = Object.freeze([
  { id: 'morandi-blue-sand', name: '蓝沙米', from: '#5D9AB4', to: '#F5D7C4', top: '#5D9AB4', bottom: '#F5D7C4', aliases: ['蓝沙', '雾蓝米'], tone: '低饱和莫兰迪灰调，雾蓝 #5D9AB4 过渡到米沙 #F5D7C4，竖向渐变、上深下浅' },
  { id: 'morandi-deep-teal', name: '深蓝加青', from: '#324263', to: '#B0E4ED', top: '#324263', bottom: '#B0E4ED', aliases: ['深蓝', '加青'], tone: '深蓝 #324263 过渡到浅青 #B0E4ED，竖向渐变、上深下浅，冷调低饱和' },
  { id: 'morandi-gray-cream', name: '灰得很高级', from: '#FCE5D7', to: '#728B9A', top: '#728B9A', bottom: '#FCE5D7', aliases: ['灰蓝米', '高级灰'], tone: '灰蓝 #728B9A 过渡到奶油米 #FCE5D7，竖向渐变、上深下浅，高级灰' },
  { id: 'morandi-mist-blue', name: '雾蓝粉', from: '#5B83B8', to: '#FFD4EA', top: '#5B83B8', bottom: '#FFD4EA', aliases: ['蓝粉', '雾蓝'], tone: '雾蓝 #5B83B8 过渡到浅粉 #FFD4EA，竖向渐变、上深下浅，低饱和' },
  { id: 'morandi-violet-pink', name: '蓝紫粉', from: '#6453A1', to: '#FDDCE4', top: '#6453A1', bottom: '#FDDCE4', aliases: ['紫粉', '蓝紫'], tone: '蓝紫 #6453A1 过渡到浅粉 #FDDCE4，竖向渐变、上深下浅，低饱和' },
  { id: 'morandi-lilac-milk', name: '紫灰米', from: '#72749A', to: '#FFF5DF', top: '#72749A', bottom: '#FFF5DF', aliases: ['灰紫米', '紫米'], tone: '灰紫 #72749A 过渡到奶米 #FFF5DF，竖向渐变、上深下浅' },
  { id: 'morandi-rose-blue', name: '玫瑰雾蓝', from: '#D693A1', to: '#E2F5FF', top: '#D693A1', bottom: '#E2F5FF', aliases: ['玫瑰蓝', '粉雾蓝'], tone: '玫瑰粉 #D693A1 过渡到浅雾蓝 #E2F5FF，竖向渐变、上深下浅' },
  { id: 'morandi-pink-rice', name: '粉红加米', from: '#E16668', to: '#FFF4DD', top: '#E16668', bottom: '#FFF4DD', aliases: ['粉米', '粉红米'], tone: '珊瑚粉 #E16668 过渡到米白 #FFF4DD，竖向渐变、上深下浅，低饱和' },
  { id: 'morandi-taupe-cream', name: '灰褐米', from: '#BA8D8E', to: '#FAF2D9', top: '#BA8D8E', bottom: '#FAF2D9', aliases: ['灰褐', '褐米'], tone: '灰褐 #BA8D8E 过渡到米黄 #FAF2D9，竖向渐变、上深下浅' },
]);

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

// 主题页用的 CSS：一律竖向（180deg），和原图一致。
export function colorCardGradient(card) {
  if (!card || !card.top || !card.bottom) return '';
  return `linear-gradient(180deg, ${card.top} 0%, ${card.bottom} 100%)`;
}

// 给镜头提示词的「色调」槽（compileShotPrompt）。
export function colorCardTone(card) {
  const c = typeof card === 'string' ? resolveColorCard(card) : card;
  return c ? String(c.tone || '').trim() : '';
}

// 给模型看的配色块（compileStoryPrompt）：画面/视频生成前，模型先看到这条。
export function colorCardPromptBlock(card) {
  const c = typeof card === 'string' ? resolveColorCard(card) : card;
  if (!c) return '';
  return `## 配色方案（莫兰迪高级灰 · ${c.name}）
- 主色 ${c.top} → 浅底 ${c.bottom}；竖向渐变、上深下浅，画面整体按这套色走
- 约束：${CARD_RULE}`;
}

// 给分镜师的一段话（buildStoryboardPrompt）：让 shot.tone 一开始就按配色写，
// 而不是等生成时再被覆盖——分镜里写歪了，后面锁色只是打补丁。
export function colorCardStoryboardNote(card) {
  const c = typeof card === 'string' ? resolveColorCard(card) : card;
  if (!c) return '';
  return `【本片配色】莫兰迪高级灰 · ${c.name}（${c.top} → ${c.bottom}，竖向渐变、上深下浅）。每段 shot.tone 都按这套色写：${CARD_RULE}。`;
}
