import { useState } from 'react'
import { useApp } from '../store'
import WebglBackdrop from './WebglBackdrop'
import { mobileApiBaseError } from '../lib/shell-origin'
import { ArrowUpRight, Check, Eye, EyeOff, KeyRound, LockKeyhole, Server, Sparkles } from 'lucide-react'

export default function Login() {
  const { login } = useApp()
  const [apiBase, setApiBase] = useState('')
  const [token, setToken] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [showToken, setShowToken] = useState(false)

  const submit = async () => {
    const tk = token.trim(); if (!tk) return
    const origin = typeof location !== 'undefined' ? location.origin : ''
    const addressErr = mobileApiBaseError(apiBase, origin)
    if (addressErr) { setErr(addressErr); return }
    setLoading(true); setErr('')
    try { await login(tk, apiBase.trim()) }
    catch (e: any) { setErr(e?.status === 401 ? '令牌无效' : '连接失败：' + (e?.message || e)) }
    finally { setLoading(false) }
  }

  return (
    <div className="login-screen relative w-full min-h-full overflow-hidden" style={{ background: 'radial-gradient(1100px 620px at 14% 0%, color-mix(in srgb, var(--pi-accent) 14%, transparent), transparent 62%), radial-gradient(900px 600px at 100% 100%, color-mix(in srgb, var(--pi-accent2) 10%, transparent), transparent 60%), var(--pi-bg)' }}>
      <WebglBackdrop className="absolute inset-0" dim={0.18} />
      <div className="absolute inset-0 pointer-events-none opacity-35" style={{ backgroundImage: 'linear-gradient(color-mix(in srgb, var(--pi-border) 30%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--pi-border) 30%, transparent) 1px, transparent 1px)', backgroundSize: '64px 64px', maskImage: 'linear-gradient(to bottom, black, transparent 78%)' }} />

      <div className="relative z-10 mx-auto flex min-h-full w-full max-w-[1320px] flex-col px-5 py-6 sm:px-8 lg:px-12 lg:py-8">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-pi-accent/35 bg-pi-accent/10 text-pi-accent shadow-[0_0_28px_color-mix(in_srgb,var(--pi-accent)_18%,transparent)]"><Sparkles className="h-4 w-4" /></div>
            <div><div className="text-[15px] font-semibold tracking-[0.16em] text-pi-text">元枢</div><div className="text-[10px] uppercase tracking-[0.22em] text-pi-dim2">YUANSHU WORKSPACE</div></div>
          </div>
          <div className="hidden items-center gap-2 text-[11px] text-pi-dim2 sm:flex"><span className="h-1.5 w-1.5 rounded-full bg-pi-green shadow-[0_0_10px_var(--pi-green)]" />令牌保存在当前设备</div>
        </header>

        <main className="flex flex-1 items-center py-10 lg:py-14">
          <div className="grid w-full items-center gap-10 lg:grid-cols-[1.1fr_minmax(360px,460px)] lg:gap-20">
            <section className="hidden max-w-xl lg:block">
              <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-pi-border bg-pi-bg2/60 px-3 py-1.5 text-[11px] text-pi-dim backdrop-blur"><LockKeyhole className="h-3.5 w-3.5 text-pi-accent" /> 首次进入 · 设备授权</div>
              <h1 className="text-5xl font-semibold leading-[1.08] tracking-[-0.045em] text-pi-text xl:text-6xl">把你的工作台，<br /><span className="text-pi-accent">带到每一块屏幕。</span></h1>
              <p className="mt-6 max-w-md text-[15px] leading-7 text-pi-dim">连接后，元枢会把会话、资产、任务与自建引擎统一到这台设备上。令牌只用于本次设备授权，不会显示给模型。</p>
              <div className="mt-10 grid max-w-md grid-cols-3 gap-3">
                {[['01', '会话连续', '跨端接着做'], ['02', '资产归档', '生成物可追溯'], ['03', '引擎协作', '工具透明可见']].map(([n, title, desc]) => <div key={n} className="border-l border-pi-border pl-3"><div className="font-mono text-[10px] text-pi-accent">{n}</div><div className="mt-2 text-[12px] font-medium text-pi-text">{title}</div><div className="mt-1 text-[10px] leading-4 text-pi-dim2">{desc}</div></div>)}
              </div>
            </section>

            <section className="w-full max-w-[460px] justify-self-center lg:justify-self-end">
              <div className="rounded-[26px] border border-pi-border bg-pi-bg2/82 p-6 shadow-[0_24px_80px_rgba(0,0,0,.28)] backdrop-blur-xl sm:p-8">
                <div className="mb-7 lg:hidden"><div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-pi-accent/35 bg-pi-accent/10 text-pi-accent"><Sparkles className="h-4 w-4" /></div><h1 className="text-3xl font-semibold tracking-[-0.04em] text-pi-text">连接元枢</h1><p className="mt-2 text-sm leading-6 text-pi-dim">首次进入工作台，先完成这台设备的授权。</p></div>
                <div className="hidden lg:block"><div className="text-[11px] font-medium uppercase tracking-[0.2em] text-pi-accent">Welcome back</div><h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-pi-text">连接你的工作台</h2><p className="mt-2 text-sm leading-6 text-pi-dim">使用本机令牌安全进入元枢。</p></div>
                <div className="mt-6 space-y-4">
                  <label className="block"><span className="mb-2 flex items-center gap-2 text-[11px] font-medium text-pi-dim"><Server className="h-3.5 w-3.5 text-pi-accent" />工作台地址</span><input className="input-pi !min-h-12 !rounded-xl" placeholder="https://example.com 或 http://电脑IP:8787" value={apiBase} onChange={e => setApiBase(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} /></label>
                  <label className="block"><span className="mb-2 flex items-center gap-2 text-[11px] font-medium text-pi-dim"><KeyRound className="h-3.5 w-3.5 text-pi-accent" />访问令牌</span><div className="relative"><input className="input-pi !min-h-12 !rounded-xl !pr-12" type={showToken ? 'text' : 'password'} placeholder="粘贴服务器 .token 内容" value={token} onChange={e => setToken(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} /><button type="button" aria-label={showToken ? '隐藏访问令牌' : '显示访问令牌'} className="absolute right-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-lg text-pi-dim2 hover:bg-pi-bg3 hover:text-pi-text" onClick={() => setShowToken(v => !v)}>{showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div></label>
                </div>
                {err && <div role="alert" className="mt-4 rounded-xl border border-pi-red/30 bg-pi-red/10 px-3 py-2.5 text-xs leading-5 text-pi-red">{err}</div>}
                <button className="btn-primary mt-5 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold" disabled={loading || !token.trim()} onClick={submit}>{loading ? '正在连接工作台…' : <><span>进入元枢</span><ArrowUpRight className="h-4 w-4" /></>}</button>
                <div className="mt-5 flex items-start gap-2 border-t border-pi-border pt-4 text-[11px] leading-5 text-pi-dim2"><Check className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-pi-green" /><span>令牌只保存在当前设备的本地存储中。手机端请填写电脑公网或局域网地址，不要填 127.0.0.1。</span></div>
              </div>
              <div className="mt-4 text-center text-[11px] text-pi-dim2">还没有配置？登录后可在「系统」页管理模型与密钥。</div>
            </section>
          </div>
        </main>
        <footer className="flex items-center justify-between text-[10px] text-pi-dim2"><span>个人智能系统 · 小语为你值守</span><span className="hidden sm:block">PRIVATE WORKSPACE / ACCESS CONTROLLED</span></footer>
      </div>
    </div>
  )
}
