import { useState } from 'react'
import { MonitorCog, RefreshCw, CheckCircle2, AlertTriangle, Plus, Trash2, Save, Copy,
  MessagesSquare, Sparkles, Clock, Factory, Image, Brain, FlaskConical, Sprout, TerminalSquare, Globe,
  Server, GitBranch, Timer, Wifi, ChevronDown } from 'lucide-react'
import useSWR from 'swr'
import { SystemApi } from '../api'
import PageHeader from '../components/PageHeader'
import SectionHeader from '../components/SectionHeader'
import StatusTile from '../components/StatusTile'

const CAP_ICONS: Record<string, any> = {
  chat: MessagesSquare, sparkles: Sparkles, clock: Clock, factory: Factory,
  image: Image, brain: Brain, flask: FlaskConical, sprout: Sprout, terminal: TerminalSquare, globe: Globe,
}
const CAP_FALLBACK = MonitorCog

type DomainRow = { domain: string; desc: string }

function KV({ k, v }: { k: string; v?: string }) {
  return (
    <div className="flex items-baseline gap-2 py-1 border-b border-pi-border-soft last:border-none">
      <span className="text-[11px] text-pi-dim2 w-20 flex-shrink-0">{k}</span>
      <span className="text-xs text-pi-text break-all font-mono">{v || '—'}</span>
    </div>
  )
}
function fmtUptime(s: number) {
  if (s >= 86400) return `${Math.floor(s / 86400)} 天 ${Math.floor((s % 86400) / 3600)} 小时`
  if (s >= 3600) return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`
  return `${Math.floor(s / 60)} 分钟`
}

export default function System() {
  const { data, mutate } = useSWR('system-info', () => SystemApi.info(), { dedupingInterval: 30000 })
  const info: any = data || {}

  const [update, setUpdate] = useState<any>(null)
  const [checking, setChecking] = useState(false)
  const checkUpdate = async () => {
    setChecking(true); setUpdate(null)
    try { setUpdate(await SystemApi.checkUpdate()) } catch (e: any) { setUpdate({ ok: false, error: e?.message || String(e) }) } finally { setChecking(false) }
  }

  const [rows, setRows] = useState<DomainRow[] | null>(null)
  const [copiedIp, setCopiedIp] = useState('')
  const [netMsg, setNetMsg] = useState('')
  const domains: DomainRow[] = rows ?? info.network?.domains ?? []
  const dirty = rows !== null
  const port = info.port || 8787
  const serviceReady = !!data
  const lanEntryCount = (info.network?.lanIPs || []).length
  const domainEntryCount = domains.filter(row => row.domain.trim()).length
  const networkEntryCount = lanEntryCount + domainEntryCount
  // 主入口：优先带描述的那条域名（通常就是"工作台主入口"），否则第一条域名，最后才是局域网 IP
  const primaryEntry: string = (() => {
    const named = domains.find(row => row.domain.trim() && /主入口|主站|工作台/.test(row.desc || ''))
    const first = named || domains.find(row => row.domain.trim())
    if (first) return first.domain.trim()
    const ip = (info.network?.lanIPs || [])[0]
    return ip ? `http://${ip}:${port}` : ''
  })()

  const editRow = (i: number, key: keyof DomainRow, v: string) =>
    setRows(domains.map((r, idx) => (idx === i ? { ...r, [key]: v } : r)))
  const addRow = () => setRows([...domains, { domain: '', desc: '' }])
  const delRow = (i: number) => setRows(domains.filter((_, idx) => idx !== i))
  const saveNet = async () => {
    setNetMsg('')
    try {
      const r = await SystemApi.saveNetwork({ domains })
      if ((r as any).error) { setNetMsg((r as any).error); return }
      setRows(null); setNetMsg('已保存'); mutate(); setTimeout(() => setNetMsg(''), 2500)
    } catch (e: any) { setNetMsg('保存失败：' + (e?.message || e)) }
  }

  const copyText = (t: string) => {
    navigator.clipboard?.writeText(t).then(() => { setCopiedIp(t); setTimeout(() => setCopiedIp(''), 1500) }).catch(() => {})
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto page-enter">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6">
        <PageHeader
          title="系统"
          description="查看服务运行状态、更新来源与网络入口；功能一览等技术信息收在页面底部。"
          meta={<span className="text-[11px] text-pi-dim2">{dirty ? '配置有未保存修改' : '服务配置中心'}</span>}
        />

        <section data-slot="system-status" className="mb-8">
          <SectionHeader title="当前状态" description="进入页面即可判断服务是否在线、运行在哪个版本和网络入口。" />
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            <StatusTile
              label="服务状态"
              value={serviceReady ? '运行中' : '加载中'}
              detail={info.name || '元枢个人智能系统'}
              facts={[
                { k: '监听端口', v: info.port ? String(info.port) : '—' },
                { k: '数据目录', v: info.wsRoot || '—' },
              ]}
              icon={Server}
              tone={serviceReady ? 'success' : 'neutral'}
            />
            {/* 版本这一格以前只把 Node 版本当副标题裸放着，读者分不清 v2.70.0 和 v25.8.2 各是什么。
                现在大字是应用版本，下面逐条标出"运行时/平台"——不再重复写一遍应用版本。 */}
            <StatusTile
              label="版本"
              value={info.version ? `元枢 v${info.version}` : '—'}
              facts={[
                { k: '运行时', v: info.node ? `Node ${info.node}` : '—' },
                { k: '平台', v: info.platform || '—' },
              ]}
              icon={GitBranch}
              tone="info"
            />
            <StatusTile
              label="运行时长"
              value={info.uptimeSec ? fmtUptime(info.uptimeSec) : '—'}
              detail={info.startedAt ? `启动于 ${new Date(info.startedAt).toLocaleString('zh-CN', { hour12: false })}` : '等待服务信息'}
              icon={Timer}
              tone="neutral"
            />
            <StatusTile
              label="网络状态"
              value={data ? networkEntryCount > 0 ? '已发现入口' : '未发现入口' : '—'}
              detail={data ? `${networkEntryCount} 个入口 · ${lanEntryCount} 个局域网 · ${domainEntryCount} 个公网域名` : '等待系统信息'}
              facts={primaryEntry ? [{ k: '主入口', v: primaryEntry }] : undefined}
              icon={Wifi}
              tone={data && networkEntryCount > 0 ? 'info' : 'neutral'}
            />
          </div>
        </section>

        <section data-slot="system-primary" className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-8">
          <div>
            <SectionHeader title="检测更新" description="对比远端仓库，确认当前工作台是否需要更新。" />
            <div className="panel !p-3 min-h-[132px]">
              {!update ? (
                <button type="button" className="btn-primary text-xs px-3.5 py-1.5 inline-flex items-center gap-1.5" disabled={checking} onClick={checkUpdate}>
                  <RefreshCw className={`w-3.5 h-3.5 ${checking ? 'animate-spin' : ''}`} aria-hidden="true" />{checking ? '检测中…' : '对比远端仓库'}
                </button>
              ) : !update.ok ? (
                <div className="flex items-center gap-2 text-xs text-pi-warning">
                  <AlertTriangle className="w-4 h-4" aria-hidden="true" />{update.error}
                  <button type="button" className="btn-tool text-[11px] !px-2 !py-1 ml-auto" onClick={checkUpdate}>重试</button>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pi-md text-xs font-medium ${update.upToDate ? 'bg-pi-success/15 text-pi-success' : 'bg-pi-warning/15 text-pi-warning'}`}>
                    {update.upToDate
                      ? <><CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />已是最新（{update.source} · 本地 {update.localSha}）</>
                      : <><AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />有更新：本地 {update.localSha} → 远端 {update.remote?.sha}</>}
                  </div>
                  {!update.upToDate && update.remote?.message && (
                    <>
                      <div className="text-[12px] text-pi-dim break-all">远端最新：{update.remote.message}</div>
                      <div className="text-[12px] text-pi-dim2 bg-pi-bg2 rounded-pi-sm p-2 font-mono break-all">
                        git pull && cd frontend && pnpm install --frozen-lockfile && npm run build
                      </div>
                    </>
                  )}
                  <div><button type="button" className="btn-tool text-[11px] !px-2 !py-1" onClick={checkUpdate}>重新检测</button></div>
                </div>
              )}
            </div>
          </div>

          <div>
            <SectionHeader title="外网配置" description="管理公网域名与局域网入口，增删改后保存即生效。" />
            <div className="panel !p-3">
              <p className="text-[12px] text-pi-dim2 mb-3">公网域名列表（隧道映射到本服务）。</p>
              <div className="space-y-2">
                {domains.map((d, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input aria-label={`域名 ${i + 1}`} className="input-pi !py-1.5 text-xs font-mono flex-1 min-w-0" placeholder="example.com" value={d.domain} onChange={e => editRow(i, 'domain', e.target.value)} />
                    <input aria-label={`域名说明 ${i + 1}`} className="input-pi !py-1.5 text-xs w-32 sm:w-44 flex-shrink-0" placeholder="说明（可选）" value={d.desc} onChange={e => editRow(i, 'desc', e.target.value)} />
                    <button type="button" className="btn-tool touch-hit hover:!text-pi-danger flex-shrink-0" title="删除此域名" aria-label="删除此域名" onClick={() => delRow(i)}><Trash2 className="w-4 h-4" /></button>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-2 mt-3">
                <button type="button" className="btn-ghost text-xs px-3 py-1.5 inline-flex items-center gap-1.5" onClick={addRow}><Plus className="w-3.5 h-3.5" aria-hidden="true" />添加域名</button>
                <button type="button" className="btn-primary text-xs px-3.5 py-1.5 ml-auto inline-flex items-center gap-1.5 disabled:opacity-40" disabled={!dirty} onClick={saveNet}><Save className="w-3.5 h-3.5" aria-hidden="true" />保存配置</button>
                {netMsg && <span className="text-[12px] text-pi-accent">{netMsg}</span>}
              </div>

              <div className="mt-4 pt-3 border-t border-pi-border-soft">
                <div className="text-[12px] text-pi-dim2 mb-2">局域网直连（同一 WiFi 下打开）：</div>
                <div className="space-y-1">
                  {(info.network?.lanIPs || []).map((ip: string) => {
                    const lanUrl = `http://${ip}:${port}`
                    return (
                      <div key={ip} className="flex items-center gap-2 text-xs">
                        <code className="font-mono text-pi-text bg-pi-bg2 px-2 py-0.5 rounded-pi-sm">{lanUrl}</code>
                        <button type="button" className="btn-tool text-[11px] !px-1.5 !py-0.5 inline-flex items-center gap-1" onClick={() => copyText(lanUrl)}>
                          <Copy className="w-3 h-3" aria-hidden="true" />{copiedIp === lanUrl ? '已复制' : '复制'}
                        </button>
                      </div>
                    )
                  })}
                  {!(info.network?.lanIPs || []).length && <span className="text-[12px] text-pi-dim2">未检测到局域网地址</span>}
                </div>
              </div>
            </div>
          </div>
        </section>

        <details className="panel !p-0 overflow-hidden mb-4">
          <summary className="px-4 py-3 cursor-pointer select-none flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-2 text-[13px] font-semibold text-pi-text"><MonitorCog className="w-4 h-4 text-pi-accent" aria-hidden="true" />功能一览</span>
            <span className="inline-flex items-center gap-1.5 text-[11px] text-pi-dim2 font-normal">技术信息<ChevronDown className="w-3.5 h-3.5" aria-hidden="true" /></span>
          </summary>
          <div className="border-t border-pi-border-soft p-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {(info.capabilities || []).map(c => {
                const Icon = CAP_ICONS[c.icon] || CAP_FALLBACK
                return (
                  <div key={c.name} className="panel !p-3.5 flex gap-3 items-start card-hover">
                    <div className="w-8 h-8 rounded-pi-md bg-pi-accent/12 text-pi-accent flex items-center justify-center flex-shrink-0"><Icon className="w-[17px] h-[17px]" strokeWidth={1.8} aria-hidden="true" /></div>
                    <div className="min-w-0"><div className="text-[13px] font-medium text-pi-text">{c.name}</div><div className="text-[12px] text-pi-dim2 mt-0.5 leading-relaxed">{c.desc}</div></div>
                  </div>
                )
              })}
            </div>
            <div className="mt-4 pt-3 border-t border-pi-border-soft">
              <KV k="运行平台" v={info.platform} />
              <KV k="工作目录" v={info.wsRoot} />
              <KV k="启动时间" v={info.startedAt} />
            </div>
          </div>
        </details>
      </div>
    </div>
  )
}
