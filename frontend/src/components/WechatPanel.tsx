import { useEffect, useRef, useState } from 'react'
import useSWR from 'swr'
import QRCode from 'qrcode'
import { MessageCircle, LogOut, Power, PowerOff } from 'lucide-react'
import { api } from '../api'
import SectionHeader from './SectionHeader'

type WechatStatus = {
  loggedIn: boolean; bot: string; owner: string; since: string
  enabled: boolean; notify: boolean; running: boolean; friends: number
  login: { state: 'idle' | 'starting' | 'waiting' | 'scanned' | 'confirmed' | 'failed'; qrUrl: string; message: string }
  stats: { received: number; replied: number; failed: number; lastAt: number; lastError: string; startedAt: number }
  recent: { at: number; dir: 'in' | 'out'; who: string; text: string }[]
}

const time = (ms: number) => ms ? new Date(ms).toLocaleTimeString('zh-CN', { hour12: false }) : '—'

export default function WechatPanel() {
  const { data: s, error: loadError, mutate } = useSWR<WechatStatus>('wechat-status', () => api('/api/wechat/status'), {
    refreshInterval: d => d && ['starting', 'waiting', 'scanned'].includes(d.login.state) ? 1500 : d?.running ? 5000 : 0,
    shouldRetryOnError: false,
  })
  const [qr, setQr] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const qrUrl = s?.login.qrUrl || ''
  useEffect(() => {
    if (!qrUrl) { setQr(''); return }
    QRCode.toDataURL(qrUrl, { margin: 1, width: 220 }).then(u => mounted.current && setQr(u)).catch(() => setQr(''))
  }, [qrUrl])

  const act = async (path: string, body: unknown = {}, confirmText = '') => {
    if (busy || (confirmText && !window.confirm(confirmText))) return
    setBusy(true); setError('')
    try { const r = await api<{ status: WechatStatus }>(path, { method: 'POST', body }); void mutate(r.status, false) }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : '请求失败，请重试') }
    finally { if (mounted.current) setBusy(false) }
  }

  const logging = !!s && ['starting', 'waiting', 'scanned'].includes(s.login.state)
  const headline = loadError ? '读取失败' : !s ? '读取中…' : !s.loggedIn ? '未登录' : s.running ? '收发中' : '已登录 · 未开启'

  return (
    <section data-slot="wechat" className="mb-8">
      <SectionHeader title="微信接入" description="扫码后，小语就能在微信里收发私聊。每位好友对应一个独立会话，群消息和图片暂不处理。" />
      <div className="panel space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2 text-sm font-medium text-pi-text">
            <MessageCircle size={18} aria-hidden="true" />{headline}
            {s?.loggedIn && <span className="text-xs font-normal text-pi-dim2 font-mono">{s.bot}</span>}
          </span>
          {s?.loggedIn && <div className="flex flex-wrap gap-2">
            {s.running
              ? <button type="button" className="btn-ghost min-h-11 px-3 inline-flex items-center gap-2" disabled={busy} onClick={() => act('/api/wechat/stop')}><PowerOff size={14} aria-hidden="true" />暂停收发</button>
              : <button type="button" className="btn-primary min-h-11 px-3 inline-flex items-center gap-2" disabled={busy} onClick={() => act('/api/wechat/start')}><Power size={14} aria-hidden="true" />开始收发</button>}
            <button type="button" className="btn-ghost min-h-11 px-3 inline-flex items-center gap-2 hover:!text-pi-danger" disabled={busy} onClick={() => act('/api/wechat/logout', {}, '退出后要重新扫码才能用。确定退出微信登录吗？')}><LogOut size={14} aria-hidden="true" />退出登录</button>
          </div>}
        </div>

        {s && !s.loggedIn && !logging && <div className="space-y-3">
          <p className="text-sm leading-relaxed text-pi-dim">用你的微信扫码，会生成一个属于你的微信机器人。好友给它发私信，小语用你在元枢里的模型和记忆来回复，聊天记录存在本机。</p>
          <button type="button" className="btn-primary min-h-11 px-4" disabled={busy} onClick={() => act('/api/wechat/login')}>扫码登录微信</button>
          {s.login.state === 'failed' && <p role="alert" className="text-sm text-pi-danger">{s.login.message}</p>}
        </div>}

        {logging && <div className="flex flex-wrap items-center gap-5">
          <div className="w-[220px] h-[220px] rounded-pi-md bg-white grid place-items-center flex-shrink-0">
            {qr ? <img src={qr} width={220} height={220} alt="微信登录二维码" /> : <span className="text-xs text-neutral-500">正在取二维码…</span>}
          </div>
          <div className="space-y-3 min-w-0">
            <p className="text-sm font-medium text-pi-text">{s?.login.message}</p>
            <p className="text-sm text-pi-dim">打开微信「扫一扫」，扫完在手机上点确认。二维码几分钟会过期，过期自动刷新。</p>
            <button type="button" className="btn-ghost min-h-11 px-3" disabled={busy} onClick={() => act('/api/wechat/login/cancel')}>取消</button>
          </div>
        </div>}

        {s?.loggedIn && <>
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[['收到', s.stats.received], ['回复', s.stats.replied], ['失败', s.stats.failed], ['好友会话', s.friends]].map(([k, v]) =>
              <div key={k} className="rounded-pi-md border border-pi-border-soft px-3 py-2">
                <dt className="text-[11px] text-pi-dim2">{k}</dt>
                <dd className="text-lg font-semibold text-pi-text font-mono tabular-nums">{v}</dd>
              </div>)}
          </dl>
          <label className="flex items-start gap-3 text-sm text-pi-text cursor-pointer">
            <input type="checkbox" className="mt-1" checked={s.notify} disabled={busy} onChange={e => act('/api/wechat/settings', { notify: e.target.checked })} />
            <span>交付通知也发到我的微信<span className="block text-xs text-pi-dim2">任务做完时，小语主动给扫码的那个微信发一条。</span></span>
          </label>
          {s.stats.lastError && <p className="text-sm text-pi-warning break-words">最近一次问题：{s.stats.lastError}</p>}
          {!!s.recent.length && <ol className="space-y-1 border-t border-pi-border-soft pt-3">
            {s.recent.slice(0, 6).map((r, i) => <li key={i} className="flex gap-2 text-xs min-w-0">
              <span className="text-pi-dim2 font-mono flex-shrink-0">{time(r.at)}</span>
              <span className={`flex-shrink-0 ${r.dir === 'in' ? 'text-pi-accent' : 'text-pi-dim2'}`}>{r.dir === 'in' ? '收' : '回'}</span>
              <span className="text-pi-text truncate">{r.text}</span>
            </li>)}
          </ol>}
        </>}

        {(error || loadError) && <p role="alert" className="text-sm text-pi-danger break-words">{error || loadError?.message}</p>}
      </div>
    </section>
  )
}
