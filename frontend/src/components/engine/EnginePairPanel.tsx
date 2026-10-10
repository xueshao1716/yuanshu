import { useRef, useState } from 'react'
import { ArrowLeftRight } from 'lucide-react'
import { EngineApi } from '../../api'

type Pair = Awaited<ReturnType<typeof EngineApi.pair>>

export default function EnginePairPanel({ data, error, onReload }: { data?: Pair; error?: unknown; onReload: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [saveError, setSaveError] = useState('')
  const [saved, setSaved] = useState(false)
  const catalog = data?.catalog || []
  const save = async (body: Parameters<typeof EngineApi.savePair>[0]) => {
    if (pending.current || !data || error) return
    pending.current = true
    setBusy(true); setSaveError(''); setSaved(false)
    try { await EngineApi.savePair(body); await onReload(); setSaved(true) }
    catch (e) { setSaveError(e instanceof Error ? e.message : '保存失败，请重试') }
    finally { pending.current = false; setBusy(false) }
  }
  const pick = (slot: 'primary' | 'secondary', id: string) => {
    if (!data || id === data[slot]) return
    const other = slot === 'primary' ? data.secondary : data.primary
    void save(id === other ? { swap: true } : { primary: slot === 'primary' ? id : other, secondary: slot === 'secondary' ? id : other })
  }
  return <section className="border-t border-pi-border-soft py-5" aria-labelledby="engine-pair-title">
    <h2 id="engine-pair-title" className="text-sm font-semibold text-pi-text mb-3">主次引擎配置</h2>
    {error ? <p role="alert" className="text-sm text-pi-danger mb-3">引擎配置暂不可用，请刷新后再修改。</p> : !data ? <p role="status" className="text-sm text-pi-dim mb-3">正在加载引擎配置...</p> : null}
    <div className="flex flex-col sm:flex-row items-stretch gap-3">
      {(['primary', 'secondary'] as const).map((slot, index) => <div key={slot} className="flex items-end gap-3 flex-1 min-w-0">
        {index === 1 && <button type="button" title="对调主次引擎" aria-label="对调主次引擎" className="btn-ghost min-h-11 min-w-11 shrink-0" disabled={busy || !data || !!error} onClick={() => void save({ swap: true })}><ArrowLeftRight className="w-4 h-4" /></button>}
        <label className="block flex-1 min-w-0 text-sm text-pi-dim">{slot === 'primary' ? '主引擎' : '次引擎'}
          <select className="input-pi mt-1 min-h-11" value={data?.[slot] || ''} disabled={busy || !data || !!error} onChange={e => pick(slot, e.target.value)}>
            {!data && <option value="">加载中</option>}
            {catalog.map(e => <option key={e.id} value={e.id}>{e.label}{e.canLead ? '' : '（暂不能主驾）'}</option>)}
          </select>
        </label>
      </div>)}
    </div>
    <div className="min-h-6 mt-2 text-sm" aria-live="polite">
      {saveError ? <p role="alert" className="text-pi-danger break-words">{saveError}</p> : <p className="text-pi-dim">{busy ? '正在保存...' : saved ? '配置已保存，下一次请求生效' : '配置作用于下一次请求'}</p>}
    </div>
    {data?.eval && <div className="mt-3 text-sm text-pi-dim">
      <span className="text-pi-text font-medium">元枢本地规则评测</span> <span className="tabular-nums">{data.eval.passed}/{data.eval.total}</span>
      <span className="ml-2">不含真实模型调用</span>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">{Object.entries(data.eval.byTag || {}).map(([k, v]) => <span key={k} className="break-all">{k} <span className="tabular-nums">{v.passed}/{v.total}</span></span>)}</div>
    </div>}
    <div className="mt-4 divide-y divide-pi-border-soft">
      {catalog.map(e => <details key={e.id} className="py-1">
        <summary className="cursor-pointer min-h-11 py-3 text-sm text-pi-text break-words">{e.label}<span className="ml-2 text-pi-dim">{e.id === data?.primary ? '配置主驾' : e.id === data?.secondary ? '配置次席' : '备选引擎'}</span></summary>
        <p className="text-sm text-pi-dim leading-relaxed mb-3 break-words">{e.intro || e.desc}</p>
        <div className="grid sm:grid-cols-2 gap-4 pb-3 text-sm">
          <div><h3 className="font-medium text-pi-text mb-2">能做</h3><ul className="list-disc pl-5 space-y-1 text-pi-dim">{(e.can || []).map(line => <li key={line} className="break-words">{line}</li>)}</ul></div>
          <div><h3 className="font-medium text-pi-text mb-2">边界</h3><ul className="list-disc pl-5 space-y-1 text-pi-dim">{(e.cannot || []).map(line => <li key={line} className="break-words">{line}</li>)}</ul></div>
        </div>
      </details>)}
    </div>
  </section>
}
