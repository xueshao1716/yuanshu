import type { TeamLaunch, TeamAcceptance } from '../api'
import { TeamRunControls } from './TeamRunControls'
import { useApp } from '../store'

export type TeamDelivery = { status?: string; draft?: string; proposalId?: string }
export type TeamProfile = { id?: string; version?: string }
const LAUNCH_LABEL: Record<string, string> = {
  launching: '正在启动', running: '执行中', completed: '执行已结束（不等于验收通过）',
  failed: '执行失败', interrupted: '运行中断或状态待确认', blocked: '启动受阻，需检查',
  stopping: '正在停止', stopped: '已停止',
}
const DELIVERY_LABEL: Record<string, string> = {
  quality_failed: '质量检查未通过，草稿未送审', submission_failed: '草稿已保存，但送审失败',
  awaiting_acceptance: '草稿已送审，等待人工验收',
}
const ACCEPTANCE_LABEL: Record<string, string> = {
  pending: '待人工验收，请到工作台「改动验收」处理',
  accepted: '验收记录已通过，交付文件与批准内容一致',
  rejected: '已驳回，未通过验收',
  applying: '验收写入尚未确认完成，请核对记录，勿重复应用',
  needs_recovery: '验收写入异常，请核对目标文件、备份与审计记录',
  target_changed: '曾通过验收，但交付文件已变化，请重新核对',
  target_missing: '曾通过验收，但交付文件已缺失，请检查历史记录',
  record_missing: '找不到对应的验收记录，请检查待审区与历史记录',
  unknown: '验收状态无法确认，请核对草稿、提议与交付文件',
}

export function TeamRunStatus({ launch, launchId, profile, delivery, acceptance, showLaunch = true }: {
  showLaunch?: boolean
  launch?: TeamLaunch | null; launchId?: string | null; profile?: TeamProfile; delivery?: TeamDelivery; acceptance?: TeamAcceptance | null
}) {
  const { selectSession } = useApp()
  return <div className="panel p-3 flex flex-col gap-2" role="status">
    {showLaunch && <div className="text-[12px] font-semibold text-pi-text">启动状态 · {LAUNCH_LABEL[launch?.status || ''] || '未发现由启动器管理的运行中任务'}</div>}
    {showLaunch && <TeamRunControls launch={launch} />}
    {showLaunch && launch?.sessionId && <button type="button" onClick={() => { selectSession(launch.sessionId!); location.hash = '#/chat' }} className="btn-secondary min-h-11 self-start px-3 text-sm focus-visible:outline focus-visible:outline-pi-accent">回到关联会话</button>}
    {launch?.task && <div className="text-[12px] text-pi-text break-all">{launch.task}</div>}
    {launch?.note && <div className="text-[11px] text-pi-dim">{launch.note}</div>}
    {launch?.id && launch.id !== launchId && <div className="text-[11px] text-pi-accent">下方若有历史快照，也不是本次启动的结果；本次记录尚未写入。</div>}
    {profile && <div className="text-[11px] text-pi-dim">流程：{profile.id || '未知'} · 版本 {profile.version || '未知'}（本地视频脚本流程，不等同完整 V20 / V25 / V26）</div>}
    {delivery && <>
      <div className="text-[12px] text-pi-text">保存时的投递记录：{DELIVERY_LABEL[delivery.status || ''] || '未知投递状态'}</div>
      {delivery.draft && <div className="text-[11px] text-pi-dim break-all">草稿位置：{delivery.draft}</div>}
      {delivery.status === 'awaiting_acceptance' && <>
        <div className="text-sm text-pi-text break-words">本快照的当前验收：{ACCEPTANCE_LABEL[acceptance?.status || 'unknown'] || ACCEPTANCE_LABEL.unknown}</div>
        {acceptance?.checkedAt && <div className="text-[11px] text-pi-dim break-all">核对时间：{acceptance.checkedAt}（页面约每 10 秒刷新）</div>}
      </>}
      <div className="text-[11px] text-pi-dim">验收仅针对本次脚本文件；脚本草稿不代表真实视频已生成。</div>
    </>}
  </div>
}
