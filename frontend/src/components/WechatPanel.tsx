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
  // 2026-10-27：掉线不再只有 running:true 一种说法
  health?: { state: 'ok' | 'idle' | 'stale' | 'degraded' | 'expired' | 'off'; text: string }
  push?: { configured: boolean; masked?: string; ok: boolean | null; at: number; detail: string; okCount?: number; failCount?: number }
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
  // 2026-10-27：推送 token 直接在面板里存，不用手写文件
  const [ppToken, setPpToken] = useState('')
  const [ppMsg, setPpMsg] = useState('')
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

  const callNotify = async (path: string, method: string, body?: unknown) => {
    setBusy(true); setPpMsg('')
    try {
      const r = await api<{ ok: boolean; error?: string; detail?: string; masked?: string }>(path, { method, body })
      return r
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '请求失败' }
    } finally { if (mounted.current) setBusy(false) }
  }
  const savePushToken = async () => {
    const r = await callNotify('/api/notify/token', 'POST', { token: ppToken.trim() })
    if (r.ok) { setPpToken(''); setPpMsg('✓ 已保存，点「发测试」验证一下'); void mutate() }
    else setPpMsg(r.error || '保存失败')
  }
  const testPush = async () => {
    const r = await callNotify('/api/notify/test', 'POST')
    setPpMsg(r.ok ? '✓ 已发送，去微信看看' : (r.error || '发送失败'))
    void mutate()
  }
  const clearPushToken = async () => {
    if (!window.confirm('清除后推送就停了，确定？')) return
    await callNotify('/api/notify/token', 'DELETE')
    setPpMsg('已清除'); void mutate()
  }
  const openPushConsole = async () => { await callNotify('/api/notify/open', 'POST') }
  // 2026-10-27：iLink 发一句试试——失败时把真实原因和建议显示出来
  const [wechatMsg, setWechatMsg] = useState('')
  const testWechat = async () => {
    setBusy(true); setWechatMsg('')
    try {
      const r = await api<{ ok: boolean; error?: string; hint?: string }>('/api/wechat/test', { method: 'POST' })
      setWechatMsg('✓ 已发送，去微信看看')
      void mutate()
      return r
    } catch (e: any) {
      const body = e?.body || {}
      setWechatMsg([body.error || e?.message || '发送失败', body.hint].filter(Boolean).join(' · '))
    } finally { if (mounted.current) setBusy(false) }
  }

  const logging = !!s && ['starting', 'waiting', 'scanned'].includes(s.login.state)
  const health = s?.health
  const headline = loadError ? '读取失败'
    : !s ? '读取中…'
    : !s.loggedIn ? '未登录'
    : health?.state === 'expired' ? '登录过期 · 需重扫'
    : health?.state === 'degraded' ? '连接异常'
    : health?.state === 'stale' ? '可能掉线'
    : s.running ? '收发中' : '已登录 · 未开启'

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
            <button type="button" className="btn-ghost min-h-11 px-3 inline-flex items-center gap-2" disabled={busy} onClick={() => void testWechat()}>发一句试试</button>
            <button type="button" className="btn-ghost min-h-11 px-3 inline-flex items-center gap-2 hover:!text-pi-danger" disabled={busy} onClick={() => act('/api/wechat/logout', {}, '退出后要重新扫码才能用。确定退出微信登录吗？')}><LogOut size={14} aria-hidden="true" />退出登录</button>
          </div>}
        </div>

        {/* 2026-10-27：健康度 + 推送通道，坏了要看得见 */}
        {s?.loggedIn && (
          <div className="space-y-1 text-xs leading-relaxed">
            <p className={health && health.state !== 'ok' && health.state !== 'idle' ? 'text-pi-danger' : 'text-pi-dim2'}>
              连接：{health ? health.text : '—'}
              {s.stats?.lastAt ? ` · 上次收到消息 ${time(s.stats.lastAt)}` : ' · 还没收到过消息'}
            </p>
            {wechatMsg ? (
              <p className={wechatMsg.startsWith('✓') ? 'text-xs text-pi-dim2' : 'text-xs text-pi-danger'}>{wechatMsg}</p>
            ) : null}
            <div className="space-y-2 pt-1">
              <p className={s.push?.configured && s.push?.ok === false ? 'text-pi-danger' : 'text-pi-dim2'}>
                推送：
                {!s.push?.configured
                  ? '未配置'
                  : s.push.ok === null
                    ? `已保存 ${s.push.masked || ''}，还没测过`
                    : s.push.ok
                      ? `正常 ${s.push.masked ? s.push.masked + ' ' : ''}· 上次 ${time(s.push.at)}`
                      : `失败：${s.push.detail || '未知原因'}`}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="password"
                  value={ppToken}
                  onChange={(e) => setPpToken(e.target.value)}
                  placeholder="粘贴 pushplus token（只存在本机）"
                  className="min-h-9 flex-1 min-w-[220px] rounded-pi-md border border-pi-border-soft bg-pi-panel px-2.5 text-xs text-pi-text"
                />
                <button type="button" className="btn-primary min-h-9 px-3 text-xs" disabled={busy || !ppToken.trim()} onClick={() => void savePushToken()}>保存</button>
                <button type="button" className="btn-ghost min-h-9 px-3 text-xs" disabled={busy || !s.push?.configured} onClick={() => void testPush()}>发测试</button>
                <button type="button" className="btn-ghost min-h-9 px-3 text-xs" onClick={() => void openPushConsole()}>打开 pushplus</button>
                {s.push?.configured && <button type="button" className="btn-ghost min-h-9 px-3 text-xs hover:!text-pi-danger" disabled={busy} onClick={() => void clearPushToken()}>清除</button>}
              </div>
              {ppMsg ? <p className={ppMsg.startsWith('✓') ? 'text-xs text-pi-dim2' : 'text-xs text-pi-danger'}>{ppMsg}</p> : null}
            </div>
          </div>
        )}

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
