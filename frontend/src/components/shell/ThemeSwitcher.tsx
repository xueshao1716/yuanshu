import { useEffect, useState } from 'react'
import { Palette } from 'lucide-react'
import { THEME_CATALOG, ACCENT_PRESETS as ACCENTS } from '../../theme/palettes'
import { applyTheme, currentTheme } from '../../theme/apply'
// 主题预设：data-theme 属性驱动（styles.css [data-theme] 变量覆盖）；色板定义在 theme/palettes.ts
// ⚠️ 08-26 单一真源：主色自定义 = generateTheme(seed) 派生整套色板写 CSS 变量（非只改 3 个），
//    与 WebglBackdrop 联动（派生后 --pi-accent/--pi-accent2 变化 → 背景自动跟随）

// 默认主题「晨雾」(mist)：08-26 用户拍板白色主色。一次性迁移：老默认 'deep' 自动切到 mist（打标记后不再覆盖显式选择）
export default function ThemeSwitcher() {
  const [theme, setTheme] = useState(() => currentTheme().theme)
  const [accent, setAccent] = useState(() => currentTheme().accent)
  const [menuOpen, setMenuOpen] = useState(false)
  // 跨组件同步（08-29）：ThemesPage 改主题时广播 pi-theme-changed，这里同步 state 避免显示漂移
  useEffect(() => {
    const onExt = (e: Event) => {
      const d = (e as CustomEvent).detail || {}
      if (d.theme) setTheme(d.theme)
      if (typeof d.accent === 'string') setAccent(d.accent)
    }
    window.addEventListener('pi-theme-changed', onExt)
    return () => window.removeEventListener('pi-theme-changed', onExt)
  }, [])
  const selectTheme = (value: string) => applyTheme(value, accent)
  const selectAccent = (value: string) => applyTheme(theme, value)

  return (
    <div className="relative">
      {/* rail 风格触发器：与导航按钮同尺寸同交互；色板圆点显示当前主题色 */}
      <button aria-label="切换主题" title="主题"
        className="w-9 h-9 rounded-pi-md flex items-center justify-center relative text-pi-dim2 hover:text-pi-text hover:bg-pi-bg3 transition-colors"
        onClick={() => setMenuOpen(!menuOpen)}>
        <Palette className="w-[18px] h-[18px]" strokeWidth={1.8} />
        <span className="absolute bottom-1 right-1 w-2 h-2 rounded-full border border-pi-bg2"
          style={{ background: THEME_CATALOG.find(t => t.id === theme)?.swatch }} />
      </button>
      {menuOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
          <div className="absolute left-0 bottom-11 z-20 panel p-2 flex flex-col gap-1 w-44">
            <div className="text-[10px] text-pi-dim2 px-2 pt-0.5 pb-1 font-semibold">主题</div>
            {THEME_CATALOG.map(t => (
              <button key={t.id} className={`flex items-center gap-2 px-2 py-1.5 rounded-pi-sm hover:bg-pi-bg3 text-xs ${theme === t.id ? 'text-pi-text' : 'text-pi-dim'}`} onClick={() => selectTheme(t.id)}>
                <span className="w-4 h-4 rounded-full border border-pi-border" style={{ background: t.swatch }} />
                {t.name} {theme === t.id && <span className="ml-auto text-pi-accent">✓</span>}
              </button>
            ))}
            <div className="h-px bg-pi-border-soft my-1" />
            <div className="text-[10px] text-pi-dim2 px-2 pb-1 font-semibold">主色</div>
            <div className="flex gap-1.5 px-2 pb-1.5">
              {ACCENTS.map(a => (
                <button key={a.color} title={a.name}
                  className={`w-4 h-4 rounded-full transition-transform hover:scale-110 ${accent === a.color ? 'ring-2 ring-offset-1 ring-pi-text ring-offset-transparent' : ''}`}
                  style={{ background: a.color }} onClick={() => selectAccent(a.color)} />
              ))}
            </div>
            <div className="flex items-center gap-2 px-2 pb-1.5">
              <input type="color" aria-label="自定义主色" value={accent || ACCENTS[0].color}
                onChange={e => selectAccent(e.target.value)}
                className="w-8 h-6 rounded-pi-sm border border-pi-border-soft bg-transparent cursor-pointer p-0" />
              <input aria-label="主色 HEX" value={accent} placeholder="#4a58fa…"
                onChange={e => selectAccent(e.target.value)}
                className="flex-1 min-w-0 text-[10px] bg-pi-field border border-pi-border-soft rounded-pi-sm px-2 py-1 text-pi-text outline-none focus:border-pi-accent" />
            </div>
            <div className="h-px bg-pi-border-soft my-1" />
            <button className="w-full text-left px-2 py-1.5 text-[11px] text-pi-dim hover:text-pi-text hover:bg-pi-bg3 rounded-pi-sm transition-colors"
              onClick={() => { location.hash = '#/themes'; setMenuOpen(false) }}>
              编辑主题 →
            </button>
          </div>
        </>
      )}
    </div>
  )
}
