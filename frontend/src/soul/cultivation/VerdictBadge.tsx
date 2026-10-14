import type { Verification } from './api'

const LABEL: Record<Verification['verdict'], string> = { pass: '独立验证通过', partial: '部分达标', fail: '验证未通过', unverified: '尚未验证' }

// 验证员独立于执行者判定：只看输出本身，不看设计稿与过程。无逐字引用的「通过」会被降为部分达标。
export default function VerdictBadge({ value }: { value?: Verification | null }) {
  if (!value) return null
  return <div className="cultivation-verdict" data-verdict={value.verdict}>
    <span className="cultivation-badge">{LABEL[value.verdict]}</span>
    {value.downgraded && <span className="soul-dim"> · 缺少原文依据，已从「通过」降级</span>}
    {value.conditions && <p className="soul-dim">成立条件：{value.conditions}</p>}
    {!!value.gaps?.length && <p className="soul-dim">未核实：{value.gaps.join('；')}</p>}
    {value.verdict === 'unverified' && value.reason && <p className="soul-dim">原因：{value.reason}</p>}
  </div>
}
