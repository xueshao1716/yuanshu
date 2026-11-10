// 她的状态（2026-11-11）：从"顶栏下方一条常驻状态带"收成灵珠上的一颗小点。
//
// 为什么收：主对话界面本该只有对话。信任度、运行健康这些是"要不要去看一眼"的信号，
// 不是每轮都要读的正文——一条 28px 的横带长期占着，等于把后台仪表盘搬到聊天页。
//
// 保留的东西：**只有需要你动手的两件事**会露出来——
//   ① 换代提案待批（五维满级，等你批）  ② 退化暂停/下滑（她正在自救）
// 其余（信任、亲密、互动次数）都在「她」页（#/soul?s=growth），要看再去看。
//
// 形态：灵珠右上角一颗 6px 小点（待批=琥珀，暂停=红，下滑=黄），hover 给原因，点击去对应页面。
// 没有任何警报时返回 null——**一个像素都不占**。
import useSWR from 'swr'
import { HerApi, levelMeta } from '../../lib/her-api'

export default function HerAlertBadge() {
  const growth = useSWR('her-growth', HerApi.growth, { refreshInterval: 180000, revalidateOnFocus: true })
  const degradation = useSWR('her-degradation', HerApi.degradation, { refreshInterval: 180000, revalidateOnFocus: true })

  const pending = growth.data?.hasPending === true
  const paused = degradation.data?.gate?.on === true
  const level = degradation.data?.assessment?.level
  const down = level === 'critical' || level === 'degraded'
  const info = levelMeta(level)

  if (!pending && !paused && !down) return null

  const pauseReason = String(degradation.data?.gate?.reason || '').trim()
  const tone = paused ? '#dc2626' : pending ? '#d97706' : info.tone === 'danger' ? '#dc2626' : '#d97706'
  const href = paused || down ? '#/health' : '#/soul?s=growth'
  const title = paused
    ? `退化自评挂了暂停闸${pauseReason ? `：${pauseReason}` : ''}`
    : down
      ? `退化自评：${info.label}`
      : '五维满级后生成的换代提案，需要你批准'

  return (
    <a
      href={href}
      title={title}
      aria-label={title}
      className="absolute top-0.5 right-0.5 z-10 flex items-center justify-center"
      style={{ width: 14, height: 14 }}
    >
      <span
        className="block rounded-full ring-2 ring-pi-bg/80"
        style={{ width: 6, height: 6, background: tone, boxShadow: `0 0 6px ${tone}` }}
      />
    </a>
  )
}
