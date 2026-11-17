import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Code2, Download, RotateCcw, Trash2, Upload } from 'lucide-react'
import { generateTheme, SEEDS } from '../theme/generate.mjs'
import { applyTheme, currentTheme, themeDensities, persistDensity } from '../theme/apply'
import { persistWallpaper, currentWallpaper } from '../theme/wallpaper.mjs'
import { COLOR_CARDS, CARD_FAMILIES, colorCardGradient, colorCardOn, resolveColorCard } from '../theme/colorcards.mjs'
import { persistColorCardShell } from '../theme/colorcard-shell.mjs'
import FloatPill from '../components/FloatPill'
import { THEME_CATALOG } from '../theme/palettes'
import { ThemeApi, ColorApi } from '../api'
import PageHeader from '../components/PageHeader'
import SectionHeader from '../components/SectionHeader'
import { toast } from '../components/shell/Toast'

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
  // 密度按主题分别记，存服务端；没调过的主题用种子默认值
  const [densities, setDensities] = useState<Record<string, number>>(() => themeDensities())
  const density = densities[theme] || ((SEEDS as any)[theme]?.step) || 0.043
  const setDensity = (step: number) => setDensities(persistDensity(theme, step))
  const [wallpaper, setWallpaper] = useState(() => currentWallpaper())
  // 全局创作配色卡：服务端一份，所有出图/出片入口共用（项目要单独覆盖在项目里指定）
  const [colorCardId, setColorCardId] = useState('')
  // 两套卡（高级灰 / 高饱和）用切换而不是一次全铺：18 组平铺会把这一栏拉得很长，排版也乱
  const [cardFamily, setCardFamily] = useState<'morandi' | 'vivid'>('morandi')
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    ColorApi.get().then(r => setColorCardId(r?.colorCardId || '')).catch(() => {})
  }, [])
  const saveColorCard = async (id: string) => {
    const prev = colorCardId
    setColorCardId(id) // 先反馈，再落盘；失败回滚并说清
    try {
      const r = await ColorApi.save(id)
      const next = r?.colorCardId ?? ''
      setColorCardId(next)
      // 壳层（左栏/右栏/面板头）跟着换色纱：不这么做，"全局"就只有出图变了
      persistColorCardShell(next)
      toast(next ? `创作配色已保存：左栏/右栏与所有出图/出片都按「${resolveColorCard(next)?.name || next}」走` : '已取消创作配色，左右栏与出图回到主题默认', 'ok')
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
      setDensities(themeDensities()) // 别的端同步过来的密度
    }
    window.addEventListener('pi-theme-changed', onExt)
    return () => window.removeEventListener('pi-theme-changed', onExt)
  }, [])

  useEffect(() => {
    const vars = seedVars(theme, accent, density)
    const el = document.documentElement as any
    for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v)
  }, [theme, accent, density])

  useEffect(() => {
    const saved = persistWallpaper(wallpaper)
    if (!saved.ok && wallpaper.startsWith('data:')) toast('图片太大，浏览器存不下。请改用较小的图或填 URL。', 'error')
  }, [wallpaper])

  // 主题/主色一点就同步（applyTheme 里存）；壁纸和密度以前要手动点保存，忘了点就丢——改成停手 0.8 秒自动同步
  const [syncState, setSyncState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const firstSync = useRef(true)
  useEffect(() => {
    if (firstSync.current) { firstSync.current = false; return }
    setSyncState('saving')
    const t = setTimeout(() => {
      ThemeApi.save(theme, accent, wallpaper, densities).then(() => setSyncState('saved'), () => setSyncState('error'))
    }, 800)
    return () => clearTimeout(t)
  }, [wallpaper, densities]) // eslint-disable-line react-hooks/exhaustive-deps

  const saveAll = async () => {
    try {
      await ThemeApi.save(theme, accent, wallpaper, densities)
      setSyncState('saved')
      toast('已同步到所有端', 'ok')
    } catch { setSyncState('error'); toast('同步失败', 'error') }
  }

  const handleReset = () => {
    selectAccent('')
    setDensity(0)
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
          <SectionHeader title="主题画廊" description="选择基底会立即应用；每套主题的层级密度各自记住。" />
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
            <SectionHeader title="精调当前主题" description="主色、层级密度和壁纸；改动即时生效，自动同步到所有端。" />
            <div className="panel !p-4 space-y-5">
              <div>
                <div className="text-[12px] text-pi-dim2 font-semibold mb-2">主色</div>
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className={`w-8 h-8 rounded-full border-2 text-[11px] flex items-center justify-center ${!accent ? 'border-pi-accent' : 'border-pi-border'}`} style={{ background: (SEEDS as any)[theme]?.accent, color: 'var(--pi-on-accent)' }} onClick={() => selectAccent('')} aria-pressed={!accent} title="主题默认主色">默认</button>
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
                <div className="flex items-baseline justify-between mb-2">
                  <span className="text-[12px] text-pi-dim2 font-semibold">层级密度</span>
                  <span className="text-[11px] text-pi-dim2 font-mono">{density.toFixed(3)}{densities[theme] ? '' : ' · 默认'}</span>
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
                <div className="flex justify-between text-[11px] text-pi-dim2 mt-0.5"><span>柔和</span><span>层级分明</span></div>
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
                    placeholder="图片 URL 或渐变 CSS…（下方配色卡也能一键套）"
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

              <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-pi-border-soft">
                <span className={`mr-auto text-[11px] ${syncState === 'error' ? 'text-pi-danger' : 'text-pi-dim2'}`} aria-live="polite">
                  {syncState === 'saving' ? '同步中…' : syncState === 'error' ? '同步失败，可点「立即同步」重试' : syncState === 'saved' ? '已同步到所有端' : '改动会自动同步到所有端'}
                </span>
                <button type="button" onClick={handleReset} className="btn-ghost text-xs px-3 py-1.5 inline-flex items-center gap-1.5">
                  <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />重置
                </button>
                <button type="button" onClick={saveAll} className="btn-primary text-xs px-3.5 py-1.5 inline-flex items-center gap-1.5">
                  <Check className="w-3.5 h-3.5" aria-hidden="true" />立即同步
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* 创作配色卡单独一块（2026-11-17）：它是「全局出图色调」，点一下就存，和上面的主题精调不是一回事；
            以前挤在精调里、同一组卡还列两遍（药丸一遍、壁纸网格一遍），整栏拉得老长。
            现在每张卡只出现一次，卡上直接给「套成壁纸 / 取主色」。 */}
        <section data-slot="color-card-studio" className="mb-8">
          <SectionHeader title="创作配色卡" description="全局生效：选中后所有出图/出片（绘画、视频、连续创作）都按它写「色调」，左右栏也带上这套色纱。点一下即保存。" />
          <div className="panel !p-4">
            <div className="flex flex-wrap items-center gap-2 mb-1.5">
              <div role="group" aria-label="配色卡系列" className="inline-flex p-0.5 rounded-pi-md bg-pi-bg3">
                {Object.values(CARD_FAMILIES).map(family => (
                  <button
                    key={family.id}
                    type="button"
                    aria-pressed={cardFamily === family.id}
                    onClick={() => setCardFamily(family.id)}
                    className={`px-3 py-1 rounded-pi-sm text-[12px] transition-colors ${cardFamily === family.id ? 'bg-pi-bg1 text-pi-text shadow-sm' : 'text-pi-dim hover:text-pi-text'}`}
                  >
                    {family.name}
                  </button>
                ))}
              </div>
              <div className="ml-auto flex items-center gap-2">
                {colorCardId && <span className="text-[11px] text-pi-dim">当前：{resolveColorCard(colorCardId)?.name}</span>}
                <button
                  type="button"
                  aria-pressed={!colorCardId}
                  onClick={() => void saveColorCard('')}
                  className={`px-2.5 py-1 rounded-pi-sm text-[12px] transition-colors ${!colorCardId ? 'bg-pi-accent-soft text-pi-accent' : 'hover:bg-pi-bg3 text-pi-dim'}`}
                >
                  不指定
                </button>
              </div>
            </div>
            <div className="text-[11px] text-pi-dim2 mb-4">{CARD_FAMILIES[cardFamily].rule}</div>
            <div className="float-pill-grid grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-4">
              {COLOR_CARDS.filter(c => c.family === cardFamily).map(card => {
                const gradient = colorCardGradient(card)
                const isWall = wallpaper === gradient
                const isAccent = accent.toLowerCase() === card.top.toLowerCase()
                const action = (on: boolean) => `px-2 py-1 rounded-pi-sm text-[11px] transition-colors ${on ? 'bg-pi-accent-soft text-pi-accent' : 'text-pi-dim hover:bg-pi-bg3 hover:text-pi-text'}`
                return (
                  <div key={card.id} className="min-w-0">
                    <FloatPill
                      label={card.name}
                      value={card.top}
                      bg={card.top}
                      fg={colorCardOn(card)}
                      tint={card.top}
                      active={colorCardId === card.id}
                      title={`用于创作：${card.top} → ${card.bottom}`}
                      onClick={() => void saveColorCard(card.id)}
                      className="w-full"
                    />
                    <div className="flex items-center gap-1 mt-2 px-1">
                      <span className="w-4 h-4 rounded-pi-sm border border-pi-border-soft flex-shrink-0" style={{ background: gradient }} title={`${card.top} → ${card.bottom}`} aria-hidden="true" />
                      <span className="text-[11px] text-pi-dim2 font-mono truncate">{card.bottom}</span>
                      <span className="flex-1" />
                      <button type="button" aria-pressed={isWall} onClick={() => setWallpaper(isWall ? '' : gradient)} aria-label={`${isWall ? '取消' : ''}把 ${card.name} 套成壁纸`} className={action(isWall)}>套成壁纸</button>
                      <button type="button" aria-pressed={isAccent} onClick={() => selectAccent(isAccent ? '' : card.top)} aria-label={`${isAccent ? '取消' : ''}用 ${card.name} 的深端 ${card.top} 作主色`} className={action(isAccent)}>取主色</button>
                    </div>
                  </div>
                )
              })}
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
