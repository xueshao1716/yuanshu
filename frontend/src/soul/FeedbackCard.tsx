import useSWR, { mutate as globalMutate } from 'swr'
import { useState } from 'react'
import { SystemApi } from '../api'

/**
 * 反馈收件箱（2026-10-26）。
 *
 * 之前它藏在右下角一个小面板里，43 条全是自动上报的崩溃回执，用户根本不知道那是啥。
 * 现在：按签名分组 + **每条带自动研判**（能不能对上号、为什么对不上、一段可复制的回信）。
 *
 * 研判的意义（用户原话）：「对方报过来的，对应不上，就告诉她为啥没有发现他说的 bug」——
 * 不假装在查，直接说清缺什么、要对方补什么。
 */
type Reply = { id: string; at: number; kind: 'triage' | 'resolved'; text: string; by: string; relayed: boolean }
type Item = { id: string; at: number; title: string; detail?: string; status: string; kind?: string; signature?: string; env?: any; replies?: Reply[] }
type Group = { signature: string; kind: string; count: number; lastAt: number; status: string; title: string }
type Triage = { id: string; matchable: boolean; kind: string; reasons: string[]; reply: string; triage: string }

export default function FeedbackCard() {
  const { data, mutate, isLoading } = useSWR('soul-feedback', () => SystemApi.feedback(), { refreshInterval: 60000 })
  const { data: sum, mutate: mutateSum } = useSWR('soul-feedback-summary', () => SystemApi.feedbackSummary(), { refreshInterval: 60000 })
  const { data: tri, mutate: mutateTri } = useSWR('soul-feedback-triage', () => SystemApi.feedbackTriage(), { refreshInterval: 60000 })
  const [busy, setBusy] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [shown, setShown] = useState<string | null>(null)   // 正在展开回信的条目 id
  const [msg, setMsg] = useState('')

  const items: Item[] = (data as any)?.items || []
  const groups: Group[] = (sum as any)?.groups || []
  const triages: Triage[] = (tri as any)?.items || []
  const triOf = (id: string) => triages.find((t) => t.id === id)
  const openCount = items.filter((i) => i.status === 'open').length
  const unmatched = triages.filter((t) => !t.matchable).length

  const mark = async (id: string, status: 'done' | 'wontfix') => {
    setBusy(id)
    try { await SystemApi.feedbackMark(id, status); await Promise.all([mutate(), mutateSum(), mutateTri()]) }
    catch { /* 失败就保持原样 */ }
    finally { setBusy('') }
  }

  // 2026-10-26：修好后的第二封回信——必须填"改了什么"，空喊"修好了"发不出去
  const resolve = async (id: string) => {
    const change = window.prompt('改了什么？（必填，会原样写进回信）', '')
    if (!change || !change.trim()) return
    const verify = window.prompt('请对方怎么验证？（可留空）', '') || ''
    setBusy(id); setMsg('')
    try {
      const out: any = await SystemApi.feedbackReply(id, { kind: 'resolved', change: change.trim(), verify: verify.trim() })
      setMsg(out?.relay?.ok ? '已回信并送达对端' : '已回信（对端没有回信地址，只有本地记录）')
      await Promise.all([mutate(), mutateSum(), mutateTri()])
    } catch (e: any) { setMsg(String(e?.message || e).slice(0, 120)) } finally { setBusy('') }
  }

  const copy = async (id: string) => {
    const t = triOf(id)
    if (!t?.reply) return
    try { await navigator.clipboard.writeText(t.reply); setMsg('回信已复制，可以直接发给对方'); setTimeout(() => setMsg(''), 2500) }
    catch { setShown(shown === id ? null : id) }
  }

  if (isLoading) return <p className="tone-sources-dim">读取中…</p>
  if (!items.length) return <p className="tone-sources-dim">收件箱是空的。</p>

  return (
    <div className="tone-sources">
      <p className="tone-sources-line">
        共 <strong>{items.length}</strong> 条，<strong>{openCount}</strong> 条待处理；
        其中 <strong>{unmatched}</strong> 条<strong>对不上号</strong>（缺构建号/栈被截断/版本过老）——
        每条都能生成一段回信，说清为什么没查到、要对方补什么。
      </p>

      {groups.map((g) => {
        const list = items.filter((i) => i.signature === g.signature)
        const first = list[0]
        const t = first ? triOf(first.id) : undefined
        return (
          <article key={g.signature} className="soul-record">
            <h4>{String(g.title || '').replace('[自动上报] ', '')}</h4>
            <p className="tone-sources-dim">
              ×{g.count} · 最近 {new Date(g.lastAt).toLocaleString('zh-CN', { hour12: false })} · {g.status}
              {t && (
                <span style={{ marginLeft: 8, color: t.matchable ? 'var(--pi-accent)' : '#e5534b' }}>
                  {t.matchable ? '可定位' : `对不上：${t.kind}`}
                </span>
              )}
            </p>
            {first?.replies?.length ? (
              <ul style={{ margin: '6px 0 0', paddingLeft: 16 }}>
                {first.replies.map((r) => (
                  <li key={r.id} className="tone-sources-dim" style={{ marginBottom: 4 }}>
                    <strong>{r.kind === 'resolved' ? '修好回信' : '研判回信'}</strong>
                    {' · '}{new Date(r.at).toLocaleString('zh-CN', { hour12: false })}
                    {' · '}{r.relayed ? '已送达' : '仅本地'}
                    <div style={{ whiteSpace: 'pre-wrap' }}>{r.text.slice(0, 160)}{r.text.length > 160 ? '…' : ''}</div>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="persona-style-row">
              <button className="persona-style-opt" onClick={() => setOpen(open === g.signature ? null : g.signature)}>
                {open === g.signature ? '收起' : '看条目'}
              </button>
              {t && !t.matchable && (
                <button className="persona-style-opt" onClick={() => { setShown(shown === first.id ? null : first.id); void (navigator.clipboard?.writeText(t.reply).then(() => setMsg('回信已复制')).catch(() => {})) }}>
                  {shown === first.id ? '收起回信' : '生成回信'}
                </button>
              )}
              {first && (
                <button className="persona-style-opt" disabled={busy === first.id} onClick={() => resolve(first.id)}>
                  修好后回信
                </button>
              )}
            </div>

            {shown === first?.id && t && (
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.6, margin: '6px 0 0', color: 'var(--pi-dim2)' }}>{t.reply}</pre>
            )}

            {open === g.signature && (
              <ul style={{ margin: '6px 0 0', paddingLeft: 16 }}>
                {list.slice(0, 8).map((i) => (
                  <li key={i.id} className="tone-sources-dim" style={{ marginBottom: 6 }}>
                    {new Date(i.at).toLocaleString('zh-CN', { hour12: false })} · {i.status}
                    {i.status === 'open' && (
                      <span style={{ marginLeft: 8 }}>
                        <button className="persona-style-opt" disabled={busy === i.id} onClick={() => mark(i.id, 'done')}>完成</button>
                        <button className="persona-style-opt" disabled={busy === i.id} onClick={() => mark(i.id, 'wontfix')} style={{ marginLeft: 4 }}>忽略</button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </article>
        )
      })}

      {msg ? <p className="tone-sources-dim">{msg}</p> : null}
    </div>
  )
}
