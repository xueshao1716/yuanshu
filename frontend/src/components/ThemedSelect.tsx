import { Children, isValidElement, useEffect, useMemo, useState, type ReactNode } from 'react'
import * as DM from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown } from 'lucide-react'

// ── ThemedSelect：后台下拉统一主题封装（2026-10-12）────────────────────
// 为什么必须换组件而不是 CSS：Android WebView 的 <select> 弹出列表是系统画的
// （白色大字），页面 CSS 管不到；所以"主题化下拉"只能是自绘弹层。
// 接口刻意兼容原生 select 的调用习惯：children 仍是 <option>，onChange 收
// `{ target: { value } }`，value/className/aria-label/照传——存量调用点可以机械替换。

interface Option { value: string; label: ReactNode; disabled: boolean }
const collect = (children: ReactNode): Option[] =>
  Children.toArray(children).filter(isValidElement).flatMap(el => {
    if (el.type === 'optgroup') return collect((el.props as any).children)
    if (el.type === 'option') {
      const p = el.props as any
      return [{ value: String(p.value ?? (typeof p.children === 'string' ? p.children : '')), label: p.children, disabled: !!p.disabled }]
    }
    return []
  })

const ITEM_CLS = 'outline-none flex items-center gap-2 px-3 py-2 text-[13px] cursor-pointer transition-colors data-[disabled]:opacity-55 data-[disabled]:cursor-not-allowed data-[highlighted]:bg-pi-bg-hover data-[state=checked]:bg-pi-accent/12'

export default function ThemedSelect(props: any) {
  const {
    value, defaultValue, onChange, children, className = '', disabled,
    'aria-label': ariaLabel, id, style, ...rest
  } = props
  const options = useMemo(() => collect(children), [children])
  const controlled = value !== undefined
  const [inner, setInner] = useState<string>(defaultValue ?? value ?? '')
  useEffect(() => { if (!controlled && defaultValue !== undefined) setInner(defaultValue) }, [defaultValue, controlled])
  const current = controlled ? String(value) : inner
  const selected = options.find(o => o.value === current)
  const pick = (v: string) => {
    if (!controlled) setInner(v)
    onChange?.({ target: { value: v } })
  }
  return (
    <DM.Root>
      <DM.Trigger id={id} disabled={disabled} aria-label={ariaLabel} style={style} {...rest}
        className={`select-themed inline-flex items-center justify-between gap-2 w-auto min-w-0 text-left ${className}`}
        data-state={selected ? 'selected' : undefined}>
        <span className="truncate text-[13px]">{selected ? selected.label : <span className="text-pi-dim">请选择</span>}</span>
        <ChevronDown className="w-3.5 h-3.5 shrink-0 text-pi-dim2" aria-hidden="true" />
      </DM.Trigger>
      <DM.Portal>
        <DM.Content position="popper" sideOffset={4} {...({} as any)} className="select-themed-menu z-[70] max-h-72 overflow-y-auto rounded-pi-md border border-pi-border bg-pi-bg1 shadow-lg py-1 min-w-[180px]">
          {options.map((o, i) => (
            <DM.Item {...({} as any)} key={`${o.value}:${i}`} value={o.value || String(i)} disabled={o.disabled} className={ITEM_CLS}
              onSelect={() => pick(o.value)}>
              <span className="flex-1 truncate">{o.label}</span>
              {o.value === current && <Check className="w-3.5 h-3.5 shrink-0 text-pi-accent" aria-hidden="true" />}
            </DM.Item>
          ))}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  )
}
