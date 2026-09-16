import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Code2, Download, RotateCcw, Trash2, Upload } from 'lucide-react'
import { generateTheme, SEEDS } from '../theme/generate.mjs'
import { applyTheme, currentTheme } from '../theme/apply'
import { persistWallpaper, currentWallpaper } from '../theme/wallpaper.mjs'
import { COLOR_CARDS, CARD_FAMILIES, colorCardGradient, resolveColorCard } from '../theme/colorcards.mjs'
import { THEME_CATALOG } from '../theme/palettes'
import { ThemeApi, ColorApi } from '../api'
import PageHeader from '../components/PageHeader'
import SectionHeader from '../components/SectionHeader'
import { toast } from '../components/Toast'

type Seed = { bg: string; text: string; accent: string; step: number; light?: boolean; overrides?: Record<string, string> }

const THEME_BY_ID = Object.fromEntries(THEME_CATALOG.map(t => [t.id, t]))

const ACCENT_SWATCHES = ['#5468ff', '#8b7cf6', '#38bdf8', '#34d399', '#f59e0b', '#f47067', '#ec4899', '#d97706']

const WALL_PRESETS = [
  { label: '无', value: '' },
  { label: '深空', value: 'linear-gradient(135deg, #0a0a1a 0%, #1a1a3e 50%, #0a0a1a 100%)' },
  { label: '极光', value: 'linear-gradient(135deg, #0d1117 0%, #161b22 30%, #1a3a4a 60%, #0d1117 100%)' },
  { label: '暮光', value: 'linear-gradient(180deg, #1a0a2e 0%, #2d1b4e 40%, #4a1942 70%, #1a0a2e 100%)' },
  { label: '暖纸', value: 'linear-gradient(135deg, #f5e6d3 0%, #e8d5b7 50%, #f0e0c8 100%)' },
]

function seedVars(theme: string, accentOverride = '', stepOverride = 0): Record<string, string> {
  const seed = (SEEDS as any)[theme] as Seed
  if (!seed) return {}
  const s = { ...seed, accent: accentOverride || seed.accent }
  if (stepOverride > 0) s.step = stepOverride
  return generateTheme(s) as Record<string, string>
}

function ThemeCard({ id, active, onApply }: { id: string; active: boolean; onApply: () => void }) {
  const vars = useMemo(() => seedVars(id), [id])
  const meta = THEME_BY_ID[id] || { name: id, desc: '' }
  const seed = (SEEDS as any)[id] as Seed

  return (
    <button
      type="button"
      onClick={onApply}
      aria-pressed={active}
      className={`relative overflow-hidden rounded-pi-lg border text-left transition-[border-color,box-shadow,transform] ${active ? 'border-pi-accent ring-2 ring-pi-accent/30' : 'border-pi-border hover:border-pi-border-hi'}`}
      style={vars as any}
    >
      <div className="h-24 p-3 flex flex-col gap-1.5" style={{ background: 'var(--pi-bg)' }}>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full" style={{ background: 'var(--pi-green)' }} />
          <span className="w-2 h-2 rounded-full" style={{ background: 'var(--pi-yellow)' }} />
          <span className="w-2 h-2 rounded-full" style={{ background: 'var(--pi-red)' }} />
          <span className="ml-auto text-[11px]" style={{ color: 'var(--pi-dim)', fontFamily: 'var(--pi-font-mono)' }}>{id}</span>
        </div>
        <div className="self-start max-w-[80%] px-2.5 py-1 text-[11px] rounded-pi-md" style={{ background: 'var(--pi-bg2)', color: 'var(--pi-text)' }}>
          你好，小语在
        </div>
        {/* 预览气泡的前景必须走 on-accent：写死 --pi-bg 在 kraft/wood/liquid-glass 上
            只有 3.0~3.85，11px 小字读不清（真机逐元素量出来的）。 */}
        <div className="self-end max-w-[80%] px-2.5 py-1 text-[11px] rounded-pi-md" style={{ background: 'var(--pi-accent)', color: 'var(--pi-on-accent)' }}>
          切到这个主题
        </div>
      </div>
      <div className="px-3 py-2 flex items-center gap-2" style={{ background: 'var(--pi-bg1)', borderTop: '1px solid var(--pi-border)' }}>
        <span className="w-3.5 h-3.5 rounded-full flex-shrink-0" style={{ background: seed?.accent }} />
        <span className="text-[13px] font-medium" style={{ color: 'var(--pi-text)' }}>{meta.name}</span>
        <span className="text-[11px] truncate" style={{ color: 'var(--pi-dim2)' }}>{meta.desc}</span>
        {active && (
          <span className="ml-auto flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-pi-sm flex-shrink-0" style={{ background: 'var(--pi-accent-soft)', color: 'var(--pi-accent-soft-fg)' }}>
            <Check className="w-3 h-3" aria-hidden="true" />当前
          </span>
        )}
      </div>
    </button>
  )
}

export default function Themes() {
  const init = useRef(currentTheme())
  const [theme, setTheme] = useState(init.current.theme)
  const [accent, setAccent] = useState(init.current.accent)
  const [density, setDensity] = useState<number>(() => ((SEEDS as any)[init.current.theme]?.step) || 0.043)
  const [wallpaper, setWallpaper] = useState(() => currentWallpaper())
  // 全局创作配色卡：服务端一份，所有出图/出片入口共用（项目要单独覆盖在项目里指定）
  const [colorCardId, setColorCardId] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    ColorApi.get().then(r => setColorCardId(r?.colorCardId || '')).catch(() => {})
  }, [])
  const saveColorCard = async (id: string) => {
    const prev = colorCardId
    setColorCardId(id) // 先反馈，再落盘；失败回滚并说清
    try {
      const r = await ColorApi.save(id)
      setColorCardId(r?.colorCardId ?? '')
      toast(r?.colorCardId ? `创作配色已保存：所有出图/出片都会按「${resolveColorCard(r.colorCardId)?.name || r.colorCardId}」写色调` : '已取消创作配色', 'ok')
    } catch {
      setColorCardId(prev)
      toast('配色保存失败', 'error')
    }
  }

  // AppLayout owns remote hydration; this page only applies explicit edits.
  const selectTheme = (next: string) => { setTheme(next); applyTheme(next, accent) }
  const selectAccent = (next: string) => { setAccent(next); applyTheme(theme, next) }
  useEffect(() => {
    const onExt = (e: Event) => {
      const detail = (e as CustomEvent).detail || {}
      if (detail.theme) setTheme(detail.theme)
      if (typeof detail.accent === 'string') setAccent(detail.accent)
    }
    window.addEventListener('pi-theme-changed', onExt)
    return () => window.removeEventListener('pi-theme-changed', onExt)
  }, [])
  useEffect(() => {
    const s = (SEEDS as any)[theme] as Seed
    if (s) setDensity(s.step ?? 0.043)
  }, [theme])

  useEffect(() => {
    const vars = seedVars(theme, accent, density)
    const el = document.documentElement as any
    for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v)
  }, [theme, accent, density])

  useEffect(() => {
    const saved = persistWallpaper(wallpaper)
    if (!saved.ok && wallpaper.startsWith('data:')) toast('图片太大，浏览器存不下。请改用较小的图或填 URL。', 'error')
  }, [wallpaper])

  const saveAll = async () => {
    try {
      await ThemeApi.save(theme, accent, wallpaper)
      toast('已保存到服务端（所有端同步）', 'ok')
    } catch { toast('保存失败', 'error') }
  }

  const handleReset = () => {
    const s = (SEEDS as any)[theme] as Seed
    selectAccent(s.accent)
    setDensity(s.step ?? 0.043)
    toast('已恢复该主题默认值')
  }

  const exportCss = () => {
    const tokens = seedVars(theme, accent, density)
    const css = `:root {\n${Object.entries(tokens).map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}`
    const blob = new Blob([css], { type: 'text/css' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `yuanshu-theme-${theme}.css`
    a.click()
    URL.revokeObjectURL(url)
    toast('CSS 变量已导出')
  }

  const ids = THEME_CATALOG.map(t => t.id)
  const tokens = seedVars(theme, accent, density)

  return (
    <div className="h-full overflow-y-auto page-enter">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
        <PageHeader
          title="主题系统"
          description="选择一套外观基底，再精调主色、层级密度与壁纸；修改会即时应用，保存后同步到所有端。"
          meta={<span className="text-[11px] text-pi-dim2">当前：{THEME_BY_ID[theme]?.name || theme}</span>}
        />

        <section data-slot="theme-gallery" className="mb-8">
          <SectionHeader title="主题画廊" description="选择基底会立即应用，并将密度恢复为该主题的默认层级。" />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {ids.map(id => (
              <ThemeCard
                key={id}
                id={id}
                active={theme === id}
                onApply={() => { selectTheme(id); toast(`已切换：${THEME_BY_ID[id]?.name || id}`, 'ok') }}
              />
            ))}
          </div>
        </section>

        <section data-slot="theme-workbench" className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.05fr)_minmax(320px,0.95fr)] gap-5 items-start mb-8">
          <div>
            <SectionHeader title="实时预览" description="预览使用当前主题变量，精调结果会同步反映在整个工作台。" />
            <div className="rounded-pi-lg border border-pi-border overflow-hidden lg:sticky lg:top-6">
              <div className="p-4 sm:p-5 space-y-3" style={{ background: 'var(--pi-bg)' }}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[11px] px-2 py-0.5 rounded-pi-sm" style={{ background: 'var(--pi-accent-soft)', color: 'var(--pi-accent-soft-fg)' }}>{THEME_BY_ID[theme]?.name || theme}</span>
                  <span className="text-[11px]" style={{ color: 'var(--pi-dim2)' }}>step {density.toFixed(3)}</span>
                </div>
                <div className="max-w-[82%] px-3 py-2 text-[13px] rounded-pi-md" style={{ background: 'var(--pi-bg2)', color: 'var(--pi-text)' }}>
                  主题不只是换色，底色层级、文字对比和阴影色相会一起派生。
                </div>
                <div className="ml-auto max-w-[82%] px-3 py-2 text-[13px] rounded-pi-md" style={{ background: 'var(--pi-accent)', color: 'var(--pi-on-accent)' }}>
                  当前精调会在这里实时呈现。
                </div>
                <div className="flex gap-2 pt-1">
                  <span className="flex-1 h-9 rounded-pi-md border px-3 flex items-center text-[12px]" style={{ borderColor: 'var(--pi-border)', background: 'var(--pi-field)', color: 'var(--pi-dim2)' }}>输入消息…</span>
                  <span className="px-3 h-9 rounded-pi-md flex items-center text-[12px] font-medium" style={{ background: 'var(--pi-accent)', color: 'var(--pi-on-accent)' }}>发送</span>
                </div>
              </div>
            </div>
          </div>

          <div>
            <SectionHeader title="精调当前主题" description="调整主色、层级密度和工作台壁纸。" />
            <div className="panel !p-3 space-y-5">
              <div>
                <div className="text-[12px] text-pi-dim2 font-semibold mb-2">主色</div>
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className={`w-8 h-8 rounded-full border-2 text-[11px] flex items-center justify-center ${!accent ? 'border-pi-accent' : 'border-pi-border'}`} style={{ background: (SEEDS as any)[theme]?.accent, color: 'var(--pi-on-accent)' }} onClick={() => selectAccent('')} title="主题默认主色">默认</button>
                  {ACCENT_SWATCHES.map(c => (
                    <button
                      type="button"
                      key={c}
                      onClick={() => selectAccent(c)}
                      aria-label={`使用主色 ${c}`}
                      aria-pressed={accent === c}
                      className={`w-8 h-8 rounded-full border-2 transition-transform ${accent === c ? 'border-pi-accent scale-110' : 'border-transparent'}`}
                      style={{ background: c }}
                      title={c}
                    />
                  ))}
                  <label className="flex items-center gap-1.5 text-[12px] text-pi-dim2 cursor-pointer ml-1">
                    自定义
                    <input
                      type="color"
                      value={accent || (SEEDS as any)[theme]?.accent || '#5468ff'}
                      className="w-8 h-8 rounded cursor-pointer bg-transparent border border-pi-border"
                      onChange={e => selectAccent(e.target.value)}
                    />
                  </label>
                </div>
              </div>

              <div>
                <div className="text-[12px] text-pi-dim2 font-semibold mb-2">
                  层级密度 <span className="text-[11px] text-pi-dim font-normal">step={density.toFixed(3)}，数值越大层级越明显</span>
                </div>
                <input
                  type="range"
                  min="0.02"
                  max="0.08"
                  step="0.001"
                  value={density}
                  aria-label="层级密度"
                  onChange={e => setDensity(parseFloat(e.target.value))}
                  className="w-full accent-pi-accent"
                />
              </div>

              <div>
                <div className="text-[12px] text-pi-dim2 font-semibold mb-2">
                  创作配色卡{' '}
                  <span className="text-[11px] text-pi-dim font-normal">
                    全局 · 两套 18 组：选了之后**所有出图/出片**（绘画、视频、连续创作、聊天里出图）都按它写「色调」；
                    单个项目要不一样，在项目里单独指定
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  <button
                    type="button"
                    aria-pressed={!colorCardId}
                    onClick={() => void saveColorCard('')}
                    className={`px-2.5 py-1.5 rounded-pi-sm text-[12px] transition-colors ${!colorCardId ? 'bg-pi-accent-soft text-pi-accent' : 'hover:bg-pi-bg3 text-pi-dim'}`}
                  >
                    不指定
                  </button>
                  {colorCardId && <span className="text-[11px] text-pi-dim self-center">当前：{CARD_FAMILIES[resolveColorCard(colorCardId)?.family || 'morandi']?.short} · {resolveColorCard(colorCardId)?.name}</span>}
                </div>
                {Object.values(CARD_FAMILIES).map(family => (
                  <div key={family.id} className="mb-2">
                    <div className="text-[11px] text-pi-dim mb-1">{family.name}（{family.rule}）</div>
                    <div className="grid grid-cols-3 gap-2">
                      {COLOR_CARDS.filter(c => c.family === family.id).map(card => {
                        const gradient = colorCardGradient(card)
                        const active = colorCardId === card.id
                        return (
                          <button
                            key={card.id}
                            type="button"
                            onClick={() => void saveColorCard(card.id)}
                            aria-pressed={active}
                            aria-label={`创作配色卡 ${card.name}：${card.top} 到 ${card.bottom}`}
                            title={`${card.top} → ${card.bottom}`}
                            className={`rounded-pi-md border overflow-hidden text-left transition-colors ${active ? 'border-pi-accent ring-1 ring-pi-accent' : 'border-pi-border hover:border-pi-border-hi'}`}
                          >
                            <span className="block h-8" style={{ background: gradient }} />
                            <span className="block px-2 py-1 bg-pi-bg1 text-[11px] text-pi-text truncate">{card.name}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>

              <div>
                <div className="text-[12px] text-pi-dim2 font-semibold mb-2">
                  配色卡壁纸{' '}
                  <span className="text-[11px] text-pi-dim font-normal">
                    两套 18 组 · 点一下套成壁纸，点色点连同主色一起换
                  </span>
                </div>
                {Object.values(CARD_FAMILIES).map(family => (
                  <div key={family.id} className="mb-2">
                    <div className="text-[11px] text-pi-dim mb-1">{family.name}</div>
                    <div className="grid grid-cols-3 gap-2">
                      {COLOR_CARDS.filter(c => c.family === family.id).map(card => {
                        const gradient = colorCardGradient(card)
                        const active = wallpaper === gradient
                        return (
                          <div
                            key={card.id}
                            className={`relative rounded-pi-md border overflow-hidden transition-colors ${active ? 'border-pi-accent' : 'border-pi-border hover:border-pi-border-hi'}`}
                          >
                            <button
                              type="button"
                              onClick={() => setWallpaper(gradient)}
                              aria-pressed={active}
                              aria-label={`配色卡壁纸 ${card.name}：${card.top} 到 ${card.bottom}`}
                              title={`原图标注 ${card.from} / ${card.to}；渐变从上到下`}
                              className="block w-full text-left"
                            >
                              <span className="block h-12" style={{ background: gradient }} />
                              <span className="block px-2 py-1.5 bg-pi-bg1">
                                <span className="block text-[11px] text-pi-text truncate">{card.name}</span>
                                <span className="block text-[11px] text-pi-dim2 font-mono">{card.top}</span>
                                <span className="block text-[11px] text-pi-dim2 font-mono">{card.bottom}</span>
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => selectAccent(card.top)}
                              aria-label={`把主色换成 ${card.name} 的深端 ${card.top}`}
                              title={`主色换成 ${card.top}`}
                              className={`absolute top-1 right-1 w-4 h-4 rounded-full border border-white/70 shadow ${accent.toLowerCase() === card.top.toLowerCase() ? 'ring-2 ring-pi-accent' : ''}`}
                              style={{ background: card.top }}
                            />
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>

              <div>
                <div className="text-[12px] text-pi-dim2 font-semibold mb-2">壁纸</div>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {WALL_PRESETS.map(p => (
                    <button
                      type="button"
                      key={p.label}
                      onClick={() => setWallpaper(p.value)}
                      aria-pressed={wallpaper === p.value}
                      className={`px-2.5 py-1.5 rounded-pi-sm text-[12px] transition-colors ${wallpaper === p.value ? 'bg-pi-accent-soft text-pi-accent' : 'hover:bg-pi-bg3 text-pi-dim'}`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap sm:flex-nowrap gap-2">
                  <input
                    type="text"
                    value={wallpaper.startsWith('http') || wallpaper.startsWith('data:') || wallpaper.startsWith('linear') ? wallpaper : ''}
                    placeholder="图片 URL 或渐变 CSS…"
                    onChange={e => setWallpaper(e.target.value)}
                    className="flex-1 text-[12px] font-mono bg-pi-field border border-pi-border rounded-pi-sm px-2.5 py-1.5 text-pi-text outline-none focus:border-pi-accent min-w-0"
                  />
                  <button type="button" onClick={() => fileRef.current?.click()} className="px-2.5 py-1.5 text-[12px] rounded-pi-sm border border-pi-border text-pi-dim hover:bg-pi-bg3 inline-flex items-center gap-1.5 flex-shrink-0">
                    <Upload className="w-3.5 h-3.5" aria-hidden="true" />上传
                  </button>
                  {wallpaper && (
                    <button type="button" onClick={() => setWallpaper('')} className="px-2.5 py-1.5 text-[12px] rounded-pi-sm border border-pi-border text-pi-danger hover:bg-pi-bg3 inline-flex items-center gap-1.5 flex-shrink-0" title="清除壁纸">
                      <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />清除
                    </button>
                  )}
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={e => {
                    const f = e.target.files?.[0]
                    if (!f) return
                    if (f.size > 1.5 * 1024 * 1024) {
                      toast('图片超过 1.5MB，请压缩后再传或改用 URL', 'error')
                      e.target.value = ''
                      return
                    }
                    const reader = new FileReader()
                    reader.onload = () => setWallpaper(reader.result as string)
                    reader.readAsDataURL(f)
                    e.target.value = ''
                  }}
                />
              </div>

              <div className="flex flex-wrap gap-2 pt-1">
                <button type="button" onClick={saveAll} className="btn-primary text-xs px-3.5 py-1.5 inline-flex items-center gap-1.5">
                  <Check className="w-3.5 h-3.5" aria-hidden="true" />保存到服务端
                </button>
                <button type="button" onClick={handleReset} className="btn-ghost text-xs px-3 py-1.5 inline-flex items-center gap-1.5">
                  <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />重置
                </button>
              </div>
            </div>
          </div>
        </section>

        <details className="panel !p-0 overflow-hidden mb-4">
          <summary className="px-4 py-3 cursor-pointer select-none flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-2 text-[13px] font-semibold text-pi-text">
              <Code2 className="w-4 h-4 text-pi-accent" aria-hidden="true" />开发者选项
            </span>
            <span className="inline-flex items-center gap-1.5 text-[11px] text-pi-dim2 font-normal">
              Token 与 CSS 工具
              <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
            </span>
          </summary>
          <div className="border-t border-pi-border-soft p-4 space-y-4">
            <div>
              <div className="text-[12px] font-semibold text-pi-text mb-2">Token 速览</div>
              <div className="flex gap-2 flex-wrap">
                {['--pi-bg', '--pi-bg1', '--pi-bg2', '--pi-bg3', '--pi-bg4'].map(k => (
                  <div key={k} className="flex flex-col items-center gap-1">
                    <span className="w-10 h-10 rounded-pi-sm border border-pi-border" style={{ background: tokens[k] }} />
                    <span className="text-[11px] text-pi-dim2 font-mono">{k.replace('--pi-', '')}</span>
                  </div>
                ))}
                <div className="flex flex-col items-center gap-1">
                  <span className="w-10 h-10 rounded-pi-sm border border-pi-border" style={{ background: tokens['--pi-accent'] }} />
                  <span className="text-[11px] text-pi-dim2 font-mono">accent</span>
                </div>
                <div className="flex flex-col items-center gap-1">
                  <span className="w-10 h-10 rounded-pi-sm border border-pi-border" style={{ background: tokens['--pi-green'] }} />
                  <span className="text-[11px] text-pi-dim2 font-mono">green</span>
                </div>
              </div>
            </div>
            <div className="flex gap-3 flex-wrap">
              {['sm', 'md', 'lg'].map(k => (
                <div
                  key={k}
                  className="w-20 h-12 rounded-pi-md flex items-center justify-center text-[11px]"
                  style={{ background: tokens['--pi-bg2'], boxShadow: tokens[`--pi-shadow-${k}` as keyof typeof tokens], color: 'var(--pi-dim2)' }}
                >
                  shadow-{k}
                </div>
              ))}
            </div>
            <button type="button" onClick={exportCss} className="btn-ghost text-xs px-3 py-1.5 inline-flex items-center gap-1.5">
              <Download className="w-3.5 h-3.5" aria-hidden="true" />导出 CSS
            </button>
          </div>
        </details>
      </div>
    </div>
  )
}
