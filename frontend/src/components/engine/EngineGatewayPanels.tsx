import { useRef, useState } from 'react'
import { Plug, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { EngineApi } from '../../api'

const SECTION_LABEL: Record<string, string> = { memory: '记忆', skills: '技能', plan: '计划' }

export default function EngineGatewayPanels({ data, error, onReload, onProbe, probing }: { data?: any; error?: unknown; onReload: () => Promise<unknown>; onProbe: () => Promise<void>; probing: boolean }) {
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [actionError, setActionError] = useState('')
  const [form, setForm] = useState({ name: '', section: 'memory', text: '', triggers: '' })
  const plugins: any[] = data?.plugins || []
  const change = async (operation: () => Promise<unknown>) => {
    if (pending.current || !data || error) return
    pending.current = true; setBusy(true); setActionError('')
    try { await operation(); await onReload() }
    catch (e) { setActionError(e instanceof Error ? e.message : '插件操作失败，请刷新后重试') }
    finally { pending.current = false; setBusy(false) }
  }
  const registerPlugin = () => change(async () => { await EngineApi.registerPlugin(form); setForm({ name: '', section: form.section, text: '', triggers: '' }) })
  const unregisterPlugin = (id: string, core: boolean) => { if (!core) void change(() => EngineApi.unregisterPlugin(id)) }
  const disabled = busy || !data || !!error
  return <section className="border-t border-pi-border-soft py-5" aria-labelledby="engine-gateway-title">
    <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
      <h2 id="engine-gateway-title" className="text-sm font-semibold text-pi-text">Gateway 旁路</h2>
      <button type="button" className="btn-ghost min-h-11" disabled={probing || busy} onClick={() => void onProbe()}><RefreshCw className={`w-4 h-4 ${probing ? 'animate-spin' : ''}`} />探活</button>
    </div>
    <p className="text-sm text-pi-dim mb-3">这套组件负责给主聊天拼提示词。在下面写的提示词插件，挂上后下一句对话就生效，重启也还在。</p>
    {error ? <p role="alert" className="text-sm text-pi-danger mb-3">旁路状态暂不可用{data ? '，以下为上次数据' : '，请重新探活'}。</p> : !data ? <p role="status" className="text-sm text-pi-dim">正在读取旁路状态...</p> : null}
    {data?.probedAt && <p className="text-xs text-pi-dim mb-3">上次读取 {new Date(data.probedAt).toLocaleTimeString('zh-CN', { hour12: false })}</p>}
    <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-3 mb-5 text-sm">
      {Object.entries({ modelAdapter: '模型适配器', toolRegistry: '工具注册表', sessionStore: '会话存储', agentLoop: 'Agent 循环' }).map(([key, label]) => <div key={key} className="min-w-0"><dt className="text-pi-dim">{label}</dt><dd className="text-pi-text break-all mt-1">{data?.components?.[key]?.name || '未取得数据'}</dd></div>)}
    </dl>
    <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
      <h3 className="text-sm font-medium text-pi-text">提示词插件</h3>
      <span className="text-xs text-pi-dim">要加工具，去「插件商店」装工具包</span>
    </div>
    <form className="grid gap-2 mb-4" onSubmit={e => { e.preventDefault(); void registerPlugin() }}>
      <div className="grid sm:grid-cols-[1fr_auto] gap-2">
        <input className="input-pi min-h-11" aria-label="插件名称" placeholder="名称，如：报销规矩" maxLength={40} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
        <select className="input-pi min-h-11" aria-label="放进哪一段" value={form.section} onChange={e => setForm({ ...form, section: e.target.value })}>
          {Object.entries(SECTION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <textarea className="input-pi min-h-24" aria-label="插件内容" placeholder="要小语记住或照做的话，如：报销一律走钉钉审批，发票抬头写公司全称" maxLength={4000} value={form.text} onChange={e => setForm({ ...form, text: e.target.value })} />
      <div className="grid sm:grid-cols-[1fr_auto] gap-2">
        <input className="input-pi min-h-11" aria-label="触发词" placeholder="触发词（可空，逗号分隔；空 = 每句都带）" value={form.triggers} onChange={e => setForm({ ...form, triggers: e.target.value })} />
        <button type="submit" className="btn-primary min-h-11" disabled={disabled || !form.name.trim() || !form.text.trim()}><Plus className="w-4 h-4" />挂上</button>
      </div>
    </form>
    {actionError && <p role="alert" className="text-sm text-pi-danger break-words mb-3">{actionError}</p>}
    <div className="divide-y divide-pi-border-soft">
      {plugins.map(p => <div key={p.id || p.name} className="flex flex-wrap items-center gap-2 py-3 text-sm">
        <Plug className="w-4 h-4 shrink-0 text-pi-dim" /><span className="min-w-0 flex-1 text-pi-text break-all">{p.name}<span className="text-pi-dim ml-2">v{p.version || '?'}</span></span>
        <span className={p.mounted ? 'text-pi-success' : 'text-pi-dim'}>{p.mounted ? '已挂载' : '未挂载'}</span>
        {p.core ? <span className="text-xs text-pi-dim">核心锁定</span> : <button type="button" title={`卸载 ${p.name}`} aria-label={`卸载 ${p.name}`} className="btn-ghost min-h-11 min-w-11" disabled={disabled} onClick={() => unregisterPlugin(p.id || p.name, p.core)}><Trash2 className="w-4 h-4" /></button>}
        {!!p.deps?.length && <p className="basis-full text-xs text-pi-dim break-all">依赖：{p.deps.join(', ')}</p>}
        {p.section && <p className="basis-full text-xs text-pi-dim break-words">进「{SECTION_LABEL[p.section] || p.section}」段 · {p.triggers?.length ? `提到 ${p.triggers.join(' / ')} 时生效` : '每句都生效'}：{String(p.text || '').slice(0, 80)}{String(p.text || '').length > 80 ? '…' : ''}</p>}
      </div>)}
      {data && !plugins.length && <p className="text-sm text-pi-dim py-3">暂无插件</p>}
    </div>
    <details className="mt-4">
      <summary className="min-h-11 py-3 cursor-pointer text-sm text-pi-text">能力清单</summary>
      <div className="divide-y divide-pi-border-soft">{(data?.capabilities || []).map((c: any) => <div key={c.id || c.name} className="py-3 text-sm">
        <div className="flex flex-wrap items-center gap-2 text-pi-text">{c.name}<span className={c.have ? 'text-pi-success' : 'text-pi-dim'}>{c.have ? '已具备' : '规划中'}</span></div>
        <p className="text-pi-dim mt-1 break-words">{c.desc}</p>
      </div>)}</div>
    </details>
  </section>
}
