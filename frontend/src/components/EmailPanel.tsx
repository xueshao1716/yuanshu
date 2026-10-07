import { useState } from 'react'
import useSWR from 'swr'
import type { LucideIcon } from 'lucide-react'
import { Mail, Play, Square, RefreshCw, Plus, Trash2 } from 'lucide-react'
import { api } from '../api'
import SectionHeader from './SectionHeader'

type EmailAccount = {
  email: string
  provider: 'gmail' | 'outlook'
  enabled: boolean
  clientId: string
  hasRefreshToken: boolean
}

type EmailStatus = {
  running: boolean
  accounts: EmailAccount[]
}

type NewAccount = {
  email: string
  provider: 'gmail' | 'outlook'
  clientId: string
  clientSecret: string
  refreshToken: string
  enabled: boolean
}

const EMPTY: NewAccount = { email: '', provider: 'gmail', clientId: '', clientSecret: '', refreshToken: '', enabled: true }

export default function EmailPanel() {
  const { data: s, mutate } = useSWR<EmailStatus>('email-status', () => api('/api/email/status'), { refreshInterval: 10000 })
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState<NewAccount>(EMPTY)
  const [polling, setPolling] = useState(false)
  const [pollResult, setPollResult] = useState<string | null>(null)

  async function startStop() {
    if (s?.running) await api('/api/email/stop', { method: 'POST' })
    else await api('/api/email/start', { method: 'POST' })
    mutate()
  }

  async function pollNow() {
    setPolling(true); setPollResult(null)
    try {
      const r = await api('/api/email/poll', { method: 'POST' })
      setPollResult(r.mails?.length ? `拉取到 ${r.mails.length} 封新邮件` : '暂无新邮件')
    } catch (e: any) {
      setPollResult(`失败：${e?.message || '未知错误'}`)
    } finally { setPolling(false) }
  }

  async function saveAccount() {
    if (!form.email || !form.clientId || !form.refreshToken) return
    const cfg = await api('/api/email/config')
    const accounts = cfg.accounts || []
    // 合并写回，保留其他账号
    const idx = accounts.findIndex((a: any) => a.email === form.email)
    const full = { email: form.email, provider: form.provider, enabled: form.enabled, clientId: form.clientId, clientSecret: form.clientSecret, refreshToken: form.refreshToken }
    if (idx >= 0) accounts[idx] = full
    else accounts.push(full)
    await api('/api/email/config', { method: 'POST', body: JSON.stringify({ accounts }) })
    setForm(EMPTY); setAdding(false); mutate()
  }

  async function removeAccount(email: string) {
    const cfg = await api('/api/email/config')
    const accounts = (cfg.accounts || []).filter((a: any) => a.email !== email)
    await api('/api/email/config', { method: 'POST', body: JSON.stringify({ accounts }) })
    mutate()
  }

  async function toggleAccount(email: string, enabled: boolean) {
    const cfg = await api('/api/email/config')
    const accounts = (cfg.accounts || []).map((a: any) => a.email === email ? { ...a, enabled } : a)
    await api('/api/email/config', { method: 'POST', body: JSON.stringify({ accounts }) })
    mutate()
  }

  const accounts = s?.accounts || []

  return (
    <div className="space-y-4">
      <SectionHeader
        icon={Mail as LucideIcon}
        title="邮件接入"
        description="Gmail 和 Outlook 新邮件到达时微信通知"
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={pollNow}
              disabled={polling || !accounts.some(a => a.enabled)}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-40 transition-colors"
            >
              <RefreshCw size={12} className={polling ? 'animate-spin' : ''} />
              立即拉取
            </button>
            <button
              onClick={startStop}
              disabled={!accounts.some(a => a.enabled)}
              className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40 ${
                s?.running
                  ? 'bg-red-50 dark:bg-red-950 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800 hover:bg-red-100'
                  : 'bg-emerald-50 dark:bg-emerald-950 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800 hover:bg-emerald-100'
              }`}
            >
              {s?.running ? <><Square size={12} />停止</>  : <><Play size={12} />启动轮询</>}
            </button>
          </div>
        }
      />

      {pollResult && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400 px-1">{pollResult}</p>
      )}

      {/* 已配置账号列表 */}
      <div className="space-y-2">
        {accounts.map(acc => (
          <div key={acc.email} className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-neutral-50 dark:bg-neutral-800/60 border border-neutral-100 dark:border-neutral-700/50">
            <div className="flex items-center gap-3 min-w-0">
              <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${acc.enabled ? 'bg-emerald-500' : 'bg-neutral-300 dark:bg-neutral-600'}`} />
              <div className="min-w-0">
                <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200 truncate">{acc.email}</p>
                <p className="text-xs text-neutral-400 capitalize">{acc.provider} · {acc.hasRefreshToken ? '凭证已配置' : '缺少凭证'}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={() => toggleAccount(acc.email, !acc.enabled)}
                className={`text-xs px-2 py-1 rounded-md transition-colors ${acc.enabled ? 'text-neutral-500 hover:text-neutral-700' : 'text-neutral-400 hover:text-neutral-600'}`}
              >
                {acc.enabled ? '禁用' : '启用'}
              </button>
              <button
                onClick={() => removeAccount(acc.email)}
                className="text-neutral-400 hover:text-red-500 transition-colors p-1"
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        ))}

        {accounts.length === 0 && !adding && (
          <p className="text-xs text-neutral-400 dark:text-neutral-500 py-2 px-1">暂无账号，点击下方添加</p>
        )}
      </div>

      {/* 添加账号表单 */}
      {adding ? (
        <div className="space-y-3 p-4 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-neutral-50/50 dark:bg-neutral-800/30">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-neutral-500 mb-1">邮箱地址</label>
              <input
                value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                placeholder="your@gmail.com"
                className="w-full text-sm px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              />
            </div>
            <div>
              <label className="block text-xs text-neutral-500 mb-1">服务商</label>
              <select
                value={form.provider}
                onChange={e => setForm(f => ({ ...f, provider: e.target.value as 'gmail' | 'outlook' }))}
                className="w-full text-sm px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              >
                <option value="gmail">Gmail</option>
                <option value="outlook">Outlook</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs text-neutral-500 mb-1">Client ID</label>
            <input
              value={form.clientId}
              onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))}
              placeholder="OAuth2 Client ID"
              className="w-full text-sm px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
            />
          </div>
          <div>
            <label className="block text-xs text-neutral-500 mb-1">Client Secret</label>
            <input
              type="password"
              value={form.clientSecret}
              onChange={e => setForm(f => ({ ...f, clientSecret: e.target.value }))}
              placeholder="OAuth2 Client Secret"
              className="w-full text-sm px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
            />
          </div>
          <div>
            <label className="block text-xs text-neutral-500 mb-1">Refresh Token</label>
            <input
              type="password"
              value={form.refreshToken}
              onChange={e => setForm(f => ({ ...f, refreshToken: e.target.value }))}
              placeholder="OAuth2 Refresh Token"
              className="w-full text-sm px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
            />
          </div>
          <p className="text-xs text-neutral-400">
            {form.provider === 'gmail'
              ? 'Gmail：在 Google Cloud Console 创建 OAuth2 凭证，授权 Gmail API，用 OAuth Playground 获取 Refresh Token。'
              : 'Outlook：在 Azure Portal 注册应用，授权 Mail.Read，用授权码流获取 Refresh Token。'}
          </p>
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => { setAdding(false); setForm(EMPTY) }}
              className="text-sm px-4 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
            >
              取消
            </button>
            <button
              onClick={saveAccount}
              disabled={!form.email || !form.clientId || !form.refreshToken}
              className="text-sm px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 transition-colors"
            >
              保存
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors"
        >
          <Plus size={14} />
          添加邮箱账号
        </button>
      )}
    </div>
  )
}
