import { useEffect, useState } from 'react'
import { RefreshCw, CheckCircle2, AlertTriangle, Plus, Trash2, Save, Copy,
  Server, GitBranch, Timer, Wifi, KeyRound, Shield } from 'lucide-react'
import useSWR from 'swr'
import { SystemApi } from '../api'
import PageHeader from '../components/PageHeader'
import SectionHeader from '../components/SectionHeader'
import StatusTile from '../components/StatusTile'
import ComputerUsePanel from '../components/ComputerUsePanel'
import DoctorPanel from '../components/DoctorPanel'
import WechatPanel from '../components/WechatPanel'
import EmailPanel from '../components/EmailPanel'
import McpPanel from '../components/McpPanel'
import SandboxModePanel from '../components/engine/SandboxModePanel'
import MaintenanceModePanel from '../components/engine/MaintenanceModePanel'

type DomainRow = { domain: string; desc: string }

function KV({ k, v }: { k: string; v?: string }) {
  return (
    <div className="flex items-baseline gap-2 py-1.5 border-b border-pi-border-soft last:border-none">
      <span className="text-[11px] text-pi-dim2 w-24 flex-shrink-0">{k}</span>
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
  const { data, error, mutate } = useSWR('system-info', () => SystemApi.info(), { dedupingInterval: 30000, refreshInterval: 30000 })
  const info: any = data || {}

  const [update, setUpdate] = useState<any>(null)
  const [checking, setChecking] = useState(false)
  const [tokenVal, setTokenVal] = useState('')
  const [tokenInput, setTokenInput] = useState('')
  const [tokenMsg, setTokenMsg] = useState('')
  const [tokenBusy, setTokenBusy] = useState(false)
  const [tokenVisible, setTokenVisible] = useState(false)
  useEffect(() => {
    SystemApi.token().then((r: any) => { setTokenVal(r.token); setTokenInput(r.token) }).catch(() => {})
  }, [])

  const saveToken = async () => {
    if (!tokenInput.trim() || tokenInput.trim().length < 8) { setTokenMsg('令牌至少 8 个字符'); return }
    setTokenBusy(true); setTokenMsg('')
    try {
      await SystemApi.changeToken(tokenInput.trim())
      setTokenVal(tokenInput.trim()); setTokenMsg('已保存，刷新页面生效')
    } catch (e: any) { setTokenMsg(e?.message || '保存失败') }
    finally { setTokenBusy(false) }
  }

  const [applying, setApplying] = useState(false)
  const [applyMsg, setApplyMsg] = useState('')
  const checkUpdate = async () => {
    setChecking(true); setUpdate(null)
    try { setUpdate(await SystemApi.checkUpdate()) } catch (e: any) { setUpdate({ ok: false, error: e?.message || String(e) }) } finally { setChecking(false) }
  }
  const applyUpdate = async () => {
    if (applying || !update?.ok || update.upToDate) return
    if (!window.confirm('将拉取远端代码并重启服务，当前流式任务会中断。确定继续吗？')) return
    setApplying(true); setApplyMsg('正在拉取更新…')
    try {
      const r = await SystemApi.applyUpdate()
      setApplyMsg(r?.message || '更新已提交，服务正在重启…')
      await new Promise(r => setTimeout(r, 4000))
      const deadline = Date.now() + 120000
      let back = false
      while (Date.now() < deadline) {
        try { const h = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(3000) }); if (h.ok) { back = true; break } } catch {}
        setApplyMsg(`服务正在重启…（已等 ${Math.round((Date.now() - deadline + 120000) / 1000) + 4} 秒）`)
        await new Promise(r => setTimeout(r, 2000))
      }
      if (back) { setApplyMsg('服务已重启，正在刷新页面…'); window.location.reload(); return }
      setApplyMsg('更新已装好，但服务两分钟内没有自动起来。请从桌面「元枢」图标重新打开一次；仍不行请把安装目录 app\\watchdog.log 发给我。')
    } catch (e: any) {
      setApplyMsg(e?.message || '更新失败：请检查本地是否有未提交修改')
    } finally { setApplying(false) }
  }

  useEffect(() => {
    if (!data || update || checking) return
    void checkUpdate()
  }, [data])

  const [rows, setRows] = useState<DomainRow[] | null>(null)
  const [copiedIp, setCopiedIp] = useState('')
  const [netMsg, setNetMsg] = useState('')
  const domains: DomainRow[] = rows ?? info.network?.domains ?? []
  const dirty = rows !== null
  const port = info.port || 8787
  const serviceReady = !!data && !error
  const lanEntryCount = (info.network?.lanIPs || []).length
  const domainEntryCount = domains.filter(row => row.domain.trim()).length
  const networkEntryCount = lanEntryCount + domainEntryCount
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
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-8">

        <PageHeader
          title="系统"
          actions={<>
            <a className="btn-ghost min-h-11 inline-flex items-center px-3" href="#/grants">授权中心</a>
            <a className="btn-ghost min-h-11 inline-flex items-center px-3" href="#/soul">灵魂培养中心</a>
          </>}
          description="服务运行状态、网络入口、权限与安全设置。"
          meta={<span className="text-[11px] text-pi-dim2">{dirty ? '配置有未保存修改' : '服务配置中心'}</span>}
        />

        {/* ── 状态概览 ── */}
        <section>
          <SectionHeader title="当前状态" description="服务是否在线、版本与网络入口一览。" />
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            <StatusTile
              label="服务状态"
              value={error ? '连接失败' : serviceReady ? '运行中' : '加载中'}
              detail={error ? '无法读取服务状态，请检查服务是否已启动' : info.name || '元枢个人智能系统'}
              facts={[
                { k: '监听端口', v: info.port ? String(info.port) : '—' },
                { k: '数据目录', v: info.wsRoot || '—' },
              ]}
              icon={Server}
              tone={error ? 'danger' : serviceReady ? 'success' : 'neutral'}
            />
            <StatusTile
              label="服务端版本"
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
              value={error ? '连接失败' : data ? networkEntryCount > 0 ? '已登记入口' : '未登记入口' : '—'}
              detail={error ? '无法读取网络配置' : data ? `${networkEntryCount} 个入口 · ${lanEntryCount} 局域网 · ${domainEntryCount} 公网` : '等待系统信息'}
              facts={primaryEntry ? [{ k: '主入口', v: primaryEntry }] : undefined}
              icon={Wifi}
              tone={error ? 'danger' : data && networkEntryCount > 0 ? 'info' : 'neutral'}
            />
          </div>
        </section>

        {/* ── 诊断 ── */}
        <DoctorPanel />

        {/* ── 更新 + 网络 并排 ── */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div>
            <SectionHeader title="检测更新" description="对比远端仓库，确认当前工作台是否需要更新。" />
            <div className="panel !p-4 min-h-[140px] flex flex-col justify-center">
              {!update ? (
                <button type="button" className="btn-primary text-xs px-3.5 py-1.5 inline-flex items-center gap-1.5 self-start" disabled={checking} onClick={checkUpdate}>
                  <RefreshCw className={`w-3.5 h-3.5 ${checking ? 'animate-spin' : ''}`} aria-hidden="true" />
                  {checking ? '检测中…' : '对比远端仓库'}
                </button>
              ) : !update.ok ? (
                <div className="flex items-center gap-2 text-xs text-pi-warning">
                  <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span>{update.error}</span>
                  <button type="button" className="btn-tool text-[11px] !px-2 !py-1 ml-auto" onClick={checkUpdate}>重试</button>
                </div>
              ) : (
                <div className="space-y-2.5">
                  <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pi-md text-xs font-medium ${update.upToDate ? 'bg-pi-success/15 text-pi-success' : 'bg-pi-warning/15 text-pi-warning'}`}>
                    {update.checkable === false
                      ? <><AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />暂时无法确认本机版本</>
                      : update.upToDate && update.relation === 'ahead'
                      ? <><CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />本地领先远端{update.ahead ? ` ${update.ahead} 个提交` : ''}，待推送</>
                      : update.upToDate
                      ? <><CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />已是最新（{update.source} · {update.localSha}）</>
                      : <><AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />有更新：{update.localSha} → {update.remote?.sha}</>}
                  </div>
                  {!update.upToDate && update.remote?.message && (
                    <p className="text-[12px] text-pi-dim">远端最新：{update.remote.message}</p>
                  )}
                  <div className="flex items-center gap-2 flex-wrap">
                    {!update.upToDate && update.checkable !== false && (
                      <button type="button" className="btn-primary text-[11px] !px-2.5 !py-1" disabled={applying} onClick={applyUpdate}>
                        {applying ? '更新中…' : '更新并重启'}
                      </button>
                    )}
                    <button type="button" className="btn-tool text-[11px] !px-2 !py-1" onClick={checkUpdate}>重新检测</button>
                    {applyMsg && <span className="text-[11px] text-pi-dim2">{applyMsg}</span>}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div>
            <SectionHeader title="外网配置" description="登记公网域名与局域网入口；不会自动配置 DNS 或隧道。" />
            <div className="panel !p-4 space-y-3">
              <div className="space-y-2">
                {domains.map((d, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input aria-label={`域名 ${i + 1}`} className="input-pi !py-1.5 text-xs font-mono flex-1 min-w-0" placeholder="example.com" value={d.domain} onChange={e => editRow(i, 'domain', e.target.value)} />
                    <input aria-label={`域名说明 ${i + 1}`} className="input-pi !py-1.5 text-xs w-28 sm:w-36 flex-shrink-0" placeholder="说明（可选）" value={d.desc} onChange={e => editRow(i, 'desc', e.target.value)} />
                    <button type="button" className="btn-tool touch-hit hover:!text-pi-danger flex-shrink-0" title="删除此域名" aria-label="删除此域名" onClick={() => delRow(i)}><Trash2 className="w-4 h-4" /></button>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <button type="button" className="btn-ghost text-xs px-3 py-1.5 inline-flex items-center gap-1.5" onClick={addRow}><Plus className="w-3.5 h-3.5" />添加域名</button>
                <button type="button" className="btn-primary text-xs px-3.5 py-1.5 ml-auto inline-flex items-center gap-1.5 disabled:opacity-40" disabled={!dirty} onClick={saveNet}><Save className="w-3.5 h-3.5" />保存</button>
                {netMsg && <span className="text-[12px] text-pi-accent">{netMsg}</span>}
              </div>
              {(info.network?.lanIPs || []).length > 0 && (
                <div className="pt-3 border-t border-pi-border-soft space-y-1.5">
                  <p className="text-[11px] text-pi-dim2">局域网直连（同一 WiFi）</p>
                  {(info.network.lanIPs).map((ip: string) => {
                    const lanUrl = `http://${ip}:${port}`
                    return (
                      <div key={ip} className="flex items-center gap-2">
                        <code className="font-mono text-xs text-pi-text bg-pi-bg2 px-2 py-0.5 rounded-pi-sm flex-1 min-w-0 truncate">{lanUrl}</code>
                        <button type="button" className="btn-tool text-[11px] !px-1.5 !py-0.5 inline-flex items-center gap-1 shrink-0" onClick={() => copyText(lanUrl)}>
                          <Copy className="w-3 h-3" />{copiedIp === lanUrl ? '已复制' : '复制'}
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* ── 访问令牌 ── */}
        <section>
          <SectionHeader title="访问令牌" description="浏览器访问本服务所需的令牌，可在此查看或修改。改完刷新页面生效。" />
          <div className="panel !p-5 space-y-3">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-pi-dim2 pointer-events-none" />
                <input
                  className="input-pi font-mono text-xs w-full !pl-8"
                  type={tokenVisible ? 'text' : 'password'}
                  value={tokenInput}
                  onChange={e => setTokenInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && saveToken()}
                  placeholder="访问令牌"
                />
              </div>
              <button type="button" className="btn-ghost text-xs px-3 py-1.5 shrink-0" onClick={() => setTokenVisible(v => !v)}>
                {tokenVisible ? '隐藏' : '显示'}
              </button>
            </div>
            {tokenMsg && <p className={`text-xs ${tokenMsg.includes('已保存') ? 'text-pi-green' : 'text-pi-red'}`}>{tokenMsg}</p>}
            <div className="flex gap-2 flex-wrap">
              <button type="button" className="btn-primary text-xs px-4 py-1.5" onClick={saveToken} disabled={tokenBusy || !tokenInput.trim()}>
                {tokenBusy ? '保存中…' : '保存'}
              </button>
              <button type="button" className="btn-ghost text-xs px-4 py-1.5" onClick={() => { setTokenInput(tokenVal); setTokenMsg('') }}>重置</button>
              <button type="button" className="btn-ghost text-xs px-4 py-1.5" onClick={() => {
                const t = Array.from(crypto.getRandomValues(new Uint8Array(24))).map(b => b.toString(16).padStart(2, '0')).join('')
                setTokenInput(t); setTokenMsg('')
              }}>生成新令牌</button>
            </div>
            <p className="text-[11px] text-pi-dim2">令牌写在服务目录的 .token 文件里，请勿分享给他人。</p>
          </div>
        </section>

        {/* ── 接入模式 ── */}
        <section>
          <SectionHeader title="接入模式" description="微信、邮件、MCP 等外部服务接入。" />
          <div className="space-y-4">
            <WechatPanel />
            <EmailPanel />
            <McpPanel />
          </div>
        </section>

        {/* ── 电脑控制 ── */}
        <section>
          <SectionHeader title="电脑控制" description="允许元枢通过截图与鼠标键盘操作控制桌面应用。" />
          <ComputerUsePanel />
        </section>

        {/* ── 沙箱模式 ── */}
        <section>
          <SectionHeader
            title="沙箱模式"
            description="限制元枢执行器的文件访问范围。收紧随时可以；放宽需写明理由，会写入审计日志。与超维模式相互独立。"
          />
          <div className="panel !p-5">
            <SandboxModePanel />
          </div>
        </section>

        {/* ── 超维模式 ── */}
        <section>
          <SectionHeader
            title="超维模式"
            description="开启后元枢可执行高权限维护操作，需本机手动批准，到期自动收紧。与沙箱模式相互独立，开启超维不会自动放宽沙箱档位。"
          />
          <div className="panel !p-5">
            <MaintenanceModePanel />
          </div>
        </section>

        {/* ── 运行环境 ── */}
        <section>
          <SectionHeader title="运行环境" description="服务进程的技术参数。" />
          <div className="panel !p-4">
            <KV k="运行平台" v={info.platform} />
            <KV k="工作目录" v={info.wsRoot} />
            <KV k="启动时间" v={info.startedAt} />
          </div>
        </section>

      </div>
    </div>
  )
}
