import type { KnowledgeProvenanceData } from './api'

const execution: Record<string, string> = { completed: '已完成', failed: '失败', interrupted: '已中断', cancelled: '已取消', running: '执行中', queued: '排队中' }
const checks: Record<string, string> = { PASS: '检查通过', FAIL: '检查未通过', UNVERIFIED: '未验证' }
const acceptance: Record<string, string> = { pass: '已通过', accepted: '已通过', pending: '待人工验收', fail: '未通过', rejected: '已拒绝', revoke: '已撤销', stale: '证据已变化，需复核', invalid: '记录无效', unknown: '尚无法确认', record_missing: '缺少验收记录', target_changed: '交付内容已变化', target_missing: '交付文件缺失', applying: '批准应用中', needs_recovery: '批准待恢复' }
const label = (map: Record<string, string>, value: string) => map[value] || '尚无法确认'

export default function KnowledgeProvenance({ value }: { value?: KnowledgeProvenanceData }) {
  if (!value || value.status === 'not_applicable') return null
  if (value.status === 'unavailable') return <p className="text-pi-dim">任务验收记录暂不可读，请稍后刷新；不视为已通过。</p>
  return <section className="space-y-2 border-t border-pi-border-soft pt-3" aria-label="来源任务验收">
    <h5 className="font-medium">来源任务验收</h5>
    {value.task && <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 leading-6">
      <dt className="text-pi-dim">任务执行</dt><dd>{label(execution, value.task.status)}</dd>
      <dt className="text-pi-dim">客观检查</dt><dd>{label(checks, value.task.objective)}</dd>
      <dt className="text-pi-dim">人工验收</dt><dd>{label(acceptance, value.task.acceptance)}</dd>
    </dl>}
    {value.teams.map(team => <div key={team.runId} className="space-y-1 leading-6">
      <p>天团任务 · {team.runId}</p>
      <p className="text-pi-dim">模型评审：{label(checks, team.modelReview)} · 人工验收：{label(acceptance, team.acceptance)}</p>
    </div>)}
    <p className="text-pi-dim leading-6">以上是来源任务的当前记录，不等于方法已验证，也不会自动批准知识或调整人格。</p>
  </section>
}
