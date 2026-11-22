// ══════════════════════════════════════════════════════════
// TypographyPanel —— 主题页「字体排版」（2026-11-22，用户反馈要能调字号、字间距）
// 存本机（手机和电脑各调各的），逻辑在 theme/typography.mjs，本组件只做视图。
// ══════════════════════════════════════════════════════════
import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { getTypography, setTypography, TYPO_DEFAULTS, TYPO_LIMITS, type Typography, type TypoKey } from '../../theme/typography.mjs'

const ROWS: { key: TypoKey; label: string; hint: string; fmt: (v: number) => string }[] = [
  { key: 'scale', label: '界面缩放', hint: '整个工作台一起放大缩小（手机 App 里只放大文字）', fmt: v => `${Math.round(v * 100)}%` },
  { key: 'chatSize', label: '正文字号', hint: '对话里的回复和你发的消息', fmt: v => `${v}px` },
  { key: 'letterSpacing', label: '字间距', hint: '对话正文字与字之间的距离', fmt: v => (v ? `${v.toFixed(2)}em` : '默认') },
  { key: 'lineHeight', label: '行高', hint: '对话正文行与行之间的距离', fmt: v => v.toFixed(2) },
]

export default function TypographyPanel() {
  const [t, setT] = useState<Typography>(() => getTypography())
  const set = (key: TypoKey, v: number) => setT(setTypography({ [key]: v }))
  const changed = ROWS.some(r => t[r.key] !== TYPO_DEFAULTS[r.key])
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
        {ROWS.map(r => {
          const [min, max, step] = TYPO_LIMITS[r.key]
          return (
            <label key={r.key} className="block" title={r.hint}>
              <span className="flex items-center justify-between text-[12px] mb-1.5">
                <span className="text-pi-dim2 font-semibold">{r.label}</span>
                <span className="text-pi-text tabular-nums">{r.fmt(t[r.key])}</span>
              </span>
              <input type="range" min={min} max={max} step={step} value={t[r.key]} aria-label={r.label}
                onChange={e => set(r.key, Number(e.target.value))} className="w-full accent-[var(--pi-accent)]" />
              <span className="block text-[11px] text-pi-dim2 mt-1">{r.hint}</span>
            </label>
          )
        })}
      </div>
      <div className="markdown-body rounded-pi-md border border-pi-border-soft px-3 py-2" aria-label="预览">
        <p>预览：元枢会按这里的字号、字间距和行高显示对话。The quick brown fox jumps over the lazy dog.</p>
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-pi-dim2">只保存在这台设备上：手机和电脑可以各调各的。</p>
        <button type="button" disabled={!changed} onClick={() => setT(setTypography(null))}
          className="inline-flex items-center gap-1.5 px-3 h-8 rounded-pi-sm border border-pi-border text-[12px] text-pi-dim2 hover:text-pi-text disabled:opacity-40">
          <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />恢复默认
        </button>
      </div>
    </div>
  )
}
