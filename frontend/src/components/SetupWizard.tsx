import { useEffect, useMemo, useState } from 'react'
import { KeysApi } from '../api'
import { Check, ChevronRight, KeyRound, ServerCog, Zap, Brain, Shield } from 'lucide-react'

// ══ 首启向导（M1）：全新部署还没有任何模型密钥时，引导用户三步完成初始化 ══
// 触发：登录后 /api/keys/status 的 pi 列表为空；调试可用 ?setup=1 强制显示
// 流程：选服务商 → 填 Key（后端先验证后写入，假 Key 不会污染 auth.json）→ 完成

const POPULAR = ['deepseek', 'openrouter', 'zai', 'qwen', 'openai', 'anthropic', 'google', 'moonshotai']

type Preset = { id: string; name: string; baseUrl: string }

const FEATURES = [
  { icon: Brain,   title: '持续学习',  desc: '基因系统记录每次交互，小语会越来越了解你' },
  { icon: Zap,     title: '工具联动',  desc: '读写文件、执行命令、联网搜索，一站式完成任务' },
  { icon: Shield,  title: '本地运行',  desc: '所有数据留在本机，密钥不上传，隐私有保障' },
]

export default function SetupWizard({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [presets, setPresets] = useState<Preset[]>([])
  const [picked, setPicked] = useState<Preset | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [modelCount, setModelCount] = useState(0)

  useEffect(() => {
    KeysApi.presets().then((p: any) => {
      const list: Preset[] = Object.entries(p?.presets || p || {}).map(([id, v]: [string, any]) => ({
        id, name: v?.name || id, baseUrl: v?.baseUrl || '',
      }))
      list.sort((a, b) => {
        const ia = POPULAR.indexOf(a.id), ib = POPULAR.indexOf(b.id)
        if (ia >= 0 && ib >= 0) return ia - ib
        if (ia >= 0) return -1
        if (ib >= 0) return 1
        return a.name.localeCompare(b.name)
      })
      setPresets(list)
    }).catch(() => setErr('预设列表加载失败，请刷新重试'))
  }, [])

  const pick = (p: Preset) => {
    setPicked(p); setBaseUrl(p.baseUrl); setApiKey(''); setErr(''); setStep(2)
  }

  const submit = async () => {
    if (!apiKey.trim()) { setErr('请输入 API Key'); return }
    setBusy(true); setErr('')
    try {
      await KeysApi.apply({ provider: picked!.id, apiKey: apiKey.trim(), baseUrl: baseUrl.trim() })
      try {
        const s = await KeysApi.status()
        setModelCount(Array.isArray(s?.pi) ? s.pi.length : 1)
      } catch { setModelCount(1) }
      setStep(3)
    } catch (e: any) {
      setErr(String(e?.message || e).slice(0, 200))
    } finally { setBusy(false) }
  }

  return (
    <div className="min-h-screen flex" style={{ background: 'var(--pi-bg)' }}>
      {/* ── 左侧品牌区 ── */}
      <div
        className="hidden lg:flex flex-col justify-between w-[420px] flex-shrink-0 p-12 relative overflow-hidden"
        style={{
          background: 'linear-gradient(160deg, oklch(22% 0.04 250) 0%, oklch(16% 0.06 270) 100%)',
          borderRight: '1px solid oklch(30% 0.04 250 / 0.6)',
        }}
      >
        {/* 背景装饰圆 */}
        <div className="absolute -top-32 -left-32 w-96 h-96 rounded-full opacity-10"
          style={{ background: 'radial-gradient(circle, var(--pi-accent) 0%, transparent 70%)' }} />
        <div className="absolute -bottom-24 -right-24 w-72 h-72 rounded-full opacity-[0.07]"
          style={{ background: 'radial-gradient(circle, var(--pi-accent) 0%, transparent 70%)' }} />

        {/* 品牌头 */}
        <div className="relative z-10">
          <div className="text-4xl font-black tracking-tight mb-2" style={{ color: 'var(--pi-accent)' }}>◈ 元枢</div>
          <div className="text-sm font-medium" style={{ color: 'oklch(70% 0.04 250)' }}>你的本地 AI 工作台</div>
        </div>

        {/* 特性列表 */}
        <div className="relative z-10 space-y-6">
          {FEATURES.map(({ icon: Icon, title, desc }) => (
            <div key={title} className="flex gap-4">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ background: 'oklch(30% 0.06 270 / 0.5)', border: '1px solid oklch(40% 0.05 270 / 0.4)' }}>
                <Icon className="w-4 h-4" style={{ color: 'var(--pi-accent)' }} />
              </div>
              <div>
                <div className="text-sm font-semibold mb-0.5" style={{ color: 'oklch(90% 0.02 250)' }}>{title}</div>
                <div className="text-xs leading-relaxed" style={{ color: 'oklch(60% 0.03 250)' }}>{desc}</div>
              </div>
            </div>
          ))}
        </div>

        {/* 底部步骤指示 */}
        <div className="relative z-10 flex items-center gap-2">
          {[1, 2, 3].map(i => (
            <div key={i} className="flex items-center gap-2">
              <div className={`h-1.5 rounded-full transition-all duration-300 ${
                step === i ? 'w-6' : step > i ? 'w-3' : 'w-3'
              }`} style={{
                background: step >= i ? 'var(--pi-accent)' : 'oklch(35% 0.04 250)',
                opacity: step > i ? 0.5 : 1,
              }} />
            </div>
          ))}
          <span className="text-[11px] ml-2" style={{ color: 'oklch(50% 0.03 250)' }}>
            {step === 1 ? '选择服务商' : step === 2 ? '填入密钥' : '完成'}
          </span>
        </div>
      </div>

      {/* ── 右侧向导区 ── */}
      <div className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-md">

          {/* 移动端品牌头 */}
          <div className="lg:hidden text-center mb-8">
            <div className="text-3xl font-black mb-1" style={{ color: 'var(--pi-accent)' }}>◈ 元枢</div>
            <div className="text-sm" style={{ color: 'var(--pi-dim)' }}>初始化向导</div>
          </div>

          {/* 步骤指示（移动端） */}
          <div className="lg:hidden flex items-center justify-center gap-2 mb-6 text-xs">
            {(['选择服务商', '填入密钥', '完成'] as const).map((label, i) => (
              <div key={label} className="flex items-center gap-1.5">
                <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold transition-colors ${
                  step > i + 1 ? 'bg-pi-green text-pi-on-green' : step === i + 1 ? 'bg-pi-accent text-pi-on-accent' : 'bg-pi-bg3 text-pi-dim2'}`}>
                  {step > i + 1 ? '✓' : i + 1}
                </span>
                <span className={step === i + 1 ? 'text-pi-text' : 'text-pi-dim2'}>{label}</span>
                {i < 2 && <ChevronRight className="w-3 h-3 text-pi-dim2" />}
              </div>
            ))}
          </div>

          {/* 卡片 */}
          <div className="panel p-8">
            {step === 1 && (
              <div>
                <div className="mb-5">
                  <div className="text-xl font-bold mb-1" style={{ color: 'var(--pi-text)' }}>选择模型服务商</div>
                  <div className="text-sm" style={{ color: 'var(--pi-dim)' }}>选一个你有 API Key 的服务商，后续可在「系统」页随时增删。</div>
                </div>
                <div className="grid grid-cols-2 gap-2 max-h-72 overflow-y-auto pr-1 mb-5">
                  {presets.map(p => (
                    <button key={p.id} onClick={() => pick(p)}
                      className="rounded-xl border text-left px-3 py-2.5 transition-all cursor-pointer hover:scale-[1.02]"
                      style={{
                        borderColor: 'var(--pi-border)',
                        background: 'var(--pi-bg2)',
                      }}
                      onMouseEnter={e => {
                        (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--pi-accent)'
                        ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--pi-bg3)'
                      }}
                      onMouseLeave={e => {
                        (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--pi-border)'
                        ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--pi-bg2)'
                      }}
                    >
                      <div className="text-[13px] font-medium truncate" style={{ color: 'var(--pi-text)' }}>{p.name}</div>
                      <div className="text-[11px] truncate mt-0.5" style={{ color: 'var(--pi-dim2)' }}>{p.id}</div>
                    </button>
                  ))}
                  {!presets.length && (
                    <div className="col-span-2 text-center py-8 text-sm" style={{ color: 'var(--pi-dim2)' }}>
                      <div className="animate-pulse">加载中…</div>
                    </div>
                  )}
                </div>
                <div className="text-center">
                  <button onClick={onDone} className="text-xs cursor-pointer transition-colors"
                    style={{ color: 'var(--pi-dim2)' }}
                    onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.color = 'var(--pi-dim)'}
                    onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.color = 'var(--pi-dim2)'}>
                    跳过，稍后在「系统」页配置 →
                  </button>
                </div>
              </div>
            )}

            {step === 2 && picked && (
              <div>
                <div className="mb-5">
                  <div className="text-xl font-bold mb-1" style={{ color: 'var(--pi-text)' }}>填入 API Key</div>
                  <div className="flex items-center gap-2 mt-2">
                    <span className="w-7 h-7 rounded-lg flex items-center justify-center"
                      style={{ background: 'var(--pi-accent-soft, oklch(50% 0.15 250 / 0.15))' }}>
                      <KeyRound className="w-3.5 h-3.5" style={{ color: 'var(--pi-accent)' }} />
                    </span>
                    <span className="text-sm font-medium" style={{ color: 'var(--pi-text)' }}>{picked.name}</span>
                    <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'var(--pi-bg3)', color: 'var(--pi-dim2)' }}>
                      本机存储，不上传
                    </span>
                  </div>
                </div>
                <input className="input-pi mb-3 font-mono text-sm" type="password" autoFocus placeholder="粘贴 API Key"
                  value={apiKey} onChange={e => setApiKey(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} />
                <div className="flex items-center gap-2 mb-4">
                  <ServerCog className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--pi-dim2)' }} />
                  <input className="input-pi text-sm" placeholder="API 地址（一般不用改）"
                    value={baseUrl} onChange={e => setBaseUrl(e.target.value)} />
                </div>
                {err && <div className="text-xs mb-3 rounded-lg px-3 py-2"
                  style={{ background: 'oklch(50% 0.15 30 / 0.1)', color: 'var(--pi-red, oklch(55% 0.18 30))' }}>⚠ {err}</div>}
                <div className="flex gap-2">
                  <button className="btn-ghost flex-1" onClick={() => { setStep(1); setErr('') }} disabled={busy}>返回</button>
                  <button className="btn-primary flex-1" onClick={submit} disabled={busy || !apiKey.trim()}>
                    {busy ? <span className="flex items-center justify-center gap-1.5"><span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />验证中</span> : '验证并保存'}
                  </button>
                </div>
                <div className="mt-3 text-center text-[11px]" style={{ color: 'var(--pi-dim2)' }}>
                  保存前会先调服务商接口验证，假 Key 不会被写入
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="text-center py-2">
                <div className="w-16 h-16 mx-auto rounded-2xl flex items-center justify-center mb-5"
                  style={{ background: 'oklch(50% 0.15 145 / 0.12)', border: '1px solid oklch(50% 0.15 145 / 0.2)' }}>
                  <Check className="w-8 h-8" style={{ color: 'var(--pi-green, oklch(55% 0.16 145))' }} />
                </div>
                <div className="text-xl font-bold mb-1" style={{ color: 'var(--pi-text)' }}>初始化完成</div>
                <div className="text-sm mb-1" style={{ color: 'var(--pi-dim)' }}>
                  {modelCount > 1 ? `已接入 ${modelCount} 个模型，小语准备好了` : '小语已上线，随时开始对话'}
                </div>
                <div className="my-6 rounded-xl p-4 text-left space-y-2"
                  style={{ background: 'var(--pi-bg2)', border: '1px solid var(--pi-border-soft)' }}>
                  {[
                    '直接说任务：「帮我看看工作区里有什么」',
                    '产出放在 pi-workspace/交付/ 和 生成物/',
                    '「系统 → 环境体检」查看各组件状态',
                  ].map(tip => (
                    <div key={tip} className="flex gap-2 text-xs" style={{ color: 'var(--pi-dim)' }}>
                      <span style={{ color: 'var(--pi-accent)' }}>·</span>
                      <span>{tip}</span>
                    </div>
                  ))}
                </div>
                <button className="btn-primary w-full py-2.5 text-sm" onClick={onDone}>开始使用</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
