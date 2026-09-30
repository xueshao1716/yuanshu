import { useState } from 'react'
import useSWR from 'swr'
import { KnowledgeApi, knowledgeError, type KnowledgePolicyData } from './api'

const lines = (text: string) => [...new Set(text.split(/\r?\n/).map(s => s.trim()).filter(Boolean))]
export default function KnowledgePolicy({ policy, refreshed }: { policy: KnowledgePolicyData; refreshed: () => Promise<unknown> }) {
  const [draft, setDraft] = useState(policy), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('')
  const models = useSWR('knowledge-models', KnowledgeApi.models, { refreshWhenHidden: false })
  const [allowedRoots, setRoots] = useState(policy.allowedRoots.join('\n')), [allowedUrls, setUrls] = useState(policy.allowedUrls.join('\n')), [outboundRoots, setOutbound] = useState(policy.outboundRoots.join('\n'))
  const rate = draft.rates[draft.model] || { input: 0, output: 0, currency: draft.currency, free: false, tokenBound: '' }
  const stale = policy.revision > draft.revision
  const currencyMismatch = !!draft.model && rate.currency !== draft.currency
  const update = (patch: Partial<KnowledgePolicyData>) => setDraft(d => ({ ...d, ...patch }))
  const setRate = (patch: Partial<typeof rate>) => update({ rates: { ...draft.rates, [draft.model]: { ...rate, ...patch } } })
  const reload = () => { setDraft(policy); setRoots(policy.allowedRoots.join('\n')); setUrls(policy.allowedUrls.join('\n')); setOutbound(policy.outboundRoots.join('\n')); setMessage('已载入最新设置。'); setError('') }
  return <details className="border-t border-pi-border-soft pt-3">
    <summary className="min-h-11 cursor-pointer py-2 font-medium">授权与用量设置</summary>
    <form className="space-y-5 py-3" onSubmit={async e => {
      e.preventDefault(); if (busy || stale || currencyMismatch) return; setBusy(true); setError(''); setMessage('')
      try {
        const { revision, ...patch } = draft
        // Only editable fields are sent: server-owned concurrency is deliberately omitted.
        const { localEnabled, paused, remoteEnabled, networkEnabled, dailyCost, currency, maxModelRequests, maxNetworkRequests, inputTokens, outputTokens, model, rates } = patch
        const saved = await KnowledgeApi.updatePolicy({ localEnabled, paused, remoteEnabled, networkEnabled, dailyCost, currency, maxModelRequests, maxNetworkRequests, inputTokens, outputTokens, model, rates,
          allowedModels: model ? [model] : [], allowedRoots: lines(allowedRoots), allowedUrls: lines(allowedUrls), outboundRoots: lines(outboundRoots) }, revision)
        setDraft(saved); setRoots(saved.allowedRoots.join('\n')); setUrls(saved.allowedUrls.join('\n')); setOutbound(saved.outboundRoots.join('\n'))
        setMessage('设置已保存。新的授权立即生效，受阻任务会重新核对条件。'); await refreshed()
      } catch (err) {setError(knowledgeError(err))} finally {setBusy(false)}
    }}>
      {stale && <div role="alert" className="space-y-2 leading-6"><p>设置已在别处更新。你的未保存输入仍保留；请核对后重新载入最新设置，再修改保存。</p><button type="button" className="btn-tool min-h-11 px-3" disabled={busy} onClick={reload}>重新载入最新设置（放弃当前草稿）</button></div>}
      <fieldset className="space-y-3" disabled={busy}>
        <legend className="font-medium mb-2">本地积累</legend>
        <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={draft.localEnabled} onChange={e => update({localEnabled:e.target.checked})} />启用本地知识处理</label>
        <p className="text-pi-dim leading-6">只读取本工作空间内获准的资料与已结束任务。人格、密钥和私人配置不会成为知识来源。</p>
        <label className="block">允许读取的目录（相对工作空间，一行一个）<textarea className="input-pi mt-1 w-full min-h-24" value={allowedRoots} onChange={e => setRoots(e.target.value)} placeholder="例如：文档/参考资料" /></label>
      </fieldset>
      <fieldset className="space-y-3" disabled={busy}>
        <legend className="font-medium mb-2">网页采集</legend>
        <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={draft.networkEnabled} onChange={e => update({networkEnabled:e.target.checked})} />允许访问指定网页</label>
        <p className="text-pi-dim leading-6">默认关闭。只访问下列完整 HTTPS 地址，不允许整个域名、内网地址或携带登录信息的请求。</p>
        <label className="block">允许采集的完整地址（一行一个）<textarea className="input-pi mt-1 w-full min-h-24" value={allowedUrls} onChange={e => setUrls(e.target.value)} /></label>
      </fieldset>
      <fieldset className="space-y-3" disabled={busy}>
        <legend className="font-medium mb-2">外部模型提炼</legend>
        <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={draft.remoteEnabled} onChange={e => update({remoteEnabled:e.target.checked})} />允许发送获准文件给所选模型</label>
        <p className="text-pi-dim leading-6">默认关闭；不开启也能本地摘录。模型结论保留为待核查，不会因此自动验证、改写人格或批准基因提案。任务会话不会发送给外部提炼模型。</p>
        <label className="block">知识提炼模型<select className="input-pi mt-1 w-full min-h-11" value={draft.model} onChange={e => update({model:e.target.value})}>
          <option value="">不使用外部模型</option>
          {draft.model && !models.data?.some(m => m.key === draft.model) && <option value={draft.model}>{draft.model}（等待核对可用性）</option>}
          {models.data?.map(m => <option key={m.key} value={m.key}>{m.label} · {m.key}</option>)}
        </select></label>
        {models.error && <p role="alert">模型目录读取失败。<button type="button" className="btn-tool min-h-11 px-3" onClick={() => void models.mutate()}>重试读取</button></p>}
        <label className="block">允许外发的目录（一行一个，必须也有读取授权）<textarea className="input-pi mt-1 w-full min-h-24" value={outboundRoots} onChange={e => setOutbound(e.target.value)} /></label>
        {draft.model && <>
          <p className="text-pi-dim leading-6">价格由你按服务商实际计费填写，不猜测余额。下方为每百万 token 的价格；所有请求先预留费用。</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{(['input','output'] as const).map(key => <label key={key}>{key === 'input' ? '输入' : '输出'}价格（{rate.currency} / 百万 token）<input required type="number" min="0" step="any" className="input-pi mt-1 w-full min-h-11" value={rate[key]} onChange={e => setRate({[key]:Number(e.target.value)})} /></label>)}</div>
          {currencyMismatch && <div role="alert" className="space-y-2 leading-6"><p>预算已选 {draft.currency}，上述价格仍是 {rate.currency}。系统不会自动换算；请按服务商价格核对数值，再确认币种。</p><button type="button" className="btn-tool min-h-11 px-3" onClick={() => setRate({currency:draft.currency,free:false})}>已核对，将上述价格记为 {draft.currency}</button></div>}
          <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={!!rate.free} onChange={e => setRate({free:e.target.checked})} />已确认该模型免费（零价格时必须确认）</label>
          <label className="flex min-h-11 items-start gap-2 py-2"><input className="mt-1" type="checkbox" checked={rate.tokenBound === 'utf8-bytes'} onChange={e => setRate({tokenBound:e.target.checked ? 'utf8-bytes' : ''})} /><span>已核对该模型：输入 token 数不超过 UTF-8 字节数。不能确认时请勿勾选，外部调用将保持阻断。</span></label>
        </>}
      </fieldset>
      <fieldset className="space-y-3" disabled={busy}>
        <legend className="font-medium mb-2">每日预算与单次上限</legend>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label>计费币种<select className="input-pi mt-1 w-full min-h-11" value={draft.currency} onChange={e => update({currency:e.target.value})}>{['USD','CNY','EUR'].map(c => <option key={c}>{c}</option>)}</select></label>
          {([['dailyCost','每日费用上限'],['maxModelRequests','每日模型请求次数'],['maxNetworkRequests','每日网页请求次数'],['inputTokens','单次输入 token 上限'],['outputTokens','单次输出 token 上限']] as const).map(([key,label]) => <label key={key}>{label}<input required type="number" min="0" max="1000000" step={key === 'dailyCost' ? 'any' : '1'} className="input-pi mt-1 w-full min-h-11" value={draft[key]} onChange={e => update({[key]:Number(e.target.value)})} /></label>)}
        </div>
        <p className="text-pi-dim leading-6">按 UTC 日结算。用量未知时保留全部预留额度，不把它当成免费；授权变更不会清掉历史账目。</p>
      </fieldset>
      {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
      <button className="btn-primary min-h-11 px-4 disabled:opacity-50" disabled={busy || stale || currencyMismatch}>{busy ? '正在保存…' : '保存授权与限额'}</button>
    </form>
  </details>
}
