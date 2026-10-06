// 语义色板（08-23 颜色契约：组件内禁止裸 hex，统一从这里取）
export const TOOL_COLORS: Record<string, string> = {
  bash: '#34d399',
  read: '#38bdf8',
  write: '#f59e0b',
  edit: '#f59e0b',
}
export const COLOR_ERROR = '#ef4444'
export const COLOR_TOOL_FALLBACK = '#c084fc'
export const ACCENT_LIGHT = '#6b7dff' // 靛蓝在浅色主题下的提亮变体

// 切换器与主题页共用这一份目录；highLum/deep 仍可经 SEEDS 应用，只是不再单独陈列
export const THEME_CATALOG = [
  { id: 'mist', name: '晨雾', desc: '浅色 · 冷靛蓝主色', swatch: 'linear-gradient(135deg,#f3f5fa,#ffffff)', light: true },
  { id: 'kraft', name: '牛皮纸', desc: '浅色 · 纤维纸面火漆橙', swatch: 'linear-gradient(135deg,#e5d4aa,#b45309)', light: true },
  { id: 'shuimo', name: '水墨', desc: '浅色 · 宣纸朱砂楷体', swatch: 'linear-gradient(135deg,#f7f4ec,#b54334)', light: true },
  { id: 'bamboo', name: '竹影', desc: '浅色 · 竹青自然系', swatch: 'linear-gradient(135deg,#f1f5ec,#3f7a50)', light: true },
  { id: 'wood', name: '拟木', desc: '浅色 · 枫木台面翠绿镶嵌', swatch: 'linear-gradient(135deg,#e8d4b2,#0b8a54)', light: true },
  { id: 'ink', name: '墨黑', desc: '深色 · 极简石墨', swatch: 'linear-gradient(135deg,#000,#1a1a1f)' },
  { id: 'violet', name: '紫晶', desc: '深色 · 紫罗兰光晕', swatch: 'linear-gradient(135deg,#0d0a1a,#251d52)' },
  { id: 'sepia', name: '褐纱', desc: '深色 · 暖褐护眼', swatch: 'linear-gradient(135deg,#171310,#d97706)' },
  { id: 'moss', name: '苔原', desc: '深色 · 苔绿自然系', swatch: 'linear-gradient(135deg,#0c120e,#3f9e6e)' },
  { id: 'azure', name: '远岚', desc: '深色 · 天青蓝调', swatch: 'linear-gradient(135deg,#0a101c,#38bdf8)' },
  { id: 'bridge', name: '舰桥', desc: '深色 · 冰青 HUD 科幻', swatch: 'linear-gradient(135deg,#060a11 0%,#0d1b2a 55%,#2fd3e6 100%)' },
  { id: 'liquid-glass', name: '液态玻璃', desc: '浅色 · Apple 风格半透明', swatch: 'linear-gradient(135deg,#eef4fb 0%,#b9d6ff 48%,#d9c7ff 100%)', light: true },
] as const
export const THEME_PRESETS = THEME_CATALOG
export const ACCENT_PRESETS = [
  { name: '靛蓝', color: '#4a58fa' },
  { name: '紫罗兰', color: '#8b7cf6' },
  { name: '天蓝', color: '#38bdf8' },
  { name: '翡翠', color: '#34d399' },
  { name: '琥珀', color: '#f59e0b' },
]
