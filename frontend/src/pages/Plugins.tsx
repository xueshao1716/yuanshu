import { useState } from 'react'
import useSWR from 'swr'
import { api } from '../api'
import { Puzzle, Download, Trash2, Power, RefreshCw, AlertTriangle, ShieldCheck } from 'lucide-react'

type Installed = {
  id: string; name: string; version: string; type: string; description?: string
  installedAt?: number; dir?: string; enabled: boolean; exists: boolean
}
type CatalogItem = {
  id: string; name: string; version: string; type: string; description?: string
  author?: string; permissions?: string[]; installable: boolean; error?: string
}
type Payload = { ok: boolean; installed: Installed[]; catalog: { ok: boolean; items: CatalogItem[]; source?: string; error?: string } }

const typeLabel = (t: string) => (t === 'skill' ? '技能包' : t === 'mcp' ? 'MCP 连接' : t)
const date = (n?: number) => (n ? new Date(n).toLocaleDateString('zh-CN') : '—')

export default function Plugins() {
  const { data, mutate, isValidating } = useSWR<Payload>('plugins-store', () => api('/api/plugins'), { refreshInterval: 30000 })
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const installed = data?.installed || []
  const catalog = data?.catalog?.items || []
  const installedIds = new Set(installed.map((p) => p.id))

  const run = async (key: string, fn: () => Promise<unknown>, okText: string) => {
    setBusy(key); setMsg('')
    try { await fn(); setMsg(okText); await mutate() }
    catch (e: any) { setMsg(`操作失败：${e?.message || '未知错误'}`) }
    finally { setBusy('') }
  }

  return (
    <div className="page-enter mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title mb-1">插件商店</h1>
          <p className="text-xs text-pi-dim2">装的是「技能包」和「MCP 连接」——不会静默执行来路不明的代码。</p>
        </div>
        <button className="btn-tool min-h-10 px-3 text-[12px]" onClick={() => void mutate()} disabled={isValidating}>
          <RefreshCw className={`mr-1 inline h-3.5 w-3.5 ${isValidating ? 'animate-spin' : ''}`} /> 刷新
        </button>
      </div>

      {msg && <div role="status" className="panel mb-4 !p-3 text-[12.5px] text-pi-text">{msg}</div>}

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[15px] font-semibold text-pi-text">可安装</h2>
          <span className="text-xs text-pi-dim2">{catalog.length} 个 · 来自 {data?.catalog?.source || '工作区/插件/catalog.json'}</span>
        </div>
        {data?.catalog?.error && <p className="text-xs text-pi-dim2">{data.catalog.error}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          {catalog.map((p) => {
            const has = installedIds.has(p.id)
            return (
              <article key={p.id} className="panel !p-3.5 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Puzzle className="h-4 w-4 shrink-0 text-pi-accent" />
                      <h3 className="truncate text-[13.5px] font-medium text-pi-text">{p.name}</h3>
                      <span className="rounded-pi-pill bg-pi-bg3 px-1.5 py-px text-[10px] text-pi-dim2">{typeLabel(p.type)}</span>
                    </div>
                    <p className="mt-1 text-[11px] text-pi-dim2">v{p.version}{p.author ? ` · ${p.author}` : ''}</p>
                  </div>
                  <button
                    className="btn-primary shrink-0 px-3 py-1 text-[12px] disabled:opacity-50"
                    disabled={!!busy || has || !p.installable}
                    onClick={() => void run(`install:${p.id}`, () => api('/api/plugins/install', { method: 'POST', body: { id: p.id } }), `已安装：${p.name}`)}
                  >
                    <Download className="mr-1 inline h-3.5 w-3.5" />{has ? '已装' : '安装'}
                  </button>
                </div>
                {p.description && <p className="text-[12px] leading-5 text-pi-dim">{p.description}</p>}
                {!!p.permissions?.length && (
                  <p className="flex items-center gap-1 text-[11px] text-pi-dim2">
                    <ShieldCheck className="h-3 w-3" /> 需要：{p.permissions.join('、')}
                  </p>
                )}
                {!p.installable && (
                  <p className="flex items-center gap-1 text-[11px] text-pi-red">
                    <AlertTriangle className="h-3 w-3" /> 这个包不合规：{p.error}
                  </p>
                )}
              </article>
            )
          })}
        </div>
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
                  <div className="flex items-center gap-2">
                    <Puzzle className="h-4 w-4 shrink-0 text-pi-accent" />
                    <span className="text-[13.5px] font-medium text-pi-text">{p.name}</span>
                    <span className="rounded-pi-pill bg-pi-bg3 px-1.5 py-px text-[10px] text-pi-dim2">{typeLabel(p.type)}</span>
                    <span className={`rounded-pi-pill px-1.5 py-px text-[10px] ${p.enabled ? 'bg-pi-accent/15 text-pi-accent' : 'bg-pi-bg3 text-pi-dim2'}`}>
                      {p.enabled ? '已启用' : '已停用'}
                    </span>
                    {!p.exists && <span className="text-[10px] text-pi-red">目录丢了</span>}
                  </div>
                  <p className="mt-1 text-[11px] text-pi-dim2">v{p.version} · 装于 {date(p.installedAt)}{p.dir ? ` · ${p.dir}` : ''}</p>
                  {p.description && <p className="mt-1 text-[12px] leading-5 text-pi-dim">{p.description}</p>}
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    className="btn-tool min-h-9 px-2.5 text-[12px] disabled:opacity-50"
                    disabled={!!busy || !p.exists}
                    onClick={() => void run(`toggle:${p.id}`, () => api('/api/plugins/toggle', { method: 'POST', body: { id: p.id, on: !p.enabled } }), p.enabled ? `已停用：${p.name}` : `已启用：${p.name}`)}
                  >
                    <Power className="mr-1 inline h-3.5 w-3.5" />{p.enabled ? '停用' : '启用'}
                  </button>
                  <button
                    className="btn-tool min-h-9 px-2.5 text-[12px] text-pi-red disabled:opacity-50"
                    disabled={!!busy}
                    onClick={() => void run(`rm:${p.id}`, () => api('/api/plugins/uninstall', { method: 'POST', body: { id: p.id } }), `已卸载：${p.name}`)}
                  >
                    <Trash2 className="mr-1 inline h-3.5 w-3.5" />卸载
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel mt-6 !p-3.5 text-[12px] leading-6 text-pi-dim">
        <h3 className="mb-1 text-[13px] font-semibold text-pi-text">这里装的是什么</h3>
        <p>· <b>技能包</b>：一个带 <code>SKILL.md</code> 的目录，装到 <code>工作区/插件/&lt;id&gt;/</code>，她会在需要时自己取用。</p>
        <p>· <b>MCP 连接</b>：只写一份配置，<b>不会自动连</b>——到「能力 → MCP」点连接才算真的接上。</p>
        <p>· 目录来自 <code>工作区/插件/catalog.json</code>；想自己加包，往这个文件里加一条即可（格式见任意内置条目）。</p>
      </section>
    </div>
  )
}
