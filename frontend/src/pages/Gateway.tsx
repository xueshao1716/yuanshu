import useSWR from 'swr'
import { useState } from 'react'
import { api } from '../api'
import SectionHeader from '../components/SectionHeader'

/**
 * 接口台（2026-10-27）
 *
 * 用户原话：「是不是可以做一个专门的界面，来管理这些事了」
 * 这里管三件事：
 *   ① 外面进来的（入站事件：群消息/邮件/告警/价格）
 *   ② 里面发出去的（出站投递：微信/邮件/webhook，含失败与降级）
 *   ③ 我在盯/在追的（主动管理）
 */
type InEvent = { id: string; at: number; source: string; kind: string; text: string; severity: string; matched: string[] }
type Delivery = { at: number; channel: string; kind: string; ok: boolean; detail: string; text: string; fallbacks: number }
type Watch = { id: string; title: string; status: string }
type Loop = { key: string; title: string; status: string; attempts: number }
type Claim = { id: string; task: string; agent: string; scope: string[]; branch: string; state: string; createdAt: number; expiresAt: number }

const time = (ms: number) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—')

const pill: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', minHeight: 26, padding: '0 10px',
  borderRadius: 999, fontSize: 12, border: '1px solid var(--pi-border-soft, #bfc4cb)',
  background: 'var(--pi-bg3, #eef0f3)', color: 'var(--pi-text, #222)', cursor: 'pointer',
}
const input: React.CSSProperties = {
  minHeight: 32, padding: '0 10px', fontSize: 12.5, borderRadius: 8,
  border: '1px solid var(--pi-border-soft, #bfc4cb)', background: 'var(--pi-panel, #fff)', color: 'var(--pi-text, #222)',
}

export default function Gateway() {
  const inb = useSWR('gateway-in', () => api<{ ok: boolean; items: InEvent[] }>('/api/inbound/events?limit=20'), { refreshInterval: 15000 })
  const out = useSWR('gateway-out', () => api<{ ok: boolean; items: Delivery[] }>('/api/outbound/deliveries?limit=20'), { refreshInterval: 15000 })
  const pro = useSWR('gateway-pro', () => api<{ ok: boolean; watches: Watch[]; loops: Loop[] }>('/api/proactive'), { refreshInterval: 30000 })
  const clm = useSWR('gateway-claim', () => api<{ ok: boolean; items: Claim[] }>('/api/claim'), { refreshInterval: 15000 })

  const [src, setSrc] = useState('manual')
  const [text, setText] = useState('')
  const [sev, setSev] = useState('normal')
  const [msg, setMsg] = useState('')
  const [claimTaskText, setClaimTaskText] = useState('')
  const [claimScope, setClaimScope] = useState('')
  const [claimMsg, setClaimMsg] = useState('')

  const post = async () => {
    const t = text.trim()
    if (!t) return
    try {
      const r = await api<{ ok: boolean; matched?: { title: string }[]; reported?: boolean; error?: string }>('/api/inbound/event', {
        method: 'POST', body: { source: src || 'manual', text: t, severity: sev, kind: sev === 'high' ? 'alert' : 'info' },
      })
      if (!r.ok) { setMsg(r.error || '投递失败'); return }
      setMsg(`已收下${r.matched?.length ? `，命中：${r.matched.map((m) => m.title).join('、')}` : ''}${r.reported ? '，已进汇报' : ''}`)
      setText('')
      void inb.mutate()
    } catch (e: any) { setMsg(String(e?.message || e).slice(0, 120)) }
  }

  const doClaim = async () => {
    const t = claimTaskText.trim()
    if (!t) return
    try {
      const scope = claimScope.split(/[,，\s]+/).filter(Boolean)
      const r = await api<{ ok: boolean; error?: string; claim?: Claim }>('/api/claim', { method: 'POST', body: { task: t, agent: '小语', scope } })
      if (!r.ok) { setClaimMsg(r.error || '认领失败'); return }
      setClaimMsg('已认领')
      setClaimTaskText(''); setClaimScope('')
      void clm.mutate()
    } catch (e: any) { setClaimMsg(String(e?.message || e).slice(0, 120)) }
  }
  const doRelease = async (id: string, done: boolean) => {
    await api('/api/claim/release', { method: 'POST', body: { id, done } }).catch(() => null)
    void clm.mutate()
  }

  const events = inb.data?.items || []
  const deliveries = out.data?.items || []
  const claims = clm.data?.items || []
  const watches = (pro.data?.watches || []).filter((w) => w.status === 'watching')
  const loops = (pro.data?.loops || []).filter((l) => l.status !== 'done')

  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-6 space-y-6">
      <SectionHeader title="接口台" description="外面进来的、里面发出去的、以及我一直在盯的——在这里统一管。" />

      {/* ① 入站 */}
      <section className="panel space-y-3">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-pi-text">外面进来的 <span className="text-pi-dim2 font-normal">（最近 {events.length} 条）</span></h3>
          <span className="text-xs text-pi-dim2">任何系统都能往 <code>/api/inbound/event</code> 推</span>
        </div>

        <div className="flex flex-wrap gap-2">
          <input style={{ ...input, width: 130 }} value={src} onChange={(e) => setSrc(e.target.value)} placeholder="来源，如 dingtalk" />
          <input
            style={{ ...input, flex: 1, minWidth: 240 }}
            value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void post() }}
            placeholder="模拟一条外部事件：比如「老师通知：明天交回执」"
          />
          <select style={input} value={sev} onChange={(e) => setSev(e.target.value)}>
            <option value="normal">普通</option>
            <option value="high">重要</option>
            <option value="low">低</option>
          </select>
          <button type="button" style={pill} onClick={post}>投一条</button>
        </div>
        {msg ? <p className="text-xs text-pi-dim2">{msg}</p> : null}

        {events.length ? (
          <ul className="space-y-2">
            {events.map((e) => (
              <li key={e.id} className="text-xs leading-relaxed">
                <span className="text-pi-dim2">{time(e.at)} · {e.source} · {e.kind}</span>
                {e.severity === 'high' ? <span className="ml-2 text-pi-danger">重要</span> : null}
                <div className="text-pi-text">{e.text}</div>
                {e.matched?.length ? <div className="text-pi-dim2">命中：{e.matched.join('、')}</div> : null}
              </li>
            ))}
          </ul>
        ) : <p className="text-xs text-pi-dim2">还没有外部事件。</p>}
      </section>

      {/* ② 出站 */}
      <section className="panel space-y-3">
        <h3 className="text-sm font-semibold text-pi-text">里面发出去的 <span className="text-pi-dim2 font-normal">（最近 {deliveries.length} 次）</span></h3>
        {deliveries.length ? (
          <ul className="space-y-2">
            {deliveries.map((d, i) => (
              <li key={`${d.at}-${i}`} className="text-xs leading-relaxed">
                <span className={d.ok ? 'text-pi-dim2' : 'text-pi-danger'}>
                  {time(d.at)} · {d.channel} · {d.kind} · {d.ok ? '已送达' : '失败'}
                  {d.fallbacks ? `（降级 ${d.fallbacks} 次）` : ''}
                </span>
                <div className="text-pi-text">{d.text || d.detail}</div>
                {!d.ok ? <div className="text-pi-dim2">{d.detail}</div> : null}
              </li>
            ))}
          </ul>
        ) : <p className="text-xs text-pi-dim2">还没有出站记录。</p>}
      </section>

      {/* ②.5 认领板 */}
      <section className="panel space-y-3">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-pi-text">谁在做什么 <span className="text-pi-dim2 font-normal">（认领板 · {claims.length} 件在做）</span></h3>
          <span className="text-xs text-pi-dim2">范围重叠会被拒绝，过期自动回收</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <input style={{ ...input, flex: 1, minWidth: 200 }} value={claimTaskText} onChange={(e) => setClaimTaskText(e.target.value)} placeholder="要做的事，如「修微信发图」" />
          <input style={{ ...input, flex: 1, minWidth: 200 }} value={claimScope} onChange={(e) => setClaimScope(e.target.value)} placeholder="范围（逗号分隔），如 engine/wechat-media.mjs" />
          <button type="button" style={pill} onClick={doClaim}>认领</button>
        </div>
        {claimMsg ? <p className="text-xs text-pi-dim2">{claimMsg}</p> : null}
        {claims.length ? (
          <ul className="space-y-2">
            {claims.map((c) => (
              <li key={c.id} className="text-xs leading-relaxed">
                <span className="text-pi-dim2">{c.agent} · {time(c.createdAt)} 认领</span>
                <div className="text-pi-text">{c.task}</div>
                {c.scope?.length ? <div className="text-pi-dim2">范围：{c.scope.join('、')}</div> : null}
                <div className="flex gap-2 mt-1">
                  <button type="button" style={{ ...pill, minHeight: 22, fontSize: 11 }} onClick={() => void doRelease(c.id, true)}>完成</button>
                  <button type="button" style={{ ...pill, minHeight: 22, fontSize: 11 }} onClick={() => void doRelease(c.id, false)}>放弃</button>
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="text-xs text-pi-dim2">黑板是空的。</p>}
      </section>

      {/* ③ 在盯/在追 */}
      <section className="panel space-y-3">
        <h3 className="text-sm font-semibold text-pi-text">我一直在管的 <span className="text-pi-dim2 font-normal">（{watches.length} 件在盯，{loops.length} 件在追）</span></h3>
        {watches.length ? (
          <div className="flex flex-wrap gap-2">
            {watches.map((w) => <span key={w.id} style={{ ...pill, cursor: 'default' }}>{w.title}</span>)}
          </div>
        ) : <p className="text-xs text-pi-dim2">还没在盯任何东西。去「灵魂培育 → 主动管理」说一句「盯住 X」。</p>}
        {loops.length ? (
          <ul className="space-y-1">
            {loops.slice(0, 6).map((l) => (
              <li key={l.key} className="text-xs text-pi-dim2">
                {l.title}（{l.status === 'escalated' ? '需要你拍板' : '已提醒'} · 第 {l.attempts} 次）
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  )
}
