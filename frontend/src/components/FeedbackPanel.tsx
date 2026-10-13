import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { Bug, Lightbulb, Send, CheckCircle2, Inbox, Trash2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { api, getApiBase } from '../api'
import SectionHeader from './SectionHeader'

type FeedbackItem = {
  id: string
  at: number
  type: 'bug' | 'idea'
  title: string
  detail: string
  contact: string
  status: 'open' | 'done' | 'wontfix'
  env: { version?: string; os?: string } | null
  diagnostics: { crashTail?: string } | null
  handledAt?: number
}

const STATUS_LABEL: Record<string, string> = { open: '待处理', done: '已处理', wontfix: '不修' }

function isLocalWorkbench(): boolean {
  const base = getApiBase()
  if (!base) return true
  try { return ['127.0.0.1', 'localhost', '::1'].includes(new URL(base).hostname) } catch { return false }
}

export default function FeedbackPanel() {
  const local = isLocalWorkbench()
  const { data, mutate } = useSWR<{ items: FeedbackItem[] }>(local ? 'feedback-inbox' : null, () => api('/api/feedback'), { refreshInterval: 30000 })
  const [type, setType] = useState<'bug' | 'idea'>('bug')
  const [title, setTitle] = useState('')
  const [detail, setDetail] = useState('')
  const [contact, setContact] = useState('')
  const [withDiag, setWithDiag] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [showInbox, setShowInbox] = useState(false)

  async function submit() {
    if (!title.trim()) { setMsg('标题不能为空'); return }
    setBusy(true); setMsg('')
    try {
      await api('/api/feedback', { method: 'POST', body: JSON.stringify({ type, title, detail, contact, withDiagnostics: withDiag }) })
      setMsg(type === 'bug' ? '已提交，谢谢反馈！诊断信息不含令牌与密钥。' : '已提交，谢谢建议！')
      setTitle(''); setDetail(''); setContact('')
    } catch (e: any) { setMsg(`提交失败：${e?.message || '未知错误'}`) }
    finally { setBusy(false); mutate() }
  }

  async function mark(id: string, status: 'done' | 'wontfix') {
    await api(`/api/feedback/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status }) })
    mutate()
  }

  const items = data?.items || []

  return (
    <div className="space-y-4">
      <SectionHeader
        icon={Bug as LucideIcon}
        title="反馈与建议"
        description="遇到问题或想改进元枢，直接提交到工作台服务器，开发者在这里集中收。"
      />

      <div className="flex gap-2">
        <button onClick={() => setType('bug')}
          className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors ${type === 'bug' ? 'border-blue-500 text-blue-500 bg-blue-500/5' : 'border-neutral-200 dark:border-neutral-700 text-neutral-500 hover:bg-neutral-50 dark:hover:bg-neutral-800'}`}>
          <Bug size={13} /> 问题报告
        </button>
        <button onClick={() => setType('idea')}
          className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors ${type === 'idea' ? 'border-blue-500 text-blue-500 bg-blue-500/5' : 'border-neutral-200 dark:border-neutral-700 text-neutral-500 hover:bg-neutral-50 dark:hover:bg-neutral-800'}`}>
          <Lightbulb size={13} /> 改进意见
        </button>
      </div>

      <div className="space-y-3">
        <input value={title} onChange={e => setTitle(e.target.value)} maxLength={120}
          placeholder={type === 'bug' ? '一句话说清问题（必填）' : '一句话说清建议（必填）'}
          className="w-full text-sm px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30" />
        <textarea value={detail} onChange={e => setDetail(e.target.value)} rows={4} maxLength={8000}
          placeholder={type === 'bug' ? '怎么触发的？预期是什么、实际看到了什么？（越具体越好修）' : '希望怎么做、解决什么问题？'}
          className="w-full text-sm px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30" />
        <div className="flex items-center justify-between gap-3">
          <input value={contact} onChange={e => setContact(e.target.value)} maxLength={200}
            placeholder="联系方式（可选）"
            className="flex-1 text-xs px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30" />
          <label className="flex items-center gap-1.5 text-xs text-neutral-500 cursor-pointer select-none whitespace-nowrap">
            <input type="checkbox" checked={withDiag} onChange={e => setWithDiag(e.target.checked)} className="accent-blue-600" />
            附带诊断信息（版本/系统/错误日志尾，不含令牌密钥）
          </label>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={submit} disabled={busy || !title.trim()}
            className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 transition-colors">
            <Send size={13} /> {busy ? '提交中…' : '提交反馈'}
          </button>
          {msg && <span className="text-xs text-neutral-500">{msg}</span>}
        </div>
      </div>

      {local && (
        <div className="pt-2 border-t border-neutral-100 dark:border-neutral-800">
          <button onClick={() => setShowInbox(v => !v)}
            className="flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors">
            <Inbox size={13} /> {showInbox ? '收起' : '收件箱'}（本机是工作台服务器时可见）{items.length > 0 && <span className="px-1.5 rounded-full bg-blue-500/10 text-blue-500">{items.length}</span>}
          </button>
          {showInbox && (
            <div className="mt-3 space-y-2">
              {items.length === 0 && <p className="text-xs text-neutral-400 py-1">还没有收到反馈。</p>}
              {items.map(it => (
                <div key={it.id} className="px-3 py-2.5 rounded-xl bg-neutral-50 dark:bg-neutral-800/60 border border-neutral-100 dark:border-neutral-700/50">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200 break-words">
                        {it.type === 'bug' ? '🐞' : '💡'} {it.title}
                        <span className={`ml-2 text-[10px] px-1.5 py-0.5 rounded-full ${it.status === 'open' ? 'bg-amber-500/10 text-amber-600' : it.status === 'done' ? 'bg-emerald-500/10 text-emerald-600' : 'bg-neutral-400/10 text-neutral-500'}`}>{STATUS_LABEL[it.status]}</span>
                      </p>
                      {it.detail && <p className="text-xs text-neutral-500 mt-1 whitespace-pre-wrap break-words line-clamp-4">{it.detail}</p>}
                      <p className="text-[11px] text-neutral-400 mt-1">
                        {new Date(it.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        {it.env?.version && ` · v${it.env.version}`}{it.env?.os && ` · ${it.env.os}`}
                        {it.contact && ` · ${it.contact}`}
                        {it.diagnostics?.crashTail && ' · 含诊断'}
                      </p>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      {it.status === 'open' && (
                        <>
                          <button onClick={() => mark(it.id, 'done')} title="标记已处理" className="p-1.5 text-neutral-400 hover:text-emerald-500 transition-colors"><CheckCircle2 size={14} /></button>
                          <button onClick={() => mark(it.id, 'wontfix')} title="不修" className="p-1.5 text-neutral-400 hover:text-neutral-600 transition-colors"><Trash2 size={14} /></button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
