import type { ReactNode } from 'react'
export function LoadState({ error, loading, retry }: {error?: unknown; loading?: boolean; retry: () => unknown}) {
  if (error) return <div role="alert" className="soul-notice"><p>读取失败：{error instanceof Error ? error.message : String(error)}</p><button onClick={() => void retry()}>重新读取</button></div>
  if (loading) return <p role="status" className="soul-notice">正在读取现有记录…</p>
  return null
}
export function Block({ title, hint, children }: {title: string; hint?: string; children: ReactNode}) {
  return <section className="soul-block"><h3>{title}</h3>{hint && <p className="soul-hint">{hint}</p>}{children}</section>
}
export const date = (value?: string | number | null) => value ? new Date(value).toLocaleString('zh-CN', {hour12:false}) : '未提供时间'
export const errorText = (e: unknown) => e instanceof Error ? e.message : '操作失败，请重新读取后核对'
export const geneLabels: Record<string,string> = {gentleness:'温柔',initiative:'主动',curiosity:'好奇',attachment:'依恋',learning:'学习',creativity:'创造',caution:'谨慎',humor:'幽默',loyalty:'忠诚',autonomy_bias:'自主',adaptability:'应变'}
export const fieldLabels: Record<string,string> = {name:'名字',age:'设定年龄',gender:'性别',kind:'身份定位',called:'对你的称呼',bond:'关系定位',inner:'内心与自我认知',tone:'表达习惯',values:'价值观',boundaries:'行为边界',taboos:'禁忌',growth:'成长方向'}
export const formatValue = (value: unknown) => Array.isArray(value) ? value.join('\n') : String(value ?? '')
Object.assign(fieldLabels, {appearance:'人物外貌',hairstyle:'发型与发色',clothing:'日常服装',scenarioOutfits:'场景穿搭'})
