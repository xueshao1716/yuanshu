import { useEffect, useRef, useState } from 'react'
import * as AL from '@radix-ui/react-alert-dialog'
import { Plus, KeyRound } from 'lucide-react'
import { KeysApi } from '../api'
import { useApp } from '../store'
import ModelConnectionForm from './models/ModelConnectionForm'
import type { ConnectionProvider } from './models/ModelConnectionForm'

export default function ModelChannels() {
  const { refreshModels } = useApp()
  const [providers, setProviders] = useState<ConnectionProvider[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<ConnectionProvider | 'new' | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const lock = useRef(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const load = async () => {
    setLoading(true)
    try { const data = await KeysApi.manage(); setProviders(data.providers || []) }
    catch (e) { setError(e instanceof Error ? e.message : '服务商加载失败，请重试') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  const saved = async (text: string) => {
    setEditing(null); setMessage(text); setError('')
    await load()
    try { await refreshModels() } catch { setError('配置已保存，但模型列表刷新失败，请刷新页面') }
  }
  const operate = async (provider: string, remove = false) => {
    if (lock.current) return
    lock.current = true; setBusy(provider); setError(''); setMessage('')
    try {
      const result = remove ? await KeysApi.remove(provider) : await KeysApi.add({ provider })
      setConfirming(null)
      await saved(remove ? `已移除 ${provider}` : result.warning || `目录已刷新 · 发现 ${result.discoveredCount} 个，保留共 ${result.modelCount} 个模型。调用状态需单独验证。`)
    } catch (e) { setError(e instanceof Error ? e.message : '操作失败，请重试') }
    finally { lock.current = false; setBusy('') }
  }
  return (
    <section className="panel !p-4 mb-6" aria-label="服务商通道">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-pi-text flex items-center gap-2"><KeyRound className="w-4 h-4 text-pi-accent" />服务商通道</h2>
        <button className="btn-primary touch-hit px-3 text-sm inline-flex items-center gap-1.5" disabled={Boolean(busy || editing)}
          onClick={() => { setEditing('new'); setError(''); setMessage('') }}><Plus className="w-4 h-4" />添加 API</button>
      </div>
      <p className="text-sm text-pi-dim mt-2 mb-3">接入密钥与协议，读取模型目录，再按需验证。</p>
      {message && <p role="status" className="text-sm text-pi-success my-3 break-words">{message}</p>}
      {error && <div role="alert" className="text-sm text-pi-danger my-3 break-words">{error}
        <button className="btn-tool touch-hit ml-2" disabled={Boolean(busy)} onClick={() => { setError(''); void load() }}>重载列表</button>
      </div>}
      {editing && <ModelConnectionForm existing={editing === 'new' ? undefined : editing} onSaved={saved} onCancel={() => setEditing(null)} />}
      {loading ? <p role="status" className="py-4 text-sm text-pi-dim">正在读取服务商…</p> : !providers.length ?
        <p className="py-4 text-sm text-pi-dim">尚未配置服务商，点击「添加 API」开始。</p> :
        <ul className="divide-y divide-pi-border-soft">
          {providers.map(p => <li key={p.provider} className="py-3 flex flex-col sm:flex-row sm:items-center gap-2">
            <div className="min-w-0 flex-1">
              <h3 className="font-medium text-sm text-pi-text break-all">{p.provider}</h3>
              <p className="text-sm text-pi-dim break-all">{p.modelCount} 个已配置 · {p.hasKey ? '密钥已保存' : '缺少密钥'} · {p.api === 'anthropic-messages' ? 'Messages' : 'OpenAI Chat'}</p>
              <p className="text-sm text-pi-dim truncate" title={p.baseUrl}>{p.baseUrl || '专用服务商接口'}</p>
            </div>
            <div className="flex gap-1 flex-wrap">
              <button className="btn-tool touch-hit text-sm" disabled={Boolean(busy || editing)} onClick={() => void operate(p.provider)}>{busy === p.provider ? '处理中…' : '重新发现'}</button>
              <button className="btn-tool touch-hit text-sm" disabled={Boolean(busy || editing)} onClick={() => { setEditing(p); setError(''); setMessage('') }}>编辑</button>
              <button className="btn-tool touch-hit text-sm hover:!text-pi-danger" aria-label={`移除 ${p.provider}`} disabled={Boolean(busy || editing)} onClick={() => setConfirming(p.provider)}>移除</button>
            </div>
          </li>)}
        </ul>}
      <AL.Root open={Boolean(confirming)} onOpenChange={open => { if (!open && !busy) setConfirming(null) }}>
        <AL.Portal><AL.Overlay className="fixed inset-0 bg-black/50 z-[var(--pi-z-modal)]" />
          <AL.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(92vw,440px)] bg-pi-bg panel !p-5 z-[var(--pi-z-modal)]">
            <AL.Title className="text-base font-semibold text-pi-text">移除 {confirming}？</AL.Title>
            <AL.Description className="text-sm text-pi-dim my-3">将删除此服务商的密钥和模型配置，需要重新接入后才能使用。</AL.Description>
            {error && <p role="alert" className="text-sm text-pi-danger">{error}</p>}
            <div className="flex justify-end gap-2">
              <AL.Cancel className="btn-tool touch-hit" disabled={Boolean(busy)}>取消</AL.Cancel>
              <button className="btn-primary touch-hit px-4" disabled={Boolean(busy)} onClick={() => confirming && void operate(confirming, true)}>{busy ? '移除中…' : '确认移除'}</button>
            </div>
          </AL.Content>
        </AL.Portal>
      </AL.Root>
    </section>
  )
}
