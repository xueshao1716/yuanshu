import { ChevronDown } from 'lucide-react'

export default function ProcessVisibilityToggle({ visible, onToggle, count }: { visible: boolean; onToggle: () => void; count: number }) {
  return <button type="button" onClick={onToggle} aria-expanded={visible}
    title="对所有消息生效，仅改变显示，不影响任务执行；此设备会记住选择"
    className="inline-flex min-h-11 items-center gap-2 rounded-pi-sm text-xs text-pi-accent hover:text-pi-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
    <ChevronDown className={`h-4 w-4 shrink-0 ${visible ? 'rotate-180' : ''}`} aria-hidden="true" />
    {visible ? '隐藏工具执行' : '显示工具执行'} · {count} 条
  </button>
}
