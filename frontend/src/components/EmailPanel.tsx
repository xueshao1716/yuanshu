import ThemedSelect from '../components/ThemedSelect'
import { useState } from 'react'
import useSWR from 'swr'
import type { LucideIcon } from 'lucide-react'
import { Mail, Play, Square, RefreshCw, Plus, Trash2 } from 'lucide-react'
import { api } from '../api'
import SectionHeader from './SectionHeader'

// 账号类型：QQ/163/126 与「其他 IMAP」用邮箱地址 + 授权码；Gmail/Outlook 用 OAuth 凭证
type Kind = 'qq' | '163' | '126' | 'imap' | 'gmail' | 'outlook'

const KIND_LABEL: Record<Kind, string> = {
  qq: 'QQ 邮箱（授权码）',
  '163': '163 邮箱（授权码）',
  '126': '126 邮箱（授权码）',
  imap: '其他 IMAP（授权码）',
  gmail: 'Gmail（OAuth）',
  outlook: 'Outlook（OAuth）',
}

const KIND_HINT: Record<Kind, string> = {
  qq: 'QQ 邮箱：网页版 设置 → 账户 → 开启 IMAP/SMTP 服务 → 生成授权码（16 位）。这里填授权码，不是 QQ 登录密码。',
  '163': '网易 163：设置 → POP3/SMTP/IMAP → 开启 IMAP 服务 → 新增授权密码。这里填授权密码，不是登录密码。',
  '126': '网易 126：同 163，设置 → POP3/SMTP/IMAP → 开启 IMAP 服务 → 新增授权密码。',
  imap: '其他邮箱：填服务商的 IMAP 服务器与端口（一般 SSL 993），密码处填授权码。',
  gmail: 'Gmail：在 Google Cloud Console 创建 OAuth2 凭证，授权 Gmail API，用 OAuth Playground 获取 Refresh Token。',
  outlook: 'Outlook：在 Azure Portal 注册应用，授权 Mail.Read，用授权码流获取 Refresh Token。',
}

type EmailAccount = {
  email: string
  provider: 'gmail' | 'outlook' | 'imap'
  preset?: string
  host?: string
  port?: number
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
  kind: Kind
  clientId: string
  clientSecret: string
  refreshToken: string
  password: string
  host: string
  port: string
  enabled: boolean
}

const EMPTY: NewAccount = {
  email: '', kind: 'qq', clientId: '', clientSecret: '', refreshToken: '',
  password: '', host: '', port: '993', enabled: true,
}

const inputCls = 'w-full text-sm px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30'

function isOauth(k: Kind) { return k === 'gmail' || k === 'outlook' }

export default function EmailPanel() {
  const { data: s, mutate } = useSWR<EmailStatus>('email-status', () => api('/api/email/status'), { refreshInterval: 10000 })
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState<NewAccount>(EMPTY)
  const [polling, setPolling] = useState(false)
  const [pollResult, setPollResult] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

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

  function buildAccount(f: NewAccount) {
    if (isOauth(f.kind)) {
      return { email: f.email, provider: f.kind, enabled: f.enabled, clientId: f.clientId, clientSecret: f.clientSecret, refreshToken: f.refreshToken }
    }
    const preset = f.kind === 'imap' ? 'custom' : f.kind
    return {
      email: f.email, provider: 'imap', preset, enabled: f.enabled, password: f.password,
      ...(preset === 'custom' ? { host: f.host.trim(), port: Number(f.port) || 993 } : {}),
    }
  }

  const canSave = !!form.email && (isOauth(form.kind)
    ? !!form.clientId && !!form.refreshToken
    : !!form.password && (form.kind !== 'imap' || !!form.host.trim()))

  async function saveAccount() {
    if (!canSave) return
    setSaveError(null)
    try {
      const cfg = await api('/api/email/config')
      const accounts = cfg.accounts || []
      const full = buildAccount(form)
      // 同邮箱则覆盖，其他账号保留（后端会把未回传的密钥从旧配置补回）
      const idx = accounts.findIndex((a: any) => a.email === form.email)
      if (idx >= 0) accounts[idx] = full
      else accounts.push(full)
      await api('/api/email/config', { method: 'POST', body: JSON.stringify({ accounts }) })
      setForm(EMPTY); setAdding(false); mutate()
    } catch (e: any) {
      setSaveError(`保存失败：${e?.message || '未知错误'}`)
    }
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
  const accountLabel = (a: EmailAccount) => a.provider === 'imap'
    ? `${({ qq: 'QQ 邮箱', '163': '163 邮箱', '126': '126 邮箱' } as Record<string, string>)[a.preset || ''] || 'IMAP'}（授权码）`
    : a.provider

  return (
    <div className="space-y-4">
      <SectionHeader
        icon={Mail as LucideIcon}
        title="邮件接入"
        description="QQ / 163 / Gmail / Outlook 新邮件到达时微信通知"
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
              {s?.running ? <><Square size={12} />停止</> : <><Play size={12} />启动轮询</>}
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
                <p className="text-xs text-neutral-400">{accountLabel(acc)} · {acc.hasRefreshToken ? '凭证已配置' : '缺少凭证'}</p>
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
                placeholder={isOauth(form.kind) ? 'your@gmail.com' : 'your@qq.com'}
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-xs text-neutral-500 mb-1">邮箱类型</label>
              <ThemedSelect
                value={form.kind}
                onChange={e => setForm(f => ({ ...f, kind: e.target.value as Kind }))}
                className={inputCls}
              >
                {(Object.keys(KIND_LABEL) as Kind[]).map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </ThemedSelect>
            </div>
          </div>

          {isOauth(form.kind) ? (
            <>
              <div>
                <label className="block text-xs text-neutral-500 mb-1">Client ID</label>
                <input value={form.clientId} onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))} placeholder="OAuth2 Client ID" className={inputCls} />
              </div>
              <div>
                <label className="block text-xs text-neutral-500 mb-1">Client Secret</label>
                <input type="password" value={form.clientSecret} onChange={e => setForm(f => ({ ...f, clientSecret: e.target.value }))} placeholder="OAuth2 Client Secret" className={inputCls} />
              </div>
              <div>
                <label className="block text-xs text-neutral-500 mb-1">Refresh Token</label>
                <input type="password" value={form.refreshToken} onChange={e => setForm(f => ({ ...f, refreshToken: e.target.value }))} placeholder="OAuth2 Refresh Token" className={inputCls} />
              </div>
            </>
          ) : (
            <>
              {form.kind === 'imap' && (
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2">
                    <label className="block text-xs text-neutral-500 mb-1">IMAP 服务器</label>
                    <input value={form.host} onChange={e => setForm(f => ({ ...f, host: e.target.value }))} placeholder="imap.example.com" className={inputCls} />
                  </div>
                  <div>
                    <label className="block text-xs text-neutral-500 mb-1">端口</label>
                    <input value={form.port} onChange={e => setForm(f => ({ ...f, port: e.target.value }))} placeholder="993" className={inputCls} />
                  </div>
                </div>
              )}
              <div>
                <label className="block text-xs text-neutral-500 mb-1">授权码（不是邮箱登录密码）</label>
                <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} placeholder="在邮箱设置里生成的授权码" className={inputCls} />
              </div>
            </>
          )}

          <p className="text-xs text-neutral-400">{KIND_HINT[form.kind]}</p>
          {saveError && <p className="text-xs text-red-500">{saveError}</p>}

          <div className="flex gap-2 justify-end">
            <button
              onClick={() => { setAdding(false); setForm(EMPTY); setSaveError(null) }}
              className="text-sm px-4 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
            >
              取消
            </button>
            <button
              onClick={saveAccount}
              disabled={!canSave}
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
