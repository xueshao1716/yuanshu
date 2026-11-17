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
// 2026-11-17：收成 5 个（浅色 3 + 深色 2）；牛皮纸/竹影/拟木并入水墨，墨黑/紫晶/褐纱/苔原/远岚并入曜石（见 THEME_ALIASES）
export const THEME_CATALOG = [
  { id: 'liquid-glass', name: '液态玻璃', desc: '浅色 · Apple 风格半透明', swatch: 'linear-gradient(135deg,#eef4fb 0%,#b9d6ff 48%,#d9c7ff 100%)', light: true },
  { id: 'mist', name: '晨雾', desc: '浅色 · 冷靛蓝主色', swatch: 'linear-gradient(135deg,#f3f5fa,#ffffff)', light: true },
  { id: 'shuimo', name: '水墨', desc: '浅色 · 宣纸朱砂楷体', swatch: 'linear-gradient(135deg,#f7f4ec,#b54334)', light: true },
  { id: 'obsidian', name: '曜石', desc: '深色 · 旗舰克制（Linear 风）', swatch: 'linear-gradient(135deg,#0f1117 0%,#1a1d27 60%,#5e6ad2 100%)' },
  { id: 'bridge', name: '舰桥', desc: '深色 · 冰青 HUD 科幻', swatch: 'linear-gradient(135deg,#060a11 0%,#0d1b2a 55%,#2fd3e6 100%)' },
] as const
export const THEME_PRESETS = THEME_CATALOG
export const ACCENT_PRESETS = [
  { name: '靛蓝', color: '#4a58fa' },
  { name: '紫罗兰', color: '#8b7cf6' },
  { name: '天蓝', color: '#38bdf8' },
  { name: '翡翠', color: '#34d399' },
  { name: '琥珀', color: '#f59e0b' },
]
