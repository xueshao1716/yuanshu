import { useState } from 'react'
import useSWR from 'swr'
import { api } from '../api'
import { Puzzle, Download, Trash2, Power, RefreshCw, AlertTriangle, ShieldCheck, RotateCcw, Play, CloudDownload, KeyRound } from 'lucide-react'

type Installed = {
  id: string; name: string; version: string; type: string; description?: string
  installedAt?: number; dir?: string; enabled: boolean; exists: boolean
}
type CatalogItem = {
  id: string; name: string; version: string; type: string; description?: string
  author?: string; permissions?: string[]; installable: boolean; error?: string
  signed?: boolean; signReason?: string
}
type Payload = { ok: boolean; installed: Installed[]; catalog: { ok: boolean; items: CatalogItem[]; source?: string; error?: string } }
type Registry = { ok: boolean; url: string; requireSigned: boolean; publicKey: string; lastFetchAt: number; lastError: string; remoteItems: CatalogItem[] }
type History = { version: string; at: number; fromVersion?: string; backupDir?: string }
type Toolpack = { id: string; name: string; version: string; tools: { name: string; description: string }[] }

const typeLabel = (t: string) => (t === 'skill' ? '技能包' : t === 'mcp' ? 'MCP 连接' : t === 'toolpack' ? '工具包' : t)
const date = (n?: number) => (n ? new Date(n).toLocaleDateString('zh-CN') : '—')

export default function Plugins() {
  const { data, mutate, isValidating } = useSWR<Payload>('plugins-store', () => api('/api/plugins'), { refreshInterval: 30000 })
  const reg = useSWR<Registry>('plugins-registry', () => api('/api/plugins/registry'), { refreshInterval: 60000 })
  const packs = useSWR<{ packs: Toolpack[] }>('plugins-toolpacks', () => api('/api/plugins/toolpacks'), { refreshInterval: 30000 })
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [url, setUrl] = useState<string | null>(null)
  const [signed, setSigned] = useState<boolean | null>(null)
  const [pubkey, setPubkey] = useState<string | null>(null)
  const [tryOut, setTryOut] = useState<Record<string, string>>({})

  const installed = data?.installed || []
  const catalog = data?.catalog?.items || []
  const remote = reg.data?.remoteItems || []
  const installedIds = new Set(installed.map((p) => p.id))

  const run = async (key: string, fn: () => Promise<unknown>, okText: string, after?: () => void) => {
    setBusy(key); setMsg('')
    try { await fn(); setMsg(okText); await mutate(); after?.() }
    catch (e: any) { setMsg(`操作失败：${e?.message || '未知错误'}`) }
    finally { setBusy('') }
  }

  const saveRegistry = () => void run('registry', () => api('/api/plugins/registry', {
    method: 'POST',
    body: { url: url ?? reg.data?.url ?? '', requireSigned: signed ?? reg.data?.requireSigned ?? false, publicKey: pubkey ?? reg.data?.publicKey ?? '' },
  }), '远程源已保存', () => { void reg.mutate(); setUrl(null); setSigned(null); setPubkey(null) })

  const refreshRemote = () => void run('remote', () => api('/api/plugins/remote-refresh', { method: 'POST', body: {} }), '远程目录已刷新', () => void reg.mutate())

  const card = (p: CatalogItem, fromRemote: boolean) => {
    const has = installedIds.has(p.id)
    const key = `${fromRemote ? 'r' : 'l'}:${p.id}`
    return (
      <article key={key} className="panel !p-3.5 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Puzzle className="h-4 w-4 shrink-0 text-pi-accent" />
              <h3 className="truncate text-[13.5px] font-medium text-pi-text">{p.name}</h3>
              <span className="rounded-pi-pill bg-pi-bg3 px-1.5 py-px text-[10px] text-pi-dim2">{typeLabel(p.type)}</span>
              {fromRemote && (p.signed
                ? <span className="rounded-pi-pill bg-pi-accent/15 px-1.5 py-px text-[10px] text-pi-accent">已签名</span>
                : <span className="rounded-pi-pill bg-pi-bg3 px-1.5 py-px text-[10px] text-pi-dim2">未签名</span>)}
            </div>
            <p className="mt-1 text-[11px] text-pi-dim2">v{p.version}{p.author ? ` · ${p.author}` : ''}</p>
          </div>
          <button
            className="btn-primary shrink-0 px-3 py-1 text-[12px] disabled:opacity-50"
            disabled={!!busy || has || !p.installable}
            onClick={() => void run(`install:${key}`, () => api(fromRemote ? '/api/plugins/install-remote' : '/api/plugins/install', { method: 'POST', body: { id: p.id } }), `已安装：${p.name}`)}
          >
            <Download className="mr-1 inline h-3.5 w-3.5" />{has ? '已装' : '安装'}
          </button>
        </div>
        {p.description && <p className="text-[12px] leading-5 text-pi-dim">{p.description}</p>}
        {!!p.permissions?.length && <p className="flex items-center gap-1 text-[11px] text-pi-dim2"><ShieldCheck className="h-3 w-3" /> 需要：{p.permissions.join('、')}</p>}
        {!p.installable && <p className="flex items-center gap-1 text-[11px] text-pi-red"><AlertTriangle className="h-3 w-3" /> {p.error}</p>}
      </article>
    )
  }

  return (
    <div className="page-enter mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title mb-1">插件商店</h1>
          <p className="text-xs text-pi-dim2">技能包 / MCP 连接 / 工具包。工具包在隔离环境里跑，权限逐项核对。</p>
        </div>
        <button className="btn-tool min-h-10 px-3 text-[12px]" onClick={() => void mutate()} disabled={isValidating}>
          <RefreshCw className={`mr-1 inline h-3.5 w-3.5 ${isValidating ? 'animate-spin' : ''}`} /> 刷新
        </button>
      </div>

      {msg && <div role="status" className="panel mb-4 !p-3 text-[12.5px] text-pi-text">{msg}</div>}

      <section className="panel mb-5 !p-3.5 space-y-2">
        <div className="flex items-center gap-2">
          <CloudDownload className="h-4 w-4 text-pi-accent" />
          <h2 className="text-[13.5px] font-semibold text-pi-text">远程源</h2>
          <span className="text-[11px] text-pi-dim2">
            {reg.data?.url ? `已配置 · ${reg.data.lastFetchAt ? `上次刷新 ${new Date(reg.data.lastFetchAt).toLocaleString('zh-CN', { hour12: false })}` : '还没刷新'}` : '未配置（只用本地目录）'}
          </span>
        </div>
        <input
          value={url ?? reg.data?.url ?? ''} onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/yuanshu-plugins.json"
          className="min-h-10 w-full rounded-pi-md border border-pi-border-soft bg-pi-bg2 px-3 text-[12.5px] text-pi-text"
        />
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-[12px] text-pi-text">
            <input type="checkbox" checked={signed ?? reg.data?.requireSigned ?? false} onChange={(e) => setSigned(e.target.checked)} />
            只接受已签名（ed25519）
          </label>
          <button className="btn-tool min-h-9 px-3 text-[12px] disabled:opacity-50" disabled={!!busy} onClick={saveRegistry}>保存</button>
          <button className="btn-primary min-h-9 px-3 text-[12px] disabled:opacity-50" disabled={!!busy || !(url ?? reg.data?.url)} onClick={refreshRemote}>刷新远程目录</button>
        </div>
        <details>
          <summary className="cursor-pointer text-[12px] text-pi-dim2"><KeyRound className="mr-1 inline h-3 w-3" />公钥（校验签名用，PEM）</summary>
          <textarea
            value={pubkey ?? reg.data?.publicKey ?? ''} onChange={(e) => setPubkey(e.target.value)}
            rows={4} placeholder="-----BEGIN PUBLIC KEY-----&#10;…&#10;-----END PUBLIC KEY-----"
            className="mt-2 w-full rounded-pi-md border border-pi-border-soft bg-pi-bg2 px-3 py-2 font-mono text-[11px] text-pi-text"
          />
        </details>
        {reg.data?.lastError && <p className="text-[11px] text-pi-red">上次刷新失败：{reg.data.lastError}</p>}
        {remote.length > 0 && <div className="grid gap-3 pt-2 sm:grid-cols-2">{remote.map((p) => card(p, true))}</div>}
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[15px] font-semibold text-pi-text">本地目录</h2>
          <span className="text-xs text-pi-dim2">{catalog.length} 个 · {data?.catalog?.source || '工作区/插件/catalog.json'}</span>
        </div>
        {data?.catalog?.error && <p className="text-xs text-pi-dim2">{data.catalog.error}</p>}
        <div className="grid gap-3 sm:grid-cols-2">{catalog.map((p) => card(p, false))}</div>
      </section>

      <section className="mt-6 space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[15px] font-semibold text-pi-text">已安装</h2>
          <span className="text-xs text-pi-dim2">{installed.filter((p) => p.enabled).length} 个启用 · 共 {installed.length} 个</span>
        </div>
        {installed.length === 0 && <p className="text-xs text-pi-dim2">还没装任何插件。上面挑一个装上试试。</p>}
        <ul className="space-y-2">
          {installed.map((p) => (
            <li key={p.id} className="panel !p-3.5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Puzzle className="h-4 w-4 shrink-0 text-pi-accent" />
                    <span className="text-[13.5px] font-medium text-pi-text">{p.name}</span>
                    <span className="rounded-pi-pill bg-pi-bg3 px-1.5 py-px text-[10px] text-pi-dim2">{typeLabel(p.type)}</span>
                    <span className={`rounded-pi-pill px-1.5 py-px text-[10px] ${p.enabled ? 'bg-pi-accent/15 text-pi-accent' : 'bg-pi-bg3 text-pi-dim2'}`}>{p.enabled ? '已启用' : '已停用'}</span>
                    {!p.exists && <span className="text-[10px] text-pi-red">目录丢了</span>}
                  </div>
                  <p className="mt-1 text-[11px] text-pi-dim2">v{p.version} · 装于 {date(p.installedAt)}</p>
                  {p.description && <p className="mt-1 text-[12px] leading-5 text-pi-dim">{p.description}</p>}
                </div>
                <div className="flex shrink-0 gap-2">
                  <button className="btn-tool min-h-9 px-2.5 text-[12px] disabled:opacity-50" disabled={!!busy || !p.exists}
                    onClick={() => void run(`toggle:${p.id}`, () => api('/api/plugins/toggle', { method: 'POST', body: { id: p.id, on: !p.enabled } }), p.enabled ? `已停用：${p.name}` : `已启用：${p.name}`)}>
                    <Power className="mr-1 inline h-3.5 w-3.5" />{p.enabled ? '停用' : '启用'}
                  </button>
                  <button className="btn-tool min-h-9 px-2.5 text-[12px] disabled:opacity-50" disabled={!!busy}
                    onClick={() => void run(`rollback:${p.id}`, () => api('/api/plugins/rollback', { method: 'POST', body: { id: p.id } }), `已回滚：${p.name}`)}>
                    <RotateCcw className="mr-1 inline h-3.5 w-3.5" />回滚
                  </button>
                  <button className="btn-tool min-h-9 px-2.5 text-[12px] text-pi-red disabled:opacity-50" disabled={!!busy}
                    onClick={() => void run(`rm:${p.id}`, () => api('/api/plugins/uninstall', { method: 'POST', body: { id: p.id } }), `已卸载：${p.name}`)}>
                    <Trash2 className="mr-1 inline h-3.5 w-3.5" />卸载
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {(packs.data?.packs?.length || 0) > 0 && (
        <section className="mt-6 space-y-3">
          <h2 className="text-[15px] font-semibold text-pi-text">工具包试跑</h2>
          {packs.data!.packs.map((pack) => (
            <div key={pack.id} className="panel !p-3.5 space-y-2">
              <p className="text-[13px] font-medium text-pi-text">{pack.name} <span className="text-[11px] font-normal text-pi-dim2">v{pack.version}</span></p>
              {pack.tools.map((t) => (
                <div key={t.name} className="space-y-1.5 border-t border-pi-border-soft pt-2">
                  <p className="text-[12.5px] text-pi-text">{t.name}<span className="ml-2 text-[11px] text-pi-dim2">{t.description}</span></p>
                  <div className="flex gap-2">
                    <input value={tryOut[`${pack.id}:${t.name}`] ?? ''} onChange={(e) => setTryOut({ ...tryOut, [`${pack.id}:${t.name}`]: e.target.value })}
                      placeholder='参数 JSON，例如 {"url":"https://example.com"}'
                      className="min-h-9 flex-1 rounded-pi-md border border-pi-border-soft bg-pi-bg2 px-2 text-[11.5px] text-pi-text" />
                    <button className="btn-tool min-h-9 px-2.5 text-[12px] disabled:opacity-50" disabled={!!busy}
                      onClick={() => void run(`try:${pack.id}:${t.name}`, async () => {
                        let args = {}
                        const raw = (tryOut[`${pack.id}:${t.name}`] ?? '').trim()
                        if (raw) { try { args = JSON.parse(raw) } catch { throw new Error('参数不是合法 JSON') } }
                        const out: any = await api('/api/plugins/run-tool', { method: 'POST', body: { id: pack.id, tool: t.name, args } })
                        setMsg(out?.ok ? `试跑成功：${String(out.text || '').slice(0, 300)}` : `试跑失败：${out?.error || '未知'}`)
                      }, '试跑完成')}>
                      <Play className="mr-1 inline h-3.5 w-3.5" />试跑
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </section>
      )}

      <section className="panel mt-6 !p-3.5 text-[12px] leading-6 text-pi-dim">
        <h3 className="mb-1 text-[13px] font-semibold text-pi-text">这里装的是什么</h3>
        <p>· <b>技能包</b>：带 <code>SKILL.md</code> 的目录，装到 <code>工作区/插件/&lt;id&gt;/</code>，她需要时自己取用。</p>
        <p>· <b>MCP 连接</b>：只写配置，<b>不会自动连</b>——到「能力 → MCP」点连接才算接上。</p>
        <p>· <b>工具包</b>：声明式工具（函数体字符串），在 worker 里跑；<code>net/fs/exec</code> 权限按需声明，越界和超时都会拒。</p>
        <p>· 目录来自 <code>工作区/插件/catalog.json</code>；远程源可选 ed25519 签名，开了「只接受已签名」就只认签名通过的包。</p>
      </section>
    </div>
  )
}
