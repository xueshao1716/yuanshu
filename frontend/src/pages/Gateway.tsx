import useSWR from 'swr'
import { useState } from 'react'
import { api } from '../api'

/**
 * 事务台（2026-10-28 改版）
 *
 * 用户反馈：「接口台这个界面有点工程化，不够工作化，不好上手」
 * 改法：
 *   · 第一屏先给结论（进来几件 / 发出几条 / 在办几件 / 几条弯路）
 *   · 五个区块全换工作语言：外面进来的事 / 我发出去的 / 正在办的事 / 同事留言 / 走过的弯路
 *   · 技术细节（接口路径、分支、scope）收进「怎么让它自动进来？」这种折叠里
 */
type InEvent = { id: string; at: number; source: string; kind: string; text: string; severity: string; matched: string[] }
type Delivery = { at: number; channel: string; kind: string; ok: boolean; detail: string; text: string; fallbacks: number }
type Watch = { id: string; title: string; status: string }
type Loop = { key: string; title: string; status: string; attempts: number }
type Claim = { id: string; task: string; agent: string; scope: string[]; state: string; createdAt: number; expiresAt: number }
type Msg = { id: string; at: number; from: string; to: string; kind: string; text: string }
type Failure = { id: string; at: number; agent: string; area: string; attempt: string; why: string; source: string; files: string[] }

const time = (ms: number) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—')

const SOURCE_LABEL: Record<string, string> = {
  email: '邮件', imap: '邮箱', gmail: 'Gmail', outlook: 'Outlook',
  dingtalk: '钉钉', manual: '手动', wechat: '微信', monitor: '监控', news: '资讯',
}
const CHANNEL_LABEL: Record<string, string> = { wechat: '微信', email: '邮件', webhook: 'Webhook', pushplus: '服务号推送' }

const pill = (primary = false): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minHeight: 32, padding: '0 13px',
  borderRadius: 999, fontSize: 12.5, cursor: 'pointer',
  border: `1px solid ${primary ? 'var(--pi-accent, #2f6bff)' : 'var(--pi-border-soft, #bfc4cb)'}`,
  background: primary ? 'var(--pi-accent-soft, rgba(47,107,255,0.12))' : 'var(--pi-bg3, #eef0f3)',
  color: primary ? 'var(--pi-accent, #2f6bff)' : 'var(--pi-text, #222)', fontWeight: primary ? 600 : 400,
})
const input: React.CSSProperties = {
  minHeight: 32, padding: '0 10px', fontSize: 12.5, borderRadius: 8,
  border: '1px solid var(--pi-border-soft, #bfc4cb)', background: 'var(--pi-panel, #fff)', color: 'var(--pi-text, #222)',
}
const chip: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'baseline', gap: 6, padding: '6px 12px', borderRadius: 10,
  border: '1px solid var(--pi-border-soft, #bfc4cb)', background: 'var(--pi-panel, #fff)', fontSize: 12.5,
}

export default function Gateway() {
  const inb = useSWR('gateway-in', () => api<{ ok: boolean; items: InEvent[] }>('/api/inbound/events?limit=20'), { refreshInterval: 15000 })
  const out = useSWR('gateway-out', () => api<{ ok: boolean; items: Delivery[] }>('/api/outbound/deliveries?limit=20'), { refreshInterval: 15000 })
  const pro = useSWR('gateway-pro', () => api<{ ok: boolean; watches: Watch[]; loops: Loop[] }>('/api/proactive'), { refreshInterval: 30000 })
  const clm = useSWR('gateway-claim', () => api<{ ok: boolean; items: Claim[] }>('/api/claim'), { refreshInterval: 15000 })
  const fail = useSWR('gateway-fail', () => api<{ ok: boolean; items: Failure[] }>('/api/failure'), { refreshInterval: 30000 })
  const ro = useSWR('guard-readonly', () => api<{ ok: boolean; on: boolean; source?: string }>('/api/guard/readonly'), { refreshInterval: 30000 })
  const mbox = useSWR('gateway-msg', () => api<{ ok: boolean; inbox: Msg[]; recent: Msg[] }>('/api/agent/msg?for=小语&unread=0&limit=12'), { refreshInterval: 15000 })

  const [text, setText] = useState('')
  const [sev, setSev] = useState('normal')
  const [msg, setMsg] = useState('')
  const [claimTaskText, setClaimTaskText] = useState('')
  const [claimScope, setClaimScope] = useState('')
  const [claimMsg, setClaimMsg] = useState('')
  const [msgText, setMsgText] = useState('')
  const [msgTo, setMsgTo] = useState('')
  const [msgHint, setMsgHint] = useState('')
  const [roHint, setRoHint] = useState('')

  const readonlyOn = ro.data?.on === true
  const events = inb.data?.items || []
  const deliveries = out.data?.items || []
  const claims = clm.data?.items || []
  const messages = mbox.data?.recent || []
  const failures = fail.data?.items || []
  const watches = (pro.data?.watches || []).filter((w) => w.status === 'watching')
  const loops = (pro.data?.loops || []).filter((l) => l.status !== 'done')
  const failedDeliveries = deliveries.filter((d) => !d.ok).length

  const toggleReadOnly = async () => {
    const next = !(ro.data?.on === true)
    try {
      const r = await api<{ ok: boolean; on?: boolean; note?: string; error?: string }>('/api/guard/readonly', { method: 'POST', body: { on: next } })
      if (!r.ok) { setRoHint(r.error || '切换失败'); return }
      setRoHint(r.note || '已切换')
      void ro.mutate()
    } catch (e: any) { setRoHint(String(e?.message || e).slice(0, 120)) }
  }

  const post = async () => {
    const t = text.trim()
    if (!t) return
    try {
      const r = await api<{ ok: boolean; matched?: { title: string }[]; reported?: boolean; error?: string }>('/api/inbound/event', {
        method: 'POST', body: { source: 'manual', text: t, severity: sev, kind: sev === 'high' ? 'alert' : 'info' },
      })
      if (!r.ok) { setMsg(r.error || '没投进去'); return }
      setMsg(`已收下${r.matched?.length ? `，命中你在盯的「${r.matched.map((m) => m.title).join('、')}」` : ''}${r.reported ? '，已进汇报' : ''}`)
      setText('')
      void inb.mutate()
    } catch (e: any) { setMsg(String(e?.message || e).slice(0, 120)) }
  }

  const doClaim = async () => {
    const t = claimTaskText.trim()
    if (!t) return
    try {
      const scope = claimScope.split(/[,，\s]+/).filter(Boolean)
      const r = await api<{ ok: boolean; error?: string }>('/api/claim', { method: 'POST', body: { task: t, agent: '小语', scope } })
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

  const sendMsg = async () => {
    const t = msgText.trim()
    if (!t) return
    try {
      const r = await api<{ ok: boolean; error?: string }>('/api/agent/msg', { method: 'POST', body: { from: '小语', to: msgTo.trim(), text: t } })
      if (!r.ok) { setMsgHint(r.error || '没发出去'); return }
      setMsgHint(msgTo.trim() ? `已发给 ${msgTo.trim()}` : '已广播')
      setMsgText('')
      void mbox.mutate()
    } catch (e: any) { setMsgHint(String(e?.message || e).slice(0, 120)) }
  }

  return (
    <div className="mx-auto w-full max-w-[1040px] px-4 py-8 space-y-6">
      <header>
        <h1 className="text-[20px] font-semibold text-pi-text">事务台</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-pi-dim2">
          外面进来的事、我发出去的话、正在办和办砸过的——都在这一页。
          <strong className="text-pi-text">平时只需要看最上面那排数字。</strong>
        </p>
      </header>

      <div className="flex flex-wrap gap-2">
        <span style={chip}><strong>{events.length}</strong> 件进来</span>
        <span style={chip}>
          <strong>{deliveries.length}</strong> 条发出
          {failedDeliveries ? <span style={{ color: 'var(--pi-danger, #dc2626)' }}>（{failedDeliveries} 条没送到）</span> : null}
        </span>
        <span style={chip}><strong>{claims.length}</strong> 件在办</span>
        <span style={chip}><strong>{watches.length}</strong> 件在盯</span>
        <span style={chip}><strong>{failures.length}</strong> 条弯路</span>
      </div>

      {/* 只读模式：最常用的一个开关，放第一屏 */}
      <section className="panel">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-[15px] font-semibold text-pi-text">只读模式</h2>
              <span
                style={{
                  fontSize: 11.5, padding: '2px 8px', borderRadius: 999,
                  border: '1px solid var(--pi-border-soft, #bfc4cb)',
                  background: readonlyOn ? 'var(--pi-warn-soft, rgba(217,119,6,0.12))' : 'var(--pi-bg3, #eef0f3)',
                  color: readonlyOn ? 'var(--pi-warn, #d97706)' : 'var(--pi-dim2)',
                  fontWeight: readonlyOn ? 600 : 400,
                }}
              >
                {readonlyOn ? '已开启 · 只能看' : '已关闭 · 可以改'}
              </span>
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-pi-dim2">
              {readonlyOn
                ? '她现在只能读文件、跑只读命令。改文件、删东西、装包都会被拦下。'
                : '她可以改文件、跑命令。担心她乱动的时候就打开这个开关。'}
            </p>
          </div>
          <button type="button" style={pill(readonlyOn)} onClick={toggleReadOnly}>
            {readonlyOn ? '恢复可写' : '开启只读'}
          </button>
        </div>
        {roHint ? <p className="mt-2 text-xs text-pi-dim2">{roHint}</p> : null}
        <details className="mt-2 text-xs text-pi-dim2">
          <summary style={{ cursor: 'pointer' }}>开启后具体会拦下什么？</summary>
          <ul className="mt-1.5 space-y-1 leading-relaxed">
            <li>· 写文件：echo 重定向、rm、mv、mkdir、chmod</li>
            <li>· 改代码：git commit / push / reset / clean、sed -i</li>
            <li>· 装东西：npm install、pip install、node -e</li>
            <li>· 受保护文件：SOUL、IDENTITY、宪法.json、.token、记忆/ 下的文件</li>
            <li>· 危险命令：rm -rf、find -delete、truncate -s 0、Remove-Item -Recurse</li>
          </ul>
          <p className="mt-1.5">放行的：ls、cat、grep、git status、git diff、wc、node 跑一个脚本文件 这类只读命令。</p>
        </details>
      </section>

      <section className="panel space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[15px] font-semibold text-pi-text">外面进来的事</h2>
          <details className="text-xs text-pi-dim2">
            <summary style={{ cursor: 'pointer' }}>怎么让它自动进来？</summary>
            <p className="mt-1.5 leading-relaxed">
              邮件已经在自动进来了。别的系统（钉钉、监控、价格变动）只要往
              <code className="mx-1 px-1 rounded bg-pi-bg3">/api/inbound/event</code>
              推一条 JSON：<code className="mx-1 px-1 rounded bg-pi-bg3">{'{ source, text, severity }'}</code>。
            </p>
          </details>
        </div>

        <div className="flex flex-wrap gap-2">
          <input
            style={{ ...input, flex: 1, minWidth: 240 }}
            value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void post() }}
            placeholder="试着投一条进来，比如「老师通知：明天交回执」"
          />
          <select style={input} value={sev} onChange={(e) => setSev(e.target.value)}>
            <option value="normal">普通</option>
            <option value="high">重要</option>
            <option value="low">不重要</option>
          </select>
          <button type="button" style={pill(true)} onClick={post}>收下</button>
        </div>
        {msg ? <p className="text-xs text-pi-dim2">{msg}</p> : null}

        {events.length ? (
          <ul className="space-y-2.5">
            {events.map((e) => (
              <li key={e.id} className="text-[12.5px] leading-relaxed">
                <span className="text-pi-dim2">
                  {time(e.at)} · {SOURCE_LABEL[e.source] || e.source}
                  {e.severity === 'high' ? <span className="ml-2 text-pi-danger">重要</span> : null}
                </span>
                <div className="text-pi-text">{e.text}</div>
                {e.matched?.length ? <div className="text-pi-dim2">和你盯的「{e.matched.join('、')}」有关</div> : null}
              </li>
            ))}
          </ul>
        ) : <p className="text-xs text-pi-dim2">还没有事情进来。上面可以手动投一条试试。</p>}
      </section>

      <section className="panel space-y-3">
        <h2 className="text-[15px] font-semibold text-pi-text">我发出去的</h2>
        {deliveries.length ? (
          <ul className="space-y-2">
            {deliveries.map((d, i) => (
              <li key={`${d.at}-${i}`} className="text-[12.5px] leading-relaxed">
                <span className={d.ok ? 'text-pi-dim2' : 'text-pi-danger'}>
                  {time(d.at)} · {CHANNEL_LABEL[d.channel] || d.channel} · {d.ok ? '送到了' : '没送到'}
                  {d.fallbacks ? `（换了 ${d.fallbacks} 个渠道才成功）` : ''}
                </span>
                <div className="text-pi-text">{d.text || d.detail}</div>
                {!d.ok ? <div className="text-pi-dim2">{d.detail}</div> : null}
              </li>
            ))}
          </ul>
        ) : <p className="text-xs text-pi-dim2">还没发过东西。小语的通报会走这里。</p>}
      </section>

      <section className="panel space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[15px] font-semibold text-pi-text">正在办的事</h2>
          <span className="text-xs text-pi-dim2">同一件事不会被两个人同时办</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <input style={{ ...input, flex: 1, minWidth: 200 }} value={claimTaskText} onChange={(e) => setClaimTaskText(e.target.value)} placeholder="要办的事，比如「修微信发图」" />
          <input style={{ ...input, flex: 1, minWidth: 200 }} value={claimScope} onChange={(e) => setClaimScope(e.target.value)} placeholder="会动到哪些文件（可选）" />
          <button type="button" style={pill()} onClick={doClaim}>接下来办</button>
        </div>
        {claimMsg ? <p className="text-xs text-pi-dim2">{claimMsg}</p> : null}

        {claims.length ? (
          <ul className="space-y-2.5">
            {claims.map((c) => (
              <li key={c.id} className="text-[12.5px] leading-relaxed">
                <span className="text-pi-dim2">{c.agent} · {time(c.createdAt)} 开始</span>
                <div className="text-pi-text">{c.task}</div>
                {c.scope?.length ? <div className="text-pi-dim2">会动：{c.scope.join('、')}</div> : null}
                <div className="flex gap-2 mt-1.5">
                  <button type="button" style={{ ...pill(), minHeight: 26, fontSize: 12 }} onClick={() => void doRelease(c.id, true)}>办完了</button>
                  <button type="button" style={{ ...pill(), minHeight: 26, fontSize: 12 }} onClick={() => void doRelease(c.id, false)}>不办了</button>
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="text-xs text-pi-dim2">现在手上没有在办的事。</p>}

        {watches.length || loops.length ? (
          <div className="pt-2 border-t border-pi-border-soft">
            <p className="text-xs text-pi-dim2">
              在盯 {watches.length} 件{watches.length ? `：${watches.map((w) => w.title).join('、')}` : ''}
              {loops.length ? `；在追 ${loops.length} 件：${loops.slice(0, 3).map((l) => l.title).join('、')}` : ''}
            </p>
          </div>
        ) : null}
      </section>

      <section className="panel space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[15px] font-semibold text-pi-text">同事留言</h2>
          <span className="text-xs text-pi-dim2">多个小语同时干活时，用这个对口径</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <input style={{ ...input, width: 140 }} value={msgTo} onChange={(e) => setMsgTo(e.target.value)} placeholder="发给谁（可空）" />
          <input
            style={{ ...input, flex: 1, minWidth: 220 }}
            value={msgText} onChange={(e) => setMsgText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void sendMsg() }}
            placeholder="留一句：我在改什么、哪条路走不通"
          />
          <button type="button" style={pill()} onClick={sendMsg}>留言</button>
        </div>
        {msgHint ? <p className="text-xs text-pi-dim2">{msgHint}</p> : null}
        {messages.length ? (
          <ul className="space-y-2">
            {messages.map((m) => (
              <li key={m.id} className="text-[12.5px] leading-relaxed">
                <span className="text-pi-dim2">{time(m.at)} · {m.from}{m.to ? ` → ${m.to}` : '（对所有人）'}</span>
                <div className="text-pi-text">{m.text}</div>
              </li>
            ))}
          </ul>
        ) : <p className="text-xs text-pi-dim2">还没有留言。</p>}
      </section>

      <section className="panel space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[15px] font-semibold text-pi-text">走过的弯路</h2>
          <span className="text-xs text-pi-dim2">记下来，下次不再踩</span>
        </div>
        {failures.length ? (
          <ul className="space-y-2.5">
            {failures.slice(0, 8).map((f) => (
              <li key={f.id} className="text-[12.5px] leading-relaxed">
                <span className="text-pi-dim2">{time(f.at)}{f.area ? ` · ${f.area}` : ''}</span>
                <div className="text-pi-text">试过：{f.attempt}</div>
                <div className="text-pi-danger">不行：{f.why}</div>
                {f.files?.length ? <div className="text-pi-dim2">涉及：{f.files.slice(0, 3).join('、')}</div> : null}
              </li>
            ))}
          </ul>
        ) : <p className="text-xs text-pi-dim2">还没有失败记录。补丁被门禁拦下时会自动记一条。</p>}
      </section>
    </div>
  )
}
