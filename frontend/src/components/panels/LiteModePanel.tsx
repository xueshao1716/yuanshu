// ══════════════════════════════════════════════════════════
// LiteModePanel —— 主题页「省电显示」（2026-11-19）
// 没显卡加速（软件渲染）的机器上，毛玻璃和常驻动画会把 webview 吃到 100%+ CPU。
// 自动 = 检测到软件渲染才开；开/关 = 手动覆盖。逻辑在 lib/lite-mode.mjs，本组件只做视图。
// ══════════════════════════════════════════════════════════
import { useState } from 'react'
import { getLitePref, setLitePref, detectSoftwareRender, isLite, type LitePref } from '../../lib/lite-mode.mjs'
import { toast } from '../shell/Toast'

const OPTIONS: [LitePref, string, string][] = [
  ['auto', '自动', '检测到没有显卡加速时开启'],
  ['on', '开', '始终关掉毛玻璃和动画'],
  ['off', '关', '始终保留完整效果'],
]

export default function LiteModePanel() {
  const [pref, setPref] = useState<LitePref>(() => getLitePref())
  const [on, setOn] = useState(() => isLite())
  const pick = (v: LitePref) => {
    setPref(v)
    const next = setLitePref(v)
    setOn(next)
    toast(next ? '已开启省电显示：毛玻璃与动画已关，刷新后完全生效' : '已关闭省电显示，刷新后动画恢复', 'ok')
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {OPTIONS.map(([v, label, hint]) => (
          <button key={v} type="button" title={hint} onClick={() => pick(v)} aria-pressed={pref === v}
            className={`px-3 h-8 rounded-pi-sm border text-[12px] transition-colors ${pref === v ? 'border-pi-accent text-pi-text' : 'border-pi-border text-pi-dim2 hover:text-pi-text'}`}
            style={pref === v ? { background: 'var(--pi-accent-soft)', color: 'var(--pi-accent-soft-fg)' } : undefined}>
            {label}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-pi-dim2">
        当前{on ? '已开启' : '未开启'}{detectSoftwareRender() ? '；本机没有显卡加速（软件渲染），建议保持开启或自动' : '；本机有显卡加速'}。
      </p>
    </div>
  )
}
