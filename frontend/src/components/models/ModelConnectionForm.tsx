import { useEffect, useRef, useState } from 'react'
import { KeysApi } from '../../api'

export interface ConnectionProvider { provider: string; baseUrl: string; api?: string; hasKey: boolean; modelCount: number }
type Preset = { name: string; baseUrl: string; api?: string }

export default function ModelConnectionForm({ existing, onSaved, onCancel }: {
  existing?: ConnectionProvider; onSaved: (message: string) => Promise<void>; onCancel: () => void
}) {
  const [presets, setPresets] = useState<Record<string, Preset>>({})
  const [provider, setProvider] = useState(existing?.provider || '')
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl || '')
  const [api, setApi] = useState(existing?.api || 'openai-completions')
  const [key, setKey] = useState('')
  const [account, setAccount] = useState('')
  const [ids, setIds] = useState('')
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<{ models: { id: string }[]; source: string } | null>(null)
  useEffect(() => { let mounted = true; KeysApi.presets().then(r => { if (mounted) setPresets(r.presets || {}) }).catch(() => {
    if (mounted) setError('预设暂时无法加载，仍可手动填写服务商和地址。')
  }); return () => { mounted = false } }, [])
  const changed = (update: () => void) => { update(); setPreview(null); setError('') }
  const body = () => ({ provider: provider.trim(), key: key.trim(), baseUrl: baseUrl.trim(), api,
    ...(account.trim() ? { account_id: account.trim() } : {}),
    ...(ids.trim() ? { modelIds: ids.split(/\r?\n/).map(id => id.trim()).filter(Boolean) } : {}) })
  const submit = async (save: boolean) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try {
      if (!provider.trim() || (!key.trim() && !existing?.hasKey)) throw new Error('请填写服务商名称和 API Key')
      if (save) {
        const result = await KeysApi.add(body())
        await onSaved(result.warning || `已保存 ${provider} · ${result.modelCount} 个已配置模型。请按需验证文本调用。`)
      } else setPreview(await KeysApi.discover(body()))
    } catch (e) { setError(e instanceof Error ? e.message : '接入失败，请检查地址、协议和密钥后重试') }
    finally { lock.current = false; setBusy(false) }
  }
  return (
    <form className="space-y-4 py-4 border-t border-pi-border-soft" aria-label={existing ? '编辑服务商' : '添加 API'} aria-busy={busy}
      onSubmit={e => { e.preventDefault(); void submit(Boolean(preview)) }}>
      <p className="text-sm text-pi-dim">发现模型只读取目录，不会自动生图或逐个调用。保存后可单独验证文本响应。</p>
      <fieldset disabled={busy} className="space-y-3 min-w-0">
        {!existing && <label className="block text-sm text-pi-text">服务商预设
          <select className="input-pi mt-1 !text-base" defaultValue="" onChange={e => changed(() => {
            const preset = presets[e.target.value]; setProvider(e.target.value); setBaseUrl(preset?.baseUrl || ''); setApi(preset?.api || 'openai-completions')
          })}><option value="">自定义接入</option>{Object.entries(presets).map(([id, p]) => <option key={id} value={id}>{p.name}</option>)}</select>
        </label>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block text-sm text-pi-text">服务商名称
            <input className="input-pi mt-1 !text-base" value={provider} readOnly={Boolean(existing)} required maxLength={100} pattern="[A-Za-z0-9_-]+"
              placeholder="例如 my-provider" onChange={e => changed(() => setProvider(e.target.value))} />
          </label>
          <label className="block text-sm text-pi-text">接口协议
            <select className="input-pi mt-1 !text-base" value={api} onChange={e => changed(() => setApi(e.target.value))}>
              <option value="openai-completions">OpenAI Chat</option><option value="anthropic-messages">Anthropic Messages</option>
            </select>
          </label>
        </div>
        <label className="block text-sm text-pi-text">API Key{existing?.hasKey ? '（留空沿用已保存密钥）' : ''}
          <input className="input-pi mt-1 !text-base" type="password" autoComplete="new-password" value={key} required={!existing?.hasKey}
            onChange={e => changed(() => setKey(e.target.value))} />
        </label>
        {provider === 'cloudflare-ai' ? <label className="block text-sm text-pi-text">Account ID{existing ? '（留空沿用）' : ''}
          <input className="input-pi mt-1 !text-base" value={account} onChange={e => changed(() => setAccount(e.target.value))} />
        </label> : <label className="block text-sm text-pi-text">API 地址
          <input className="input-pi mt-1 !text-base" type="url" required value={baseUrl} placeholder="https://api.example.com/v1"
            onChange={e => changed(() => setBaseUrl(e.target.value))} />
          <span className="block text-sm text-pi-dim mt-1">支持完整版本路径；协议请以服务商文档为准。</span>
        </label>}
        <label className="block text-sm text-pi-text">手动模型 ID（可选，每行一个）
          <textarea className="input-pi mt-1 !text-base font-mono" rows={3} value={ids} onChange={e => changed(() => setIds(e.target.value))} />
          <span className="block text-sm text-pi-dim mt-1">服务商不提供模型目录时填写。手动登记不代表调用已通过。</span>
        </label>
      </fieldset>
      {preview && <div role="status" className="space-y-2 text-sm text-pi-text">
        <p>{preview.source === 'manual' ? '待手动登记' : '目录已发现'} {preview.models.length} 个模型 · 尚未验证调用</p>
        <div className="max-h-36 overflow-y-auto font-mono text-pi-dim break-all">{preview.models.slice(0, 80).map(m => <div key={m.id}>{m.id}</div>)}{preview.models.length > 80 && <p>其余 {preview.models.length - 80} 个也会保存</p>}</div>
      </div>}
      {error && <p role="alert" className="text-sm text-pi-danger break-words">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className="btn-primary touch-hit px-4">{busy ? '处理中…' : preview ? '保存接入' : ids.trim() ? '预览手动登记' : '发现模型'}</button>
        <button type="button" disabled={busy} className="btn-tool touch-hit" onClick={onCancel}>取消</button>
      </div>
    </form>
  )
}
