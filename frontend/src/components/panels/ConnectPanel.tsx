import useSWR from 'swr'
import { api } from '../../api'

type Entry = { iface: string; address: string; url: string; global?: boolean }
type Reach = {
  port: number; boundHost: string; dualStack: boolean
  ipv4: Entry[]; ipv6: Entry[]; tailscale: Entry[]
  recommended: string; hint: string
}

/**
 * 手机怎么连（2026-11-06）。
 * 推荐 Tailscale：外网也能连、地址固定、不用动路由器；其次局域网 IPv4；最后公网 IPv6。
 */
export default function ConnectPanel() {
  const { data, error } = useSWR<Reach>('net-reachability', () => api('/api/net/reachability'), { refreshInterval: 60000 })
  if (error) return <div className="panel !p-5 text-[13px] text-pi-danger">读不到网络信息</div>
  if (!data) return <div className="panel !p-5 text-[13px] text-pi-dim2">正在读网络…</div>

  const copy = (text: string) => { try { navigator.clipboard.writeText(text) } catch {} }
  const rows: Array<{ kind: string; title: string; items: Entry[]; note: string; tone: string }> = [
    { kind: 'ts', title: 'Tailscale（推荐）', items: data.tailscale, note: '手机装 Tailscale 登录同一账号，任何网络都能连，地址不变', tone: 'text-pi-green' },
    { kind: 'lan', title: '局域网', items: data.ipv4, note: '只在同一 WiFi 下可用', tone: 'text-pi-dim' },
    { kind: 'v6', title: '公网 IPv6', items: data.ipv6.filter(x => x.global), note: '需要运营商给公网 IPv6 + 路由器放行端口', tone: 'text-pi-dim' },
  ]

  return (
    <div className="panel !p-5 space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className={data.dualStack ? 'text-pi-green' : 'text-pi-danger'}>
          {data.dualStack ? '双栈监听（IPv4 + IPv6）' : `仅监听 ${data.boundHost}`}
        </span>
        <span className="text-pi-dim2">端口 {data.port}</span>
        <span className="text-pi-dim2">· {data.hint}</span>
      </div>

      {data.recommended && (
        <div className="rounded-pi-md border border-pi-border-soft bg-pi-bg2/50 px-3 py-2">
          <div className="text-[11px] text-pi-dim2 mb-1">手机客户端/浏览器填这个</div>
          <div className="flex items-center gap-2">
            <code className="text-[12.5px] font-mono text-pi-text break-all">{data.recommended}</code>
            <button className="text-[11px] text-pi-accent hover:underline shrink-0" onClick={() => copy(data.recommended)}>复制</button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {rows.map(r => (
          <div key={r.kind} className="text-[12px]">
            <div className={`text-[11px] mb-0.5 ${r.tone}`}>{r.title}</div>
            {r.items.length === 0
              ? <div className="text-pi-dim2 text-[11px]">未检测到</div>
              : r.items.map(h => (
                  <div key={h.address} className="flex items-center gap-2">
                    <code className="font-mono text-[12px] break-all">{h.url}</code>
                    <button className="text-[11px] text-pi-accent hover:underline shrink-0" onClick={() => copy(h.url)}>复制</button>
                  </div>
                ))}
            <div className="text-[10.5px] text-pi-dim2 mt-0.5">{r.note}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
