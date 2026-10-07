import { useEffect, useState } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { CultivationApi, cultivationPolling, type Design, type Overview, type Preflight } from './api'
import { KnowledgeApi, knowledgePolling, type KnowledgePolicyData } from '../../knowledge/api'
import Authorization, { type Action } from './Authorization'
import DesignReadiness from './DesignReadiness'
import { GRANT_DAYS, classifyBlocked, grantPolicy, grantSummary, supportedDesign } from './grant-preset.mjs'
import { LoadState } from '../shared'
import './cultivation.css'

// 对话界面的浮动授权入口：把「去灵魂培养中心翻折叠块」变成「我弹出来，你点一下」。
// 出现条件刻意收得很窄：已有设计稿、还没登记个体、培养授权未开启、当前会话可确认。
// 四者缺一不显示——不打扰正常聊天，也不在没有放权通道时弹空壳。
export default function CultivationGate({ sessionId }: { sessionId: string | null }) {
  const [open, setOpen] = useState(false)
  const overview = useSWR('cultivation-overview', CultivationApi.overview, cultivationPolling)
  const data = overview.data
  const waiting = !!data && data.designCount > 0 && data.agentCount === 0 && !data.policy.enabled && !!data.sessionGrantAvailable
  if (!waiting) return null
  return <>
    <button className="cultivation-gate-fab" onClick={() => setOpen(true)} aria-label="打开培养授权弹窗">
      <span className="cultivation-gate-dot" aria-hidden="true" />培养授权待确认
    </button>
    {open && <GrantDialog sessionId={sessionId} close={() => setOpen(false)} />}
  </>
}

function GrantDialog({ sessionId, close }: { sessionId: string | null; close: () => void }) {
  const { mutate } = useSWRConfig()
  const [action, setAction] = useState<Action | null>(null)
  const [preflight, setPreflight] = useState<Preflight | null>(null)
  const overview = useSWR('cultivation-overview', CultivationApi.overview, cultivationPolling)
  const designs = useSWR(['cultivation-designs', null], () => CultivationApi.list<Design>('designs', null), cultivationPolling)
  const knowledge = useSWR('knowledge-policy', KnowledgeApi.policy, knowledgePolling)
  const refresh = async () => {
    await mutate(key => typeof key === 'string'
      ? key.startsWith('cultivation-') || key.startsWith('knowledge-')
      : Array.isArray(key) && String(key[0]).startsWith('cultivation-'))
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])
  const data = overview.data
  const rows = designs.data?.items || []
  // 列表按提交顺序排列（最旧在前），取最后一项作为最新设计稿。
  const latest = rows.length ? rows[rows.length - 1] : null
  const model = latest?.design.permissions.model || ''
  // 共享设置两项缺口：模型白名单与价格确认。查不到 key 时按「未确认」提示去页面核对，
  // 不猜格式、不假装就绪——宁可让人去页面看一眼，不可放权后才发现卡住。
  const kp: KnowledgePolicyData | undefined = knowledge.data
  const modelListed = !!kp && !!model && kp.allowedModels.includes(model)
  const rate = model ? kp?.rates[model] : undefined
  const rateConfirmed = !!rate && (rate.free === true || (typeof rate.input === 'number' && typeof rate.output === 'number'))
  const sharedReady = modelListed && rateConfirmed
  const fresh = !!preflight && !!data && preflight.revision === data.revision
  // 与 PolicyPreset 同一份判据与预设（grant-preset.mjs），两处不会各写各的。
  const { fixable, shared, stubborn } = classifyBlocked(fresh ? preflight!.blockedBy : [], { includeShared: true })
  const supported = !!latest && supportedDesign(latest.design)
  const revision = data?.revision ?? 0
  const prepare = () => {
    if (!latest || !supported || !data) return
    setAction({ method: 'PUT', path: '/policy', revision: data.revision,
      label: `开启 ${GRANT_DAYS} 天受限培养 · ${latest.design.name}`, payload: { policy: grantPolicy(latest.design) } })
  }
  return <div className="cultivation-gate-mask" onClick={close}>
    <section className="cultivation-gate-dialog" role="dialog" aria-modal="true" aria-label="培养授权"
      onClick={e => e.stopPropagation()}>
      <h3>培养授权</h3>
      <p>设计已经就位，不用再翻页面。在这里核对完，点一下就能放权。</p>

      <h4>设计摘要</h4>
      <LoadState error={designs.error} loading={designs.isLoading} retry={() => designs.mutate().catch(() => undefined)} />
      {latest && <dl className="soul-facts">
        <div><dt>设计</dt><dd>{latest.design.name}</dd></div>
        <div><dt>目标 / 课程阶段</dt><dd>{latest.design.goals.length} 项 / {latest.design.curriculum.length} 阶段</dd></div>
        <div><dt>模型</dt><dd>{latest.design.permissions.model}</dd></div>
        <div><dt>单次费用上限</dt><dd>{latest.design.permissions.costUpperBoundCents} 美分</dd></div>
        <div><dt>外部模型请求</dt><dd>{latest.design.permissions.remote ? '会外发到已授权模型' : '不外发'}</dd></div>
      </dl>}
      {latest && !latest.design.permissions.remote && <p role="status">该设计仍标记为本地调用；放权后需要仅把 remote 改为 true，再用新设计登记个体。</p>}
      {latest && !supported && <p role="status">这份设计超出受限文本预设的范围（工具、费用或数据范围），请先在页面核对完整资源设置。</p>}

      <h4>共享设置核对</h4>
      {knowledge.error && <LoadState error={knowledge.error} loading={false} retry={() => knowledge.mutate().catch(() => undefined)} />}
      {sharedReady
        ? <p role="status">模型白名单与价格已就绪（{model}）。</p>
        : <><p role="status">还差共享设置，放权按钮暂时不可点：</p>
          <ul>
            {!modelListed && <li>共享模型白名单未包含 {model || '设计模型'}。</li>}
            {!rateConfirmed && <li>该模型价格未确认（可标记为免费）。</li>}
          </ul>
          <div className="soul-actions">
            <button onClick={() => { close(); location.hash = '#/grants' }}>去授权中心补设置</button>
          </div>
          <p className="soul-hint">在「授权中心 · 培养与母体学习」的共享模型与额度设置里补齐，回来会自动更新。</p>
        </>}

      <h4>授权声明</h4>
      <p className="soul-hint">放权范围固定为{grantSummary}；不包含电脑、文件、终端、密码、凭据、工具或私人记忆。一次性放权不会自动开始付费任务；登记个体与提交任务时，服务端会再次核对实际资源与费用。</p>

      {latest && <DesignReadiness key={latest.id} designId={latest.id} revision={revision} onResult={setPreflight} />}
      {shared.length > 0 && <p role="status">共享模型设置还差 {shared.length} 项，可在授权中心一键补齐。</p>}
      {stubborn.length > 0 && <p role="status">还有 {stubborn.length} 项无法由本次放权修复（如共享资源、个体数量、执行器或设计本身），请先按上方清单核对。</p>}
      {fresh && stubborn.length === 0 && fixable.length > 0 && <p role="status">剩余 {fixable.length} 项待核对全部属于培养授权本身（授权开关、有效期、模型白名单、每日额度），本次放权会一并写入。</p>}

      {!action && <div className="soul-actions">
        <button disabled={!latest || !supported || !sharedReady || !fresh || stubborn.length > 0 || !!designs.isValidating || !!overview.isValidating}
          onClick={prepare}>核对并一次性放权</button>
        <button onClick={close}>稍后再说</button>
      </div>}
      {action && data && <Authorization key={JSON.stringify([sessionId, action])} action={action}
        owner={data.ownerConfirmation} sessionId={sessionId || ''} sessionGrantAvailable={!!data.sessionGrantAvailable}
        close={close} refresh={refresh} />}
    </section>
  </div>
}
