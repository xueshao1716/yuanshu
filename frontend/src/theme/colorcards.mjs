// 莫兰迪「高级灰」配色卡（2026-09-16 用户给的色卡图，9 组）。
//
// 色值不是"看着像"估的：把图里每条色值标签裁出来放大逐条读，再用卡片四角的像素采样交叉
// 校验，两读一致才写进来。这 9 张的共同规律——**竖向渐变（上深下浅）**、色相差很小、
// 明度差拉满，所以看起来"高级"。第 3 张的标签顺序和渐变方向相反（图上就是右边那个色在上面），
// 所以卡片单独带 top/bottom，不要拿 from/to 想当然当渐变两端。
//
// 交给 wallpaperCssImage 之前保持是 `linear-gradient(...)` 字面量：渐变是 background-image
// 函数，一旦被包进 url() 就是非法 CSS，点了等于没设（见 tests/unit/wallpaper.test.mjs）。
export const MORANDI_CARDS = [
  { id: 'morandi-blue-sand', name: '蓝沙米', from: '#5D9AB4', to: '#F5D7C4', top: '#5D9AB4', bottom: '#F5D7C4' },
  { id: 'morandi-deep-teal', name: '深蓝加青', from: '#324263', to: '#B0E4ED', top: '#324263', bottom: '#B0E4ED' },
  { id: 'morandi-gray-cream', name: '灰得很高级', from: '#FCE5D7', to: '#728B9A', top: '#728B9A', bottom: '#FCE5D7' },
  { id: 'morandi-mist-blue', name: '雾蓝粉', from: '#5B83B8', to: '#FFD4EA', top: '#5B83B8', bottom: '#FFD4EA' },
  { id: 'morandi-violet-pink', name: '蓝紫粉', from: '#6453A1', to: '#FDDCE4', top: '#6453A1', bottom: '#FDDCE4' },
  { id: 'morandi-lilac-milk', name: '紫灰米', from: '#72749A', to: '#FFF5DF', top: '#72749A', bottom: '#FFF5DF' },
  { id: 'morandi-rose-blue', name: '玫瑰雾蓝', from: '#D693A1', to: '#E2F5FF', top: '#D693A1', bottom: '#E2F5FF' },
  { id: 'morandi-pink-rice', name: '粉红加米', from: '#E16668', to: '#FFF4DD', top: '#E16668', bottom: '#FFF4DD' },
  { id: 'morandi-taupe-cream', name: '灰褐米', from: '#BA8D8E', to: '#FAF2D9', top: '#BA8D8E', bottom: '#FAF2D9' },
]

// 墙上那层用的 CSS：一律竖向（180deg），和原图一致。
export function colorCardGradient(card) {
  if (!card || !card.top || !card.bottom) return ''
  return `linear-gradient(180deg, ${card.top} 0%, ${card.bottom} 100%)`
}
