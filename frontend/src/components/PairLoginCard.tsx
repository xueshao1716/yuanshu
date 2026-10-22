import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { PairApi, type PairDevice } from '../api'

/**
 * 手机扫码登录（2026-10-22）
 *
 * 流程：电脑生成一次性码 → 手机打开 /pair/<code> 认领 → 电脑点「允许」→ 手机拿到设备令牌。
 * 设备令牌可单独撤销，不影响主人的主令牌。
 * 微信也能用：微信「扫一扫」打开的就是这个局域网页面（不需要微信账号授权）。
 */
export default function PairLoginCard() {
  const [pair, setPair] = useState<{ code: string; url: string; expiresAt: number } | null>(null)
  const [qr, setQr] = useState('')
  const [status, setStatus] = useState<string>('idle')
  const [deviceName, setDeviceName] = useState('')
  const [devices, setDevices] = useState<PairDevice[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const timer = useRef<number | null>(null)

  const loadDevices = () => { PairApi.devices().then(r => setDevices(r.items || [])).catch(() => {}) }
  useEffect(() => { loadDevices(); return () => { if (timer.current) window.clearTimeout(timer.current) } }, [])

  const stopPoll = () => { if (timer.current) { window.clearTimeout(timer.current); timer.current = null } }

  const startPair = async () => {
    setError(''); setBusy(true)
    try {
      const p = await PairApi.create()
      setPair({ code: p.code, url: p.url, expiresAt: p.expiresAt })
      setStatus('pending')
      setQr(await QRCode.toDataURL(p.url, { margin: 1, width: 220 }))
      poll(p.code)
    } catch (e: any) {
      setError(String(e?.message || e || '生成失败'))
    } finally { setBusy(false) }
  }

  const poll = (code: string) => {
    stopPoll()
    const tick = async () => {
      try {
        const s = await PairApi.status(code)
        setStatus(s.status)
        setDeviceName(s.deviceName || '')
        if (s.status === 'approved') { loadDevices(); return }
        if (s.status === 'expired') return
        timer.current = window.setTimeout(tick, 1500)
      } catch {
        timer.current = window.setTimeout(tick, 2500)
      }
    }
    timer.current = window.setTimeout(tick, 1200)
  }

  const approve = async () => {
    if (!pair) return
    setBusy(true); setError('')
    try {
      const r = await PairApi.approve(pair.code)
      if (!r.ok) setError(r.reason === 'expired' ? '二维码已过期，请重新生成' : `批准失败：${r.reason || '未知'}`)
      else { setStatus('approved'); loadDevices() }
    } catch (e: any) { setError(String(e?.message || e)) }
    finally { setBusy(false) }
  }

  const revoke = async (id: string) => {
    try { await PairApi.revoke(id); loadDevices() } catch {}
  }

  const hint = status === 'claimed' ? `设备「${deviceName || '手机'}」请求登录，确认是你再点允许`
    : status === 'approved' ? '已允许，手机上会自动进入'
    : status === 'expired' ? '二维码已过期，重新生成一个'
    : pair ? '用手机（或微信「扫一扫」）扫描二维码' : '生成后，手机和电脑需在同一局域网'

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start gap-5">
        <div className="flex flex-col items-center gap-2">
          {qr ? <img src={qr} alt="登录二维码" className="h-[220px] w-[220px] rounded-pi-lg border border-pi-border-soft bg-white p-1" />
            : <div className="flex h-[220px] w-[220px] items-center justify-center rounded-pi-lg border border-dashed border-pi-border-soft text-[12px] text-pi-dim2">未生成</div>}
          {pair && <code className="text-[12px] tracking-[0.18em] text-pi-dim">{pair.code}</code>}
        </div>
        <div className="min-w-[240px] flex-1 space-y-2">
          <p className="text-[13px] text-pi-text">{hint}</p>
          {deviceName && status === 'claimed' && <p className="text-[12px] text-pi-dim2">来自：{deviceName}</p>}
          {error && <p className="text-[12px] text-red-500">{error}</p>}
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              onClick={startPair}
              disabled={busy}
              className="rounded-pi-md border border-pi-border-soft px-3 py-1.5 text-[12px] hover:bg-pi-surface disabled:opacity-50"
            >{pair ? '重新生成' : '生成二维码'}</button>
            {pair && status === 'claimed' && (
              <button
                onClick={approve}
                disabled={busy}
                className="rounded-pi-md bg-pi-accent px-3 py-1.5 text-[12px] text-white hover:opacity-90 disabled:opacity-50"
              >允许这台设备登录</button>
            )}
          </div>
          <p className="pt-1 text-[11px] leading-relaxed text-pi-dim2">
            说明：扫的是本机局域网地址，不需要微信账号授权；微信里打开同样能用。
            设备令牌单独保存、可随时撤销，不影响主令牌。
          </p>
        </div>
      </div>

      {devices.length > 0 && (
        <div className="rounded-pi-lg border border-pi-border-soft">
          <div className="border-b border-pi-border-soft px-3 py-2 text-[11px] uppercase tracking-[0.12em] text-pi-dim2">已登录设备</div>
          <div className="divide-y divide-pi-border-soft">
            {devices.map(d => (
              <div key={d.id} className="flex items-center justify-between gap-3 px-3 py-2 text-[12px]">
                <div className="min-w-0">
                  <div className="truncate text-pi-text">{d.name}</div>
                  <div className="text-[11px] text-pi-dim2">
                    加入 {new Date(d.createdAt).toLocaleString()}{d.lastSeenAt ? ` · 最近 ${new Date(d.lastSeenAt).toLocaleString()}` : ' · 尚未使用'}
                  </div>
                </div>
                <button onClick={() => revoke(d.id)} className="shrink-0 rounded-pi-md border border-pi-border-soft px-2 py-1 text-[11px] text-pi-dim hover:text-red-500">撤销</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
