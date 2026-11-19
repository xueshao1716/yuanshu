// ══════════════════════════════════════════════════════════
// AppearancePanel —— 设置页里的「外观 · 自动深色」开关（2026-11-19）
// 主题画廊在 #/themes；这里只放最常用的一个开关 + 时段，
// 让「到点自动变深色」不用先进主题页。逻辑全在 theme/auto.ts，本组件只做视图。
// ══════════════════════════════════════════════════════════
import { useEffect, useState } from 'react'
import { Moon, Sun, Clock } from 'lucide-react'
import { getAutoConfig, updateAutoConfig, autoState, type AutoConfig, type AutoMode } from '../../theme/auto'
import { THEME_CATALOG } from '../../theme/palettes'
import { toast } from '../shell/Toast'
import { getLitePref, setLitePref, detectSoftwareRender, isLite, type LitePref } from '../../lib/lite-mode.mjs'

const NAME = Object.fromEntries(THEME_CATALOG.map(t => [t.id, t.name]))

export default function AppearancePanel() {
  const [cfg, setCfg] = useState<AutoConfig>(() => getAutoConfig())
  const [st, setSt] = useState(() => autoState())

  useEffect(() => {
    const sync = () => { setCfg(getAutoConfig()); setSt(autoState()) }
    window.addEventListener('pi-theme-auto-changed', sync)
    window.addEventListener('pi-theme-changed', sync)
    const id = setInterval(sync, 60_000)
    return () => {
      window.removeEventListener('pi-theme-auto-changed', sync)
      window.removeEventListener('pi-theme-changed', sync)
      clearInterval(id)
    }
  }, [])

  const [lite, setLite] = useState<LitePref>(() => getLitePref())
  const pickLite = (v: LitePref) => {
    setLite(v)
    const on = setLitePref(v)
    toast(on ? '已开启省电显示：毛玻璃与动画已关，刷新后完全生效' : '已关闭省电显示，刷新后动画恢复', 'ok')
  }

  const set = (patch: Partial<AutoConfig>) => {
    const next = updateAutoConfig(patch)
    setCfg(next)
    setSt(autoState())
  }

  const on = cfg.mode !== 'off'
  const toggle = () => {
    const mode: AutoMode = on ? 'off' : 'time'
    set({ mode })
    toast(on ? '已关闭自动深色，只用手选主题' : '已开启自动深色：19:00 后转深色、07:00 转回浅色', 'ok')
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-pi-text">省电显示</span>
        {([['auto', '自动'], ['on', '开'], ['off', '关']] as [LitePref, string][]).map(([v, label]) => (
          <button key={v} onClick={() => pickLite(v)} aria-pressed={lite === v}
            className={`px-2.5 h-7 rounded-pi-sm border text-[11px] transition-colors ${lite === v ? 'border-pi-accent text-pi-text' : 'border-pi-border text-pi-dim2 hover:text-pi-text'}`}
            style={lite === v ? { background: 'var(--pi-accent-soft)', color: 'var(--pi-accent-soft-fg)' } : undefined}>
            {label}
          </button>
        ))}
        <span className="text-[11px] text-pi-dim2 basis-full">
          关掉毛玻璃和常驻动画。自动 = 检测到没有显卡加速（软件渲染）时开启{detectSoftwareRender() ? '，本机是软件渲染' : ''}；当前{isLite() ? '已开启' : '未开启'}。
        </span>
      </div>
      <div className="flex items-center gap-3">
        <button
          role="switch"
          aria-checked={on}
          aria-label="自动深色"
          onClick={toggle}
          className="relative w-11 h-6 rounded-full transition-colors flex-shrink-0"
          style={{ background: on ? 'var(--pi-accent)' : 'var(--pi-border)' }}
        >
          <span
            className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all"
            style={{ left: on ? '22px' : '2px', boxShadow: '0 1px 3px rgba(0,0,0,.3)' }}
          />
        </button>
        <div className="min-w-0">
          <div className="text-[13px] text-pi-text flex items-center gap-1.5">
            {on ? <Moon size={13} /> : <Sun size={13} />}自动深色
          </div>
          <div className="text-[11px] text-pi-dim2">
            {!on && '关闭中：只用你在主题画廊里手选的那套。'}
            {on && st && !st.overridden && (
              <>此刻应是{st.dir === 'dark' ? '深色' : '浅色'}「{NAME[st.theme] || st.theme}」
                （{st.mode === 'time' ? `${cfg.from}–${cfg.to}` : '跟随系统'}）。</>
            )}
            {on && st && st.overridden && (
              <>你手动选了{st.dir === 'dark' ? '深色' : '浅色'}；等{st.mode === 'time' ? '时段' : '系统状态'}变化后自动接管。</>
            )}
          </div>
        </div>
      </div>

      {on && (
        <div className="flex flex-wrap items-center gap-2 pl-14">
          {([['time', '按时段'], ['system', '跟随系统']] as [AutoMode, string][]).map(([v, label]) => (
            <button
              key={v}
              onClick={() => set({ mode: v })}
              aria-pressed={cfg.mode === v}
              className={`px-2.5 h-7 rounded-pi-sm border text-[11px] transition-colors ${cfg.mode === v ? 'border-pi-accent text-pi-text' : 'border-pi-border text-pi-dim2 hover:text-pi-text'}`}
              style={cfg.mode === v ? { background: 'var(--pi-accent-soft)', color: 'var(--pi-accent-soft-fg)' } : undefined}
            >
              {label}
            </button>
          ))}
          {cfg.mode === 'time' && (
            <span className="flex items-center gap-1.5 text-[11px] text-pi-dim2">
              <Clock size={12} />
              <input type="time" value={cfg.from} onChange={e => set({ from: e.target.value })}
                className="input !h-7 !py-0 !px-1.5 text-[11px] w-[92px]" aria-label="深色开始时间" />
              <span>→</span>
              <input type="time" value={cfg.to} onChange={e => set({ to: e.target.value })}
                className="input !h-7 !py-0 !px-1.5 text-[11px] w-[92px]" aria-label="深色结束时间" />
            </span>
          )}
          <a href="#/themes" className="text-[11px] text-pi-accent hover:underline ml-auto">配深浅主题 / 更多外观 →</a>
        </div>
      )}
    </div>
  )
}
