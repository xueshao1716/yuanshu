import { useState } from 'react'
import useSWR from 'swr'
import { Server, Plus, Trash2, RefreshCw, Power, PowerOff } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { api } from '../api'
import SectionHeader from './SectionHeader'

type McpServerStatus = {
  name: string
  url: string
  transport: string
  enabled: boolean
  connected: boolean
  error: string | null
  toolCount: number
}

type McpServerCfg = {
  name: string
  url: string
  transport: 'streamable-http' | 'sse'
  enabled: boolean
}

const EMPTY: McpServerCfg = { name: '', url: '', transport: 'streamable-http', enabled: true }

export default function McpPanel() {
  const { data, mutate } = useSWR<{ servers: McpServerStatus[] }>('mcp-status', () => api('/api/mcp/status'), { refreshInterval: 15000 })
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState<McpServerCfg>(EMPTY)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const servers = data?.servers || []

  async function saveAndConnect() {
    if (!form.name || !form.url) return
    setBusy('add')
    try {
      // 先保存配置
      const cfg = await api('/api/mcp/config')
      const existing = (cfg.servers || []).filter((s: McpServerCfg) => s.name !== form.name)
      await api('/api/mcp/config', { method: 'POST', body: JSON.stringify({ servers: [...existing, form] }) })
      // 再连接
      const r = await api('/api/mcp/connect', { method: 'POST', body: JSON.stringify(form) })
      setMsg(`已连接，发现 ${r.tools} 个工具`)
      setForm(EMPTY); setAdding(false)
    } catch (e: any) {
      setMsg(`连接失败：${e?.message || '未知错误'}`)
    } finally { setBusy(null); mutate() }
  }

  async function reconnect(name: string) {
    setBusy(name)
    try {
      const r = await api('/api/mcp/reconnect', { method: 'POST', body: JSON.stringify({ name }) })
      setMsg(`已重连，发现 ${r.tools} 个工具`)
    } catch (e: any) {
      setMsg(`重连失败：${e?.message || '未知错误'}`)
    } finally { setBusy(null); mutate() }
  }

  async function remove(name: string) {
    setBusy(name)
    try {
      await api('/api/mcp/disconnect', { method: 'POST', body: JSON.stringify({ name }) })
      const cfg = await api('/api/mcp/config')
      await api('/api/mcp/config', { method: 'POST', body: JSON.stringify({ servers: (cfg.servers || []).filter((s: McpServerCfg) => s.name !== name) }) })
      setMsg(`已移除 ${name}`)
    } catch (e: any) {
      setMsg(`移除失败：${e?.message || '未知错误'}`)
    } finally { setBusy(null); mutate() }
  }

  async function toggleEnabled(s: McpServerStatus) {
    const cfg = await api('/api/mcp/config')
    const servers = (cfg.servers || []).map((x: McpServerCfg) => x.name === s.name ? { ...x, enabled: !s.enabled } : x)
    await api('/api/mcp/config', { method: 'POST', body: JSON.stringify({ servers }) })
    mutate()
  }

  return (
    <div className="space-y-4">
      <SectionHeader
        icon={Server as LucideIcon}
        title="MCP 外部工具"
        description="连接外部 MCP server（如 Windows-MCP），让智能体直接调用桌面、文件、截图等工具"
        actions={
          <button
            onClick={() => setAdding(true)}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
          >
            <Plus size={12} />
            添加 Server
          </button>
        }
      />

      {msg && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400 px-1">{msg}</p>
      )}

      {/* server 列表 */}
      <div className="space-y-2">
        {servers.map(s => (
          <div key={s.name} className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-neutral-50 dark:bg-neutral-800/60 border border-neutral-100 dark:border-neutral-700/50">
            <div className="flex items-center gap-3 min-w-0">
              <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${s.connected ? 'bg-emerald-500' : s.error ? 'bg-red-400' : 'bg-neutral-300 dark:bg-neutral-600'}`} />
              <div className="min-w-0">
                <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200 truncate">{s.name}</p>
                <p className="text-xs text-neutral-400 truncate">{s.url} · {s.transport} · {s.connected ? `${s.toolCount} 个工具` : s.error ? `错误: ${s.error.slice(0, 40)}` : '未连接'}</p>
              </div>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <button
                onClick={() => reconnect(s.name)}
                disabled={busy === s.name}
                className="p-1.5 text-neutral-400 hover:text-blue-500 transition-colors disabled:opacity-40"
                title="重连"
              >
                <RefreshCw size={13} className={busy === s.name ? 'animate-spin' : ''} />
              </button>
              <button
                onClick={() => toggleEnabled(s)}
                className="p-1.5 text-neutral-400 hover:text-neutral-600 transition-colors"
                title={s.enabled ? '禁用' : '启用'}
              >
                {s.enabled ? <Power size={13} /> : <PowerOff size={13} />}
              </button>
              <button
                onClick={() => remove(s.name)}
                disabled={busy === s.name}
                className="p-1.5 text-neutral-400 hover:text-red-500 transition-colors disabled:opacity-40"
                title="移除"
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        ))}

        {servers.length === 0 && !adding && (
          <p className="text-xs text-neutral-400 dark:text-neutral-500 py-2 px-1">
            暂无 MCP server。推荐先安装 Windows-MCP：<code className="bg-neutral-100 dark:bg-neutral-800 px-1 rounded text-xs">uvx windows-mcp serve --transport streamable-http --port 8100</code>，然后在此添加。
          </p>
        )}
      </div>

      {/* 添加表单 */}
      {adding && (
        <div className="space-y-3 p-4 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-neutral-50/50 dark:bg-neutral-800/30">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-neutral-500 mb-1">名称</label>
              <input
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="windows-mcp"
                className="w-full text-sm px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              />
            </div>
            <div>
              <label className="block text-xs text-neutral-500 mb-1">传输方式</label>
              <select
                value={form.transport}
                onChange={e => setForm(f => ({ ...f, transport: e.target.value as 'streamable-http' | 'sse' }))}
                className="w-full text-sm px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              >
                <option value="streamable-http">Streamable HTTP</option>
                <option value="sse">SSE</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs text-neutral-500 mb-1">URL</label>
            <input
              value={form.url}
              onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
              placeholder="http://127.0.0.1:8100/mcp"
              className="w-full text-sm px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
            />
          </div>
          <p className="text-xs text-neutral-400">
            Windows-MCP 默认地址：<code className="bg-neutral-100 dark:bg-neutral-800 px-1 rounded">http://127.0.0.1:8000/mcp</code>（streamable-http）或 <code className="bg-neutral-100 dark:bg-neutral-800 px-1 rounded">http://127.0.0.1:8000/sse</code>（SSE）
          </p>
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => { setAdding(false); setForm(EMPTY) }}
              className="text-sm px-4 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
            >
              取消
            </button>
            <button
              onClick={saveAndConnect}
              disabled={!form.name || !form.url || busy === 'add'}
              className="text-sm px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 transition-colors flex items-center gap-1.5"
            >
              {busy === 'add' && <RefreshCw size={12} className="animate-spin" />}
              保存并连接
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
