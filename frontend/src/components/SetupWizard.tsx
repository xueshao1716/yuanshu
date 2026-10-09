import { useEffect, useMemo, useState } from 'react'
import { KeysApi, SystemApi, getToken } from '../api'
import { useApp } from '../store'
import { Check, ChevronRight, Copy, KeyRound, ServerCog, Zap, Brain, Shield, RefreshCw, Lock, Sparkles, User } from 'lucide-react'

// ══ 首启向导：全新安装时引导用户完成初始化 ══
// 触发：服务端 .setup-pending（新装生成令牌时落盘）或 ?setup=1；进入前已登录（本机自动领取令牌或登录页）。
// 流程：① 令牌（默认沿用安装生成的，可改）→ ② 选服务商 → ③ 填 Key → ④ 灵魂确认（默认保留，可改名字/称呼）→ 完成
// 跳过模型也会进灵魂确认；完成时 POST /api/setup/done 清标记，之后不再弹出。

const POPULAR = ['deepseek', 'openrouter', 'zai', 'qwen', 'openai', 'anthropic', 'google', 'moonshotai']

type Preset = { id: string; name: string; baseUrl: string }

const FEATURES = [
  { icon: Brain,   title: '持续学习',  desc: '基因系统记录每次交互，小语会越来越了解你' },
  { icon: Zap,     title: '工具联动',  desc: '读写文件、执行命令、联网搜索，一站式完成任务' },
  { icon: Shield,  title: '本地运行',  desc: '所有数据留在本机，密钥不上传，隐私有保障' },
]

const STEP_LABELS = ['设置令牌', '选择服务商', '填入密钥', '灵魂确认']

function genToken() {
  const arr = new Uint8Array(12)
  crypto.getRandomValues(arr)
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('')
}

export default function SetupWizard({ onDone }: { onDone: () => void }) {
  const { login } = useApp()
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1)

  // Step 1 — 令牌：默认沿用当前令牌（安装时生成），保存时未改动就不重写
  const [token, setToken] = useState(() => getToken() || genToken())
  const [copied, setCopied] = useState(false)
  const [finishErr, setFinishErr] = useState('')
  const [tokenMode, setTokenMode] = useState<'auto' | 'custom'>('auto')
  const [tokenBusy, setTokenBusy] = useState(false)
  const [tokenErr, setTokenErr] = useState('')

  // Step 2/3 — 模型
  const [presets, setPresets] = useState<Preset[]>([])
  const [picked, setPicked] = useState<Preset | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [modelBusy, setModelBusy] = useState(false)
  const [modelErr, setModelErr] = useState('')
  const [modelCount, setModelCount] = useState(0)

  // Step 4 — 灵魂
  const [soulName, setSoulName] = useState('小语')
  const [soulCalled, setSoulCalled] = useState('伙伴')
  const [soulKind, setSoulKind] = useState('20岁的女性 AI 工作伙伴')
  const [soulBusy, setSoulBusy] = useState(false)
  const [soulErr, setSoulErr] = useState('')
  const [soulLoaded, setSoulLoaded] = useState({ name: '小语', called: '伙伴' })

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
    }).catch(() => {})
  }, [])

  // 读取当前灵魂默认信息
  useEffect(() => {
    if (step !== 4) return
    SystemApi.persona().then(p => {
      const d = p?.definition
      if (!d) return
      if (d.name) setSoulName(d.name)
      if (d.called) setSoulCalled(d.called)
      if (d.kind) setSoulKind(`${d.age ? d.age + '岁的' : ''}${d.gender ? d.gender + '性' : ''}${d.kind}`.replace(/性性/, '性'))
      setSoulLoaded({ name: d.name || '小语', called: d.called || '伙伴' })
    }).catch(() => {})
  }, [step])

  // ── Step 1：设置令牌 ──────────────────────────────────────────
  const saveToken = async () => {
    const t = token.trim()
    if (t.length < 8) { setTokenErr('令牌至少 8 个字符'); return }
    setTokenBusy(true); setTokenErr('')
    try {
      // 沿用当前令牌：不重写；改了：服务端先换，再用新令牌重新登录（旧令牌在途请求的 401 不会踢人，见 api.ts）
      if (t !== getToken()) {
        await SystemApi.changeToken(t)
        await login(t)
      }
      setStep(2)
    } catch (e: any) {
      setTokenErr(String(e?.message || '网络错误'))
    } finally { setTokenBusy(false) }
  }

  // ── Step 2：选服务商 ──────────────────────────────────────────
  const pick = (p: Preset) => {
    setPicked(p); setBaseUrl(p.baseUrl); setApiKey(''); setModelErr(''); setStep(3)
  }

  // ── Step 3：填 Key ────────────────────────────────────────────
  const submitKey = async () => {
    if (!apiKey.trim()) { setModelErr('请输入 API Key'); return }
    setModelBusy(true); setModelErr('')
    try {
      await KeysApi.apply({ provider: picked!.id, apiKey: apiKey.trim(), baseUrl: baseUrl.trim() })
      try {
        const s = await KeysApi.status()
        setModelCount(Array.isArray(s?.pi) ? s.pi.length : 1)
      } catch { setModelCount(1) }
      setStep(4)
    } catch (e: any) {
      setModelErr(String(e?.message || e).slice(0, 200))
    } finally { setModelBusy(false) }
  }

  // ── Step 4：灵魂确认 ──────────────────────────────────────────
  // 默认灵魂保留：只提交用户改过的名字/称呼；都没改等于确认默认值
  const saveSoul = async () => {
    const name = soulName.trim(), called = soulCalled.trim()
    if (!name || !called) { setSoulErr('名字和称呼都不能为空'); return }
    const patch: { name?: string; called?: string } = {}
    if (name !== soulLoaded.name) patch.name = name
    if (called !== soulLoaded.called) patch.called = called
    setSoulBusy(true); setSoulErr('')
    try {
      if (Object.keys(patch).length) await SystemApi.setupSoul(patch)
      setStep(5)
    } catch (e: any) {
      setSoulErr(String(e?.message || e).slice(0, 200))
    } finally { setSoulBusy(false) }
  }

  const copyToken = async () => {
    try { await navigator.clipboard.writeText(token.trim()); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch {}
  }

  // 完成：清服务端首启标记（失败也放行，下次打开会再进向导，不丢数据）
  const finish = async () => {
    setFinishErr('')
    try { await SystemApi.setupDone() } catch (e: any) { setFinishErr(String(e?.message || e).slice(0, 120)) }
    onDone()
  }

  // ── 布局 ──────────────────────────────────────────────────────
  const stepIndex = step <= 4 ? step - 1 : 4

  return (
    <div className="min-h-screen flex" style={{ background: 'var(--pi-bg)' }}>
      {/* 左侧品牌区 */}
      <div
        className="hidden lg:flex flex-col justify-between w-[380px] flex-shrink-0 p-12 relative overflow-hidden"
        style={{
          background: 'linear-gradient(160deg, oklch(22% 0.04 250) 0%, oklch(16% 0.06 270) 100%)',
          borderRight: '1px solid oklch(30% 0.04 250 / 0.6)',
        }}
      >
        <div className="absolute -top-32 -left-32 w-96 h-96 rounded-full opacity-10"
          style={{ background: 'radial-gradient(circle, var(--pi-accent) 0%, transparent 70%)' }} />
        <div className="absolute -bottom-24 -right-24 w-72 h-72 rounded-full opacity-[0.07]"
          style={{ background: 'radial-gradient(circle, var(--pi-accent) 0%, transparent 70%)' }} />

        <div className="relative z-10">
          <div className="text-4xl font-black tracking-tight mb-2" style={{ color: 'var(--pi-accent)' }}>◈ 元枢</div>
          <div className="text-sm font-medium" style={{ color: 'oklch(70% 0.04 250)' }}>你的本地 AI 工作台</div>
        </div>

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

        {/* 步骤指示 */}
        <div className="relative z-10 space-y-2">
          {STEP_LABELS.map((label, i) => {
            const idx = i + 1
            const done = step > idx
            const active = step === idx
            return (
              <div key={label} className="flex items-center gap-3">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold flex-shrink-0 transition-all ${
                  done ? 'bg-green-500/20 border border-green-500/40' : active ? 'border-2' : 'border'
                }`} style={{
                  borderColor: done ? undefined : active ? 'var(--pi-accent)' : 'oklch(40% 0.04 250)',
                  color: done ? 'oklch(65% 0.18 145)' : active ? 'var(--pi-accent)' : 'oklch(45% 0.03 250)',
                }}>
                  {done ? <Check className="w-3 h-3" /> : idx}
                </div>
                <span className="text-xs" style={{
                  color: done ? 'oklch(55% 0.04 250)' : active ? 'oklch(90% 0.02 250)' : 'oklch(45% 0.03 250)',
                  fontWeight: active ? 600 : 400,
                }}>{label}</span>
              </div>
            )
          })}
        </div>
      </div>

      {/* 右侧内容区 */}
      <div className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-md">

          {/* 移动端品牌头 */}
          <div className="lg:hidden text-center mb-8">
            <div className="text-3xl font-black mb-1" style={{ color: 'var(--pi-accent)' }}>◈ 元枢</div>
            <div className="text-sm" style={{ color: 'var(--pi-dim)' }}>初始化向导</div>
          </div>

          {/* 移动端步骤指示 */}
          <div className="lg:hidden flex items-center justify-center gap-1.5 mb-6">
            {STEP_LABELS.map((label, i) => {
              const idx = i + 1
              const done = step > idx
              const active = step === idx
              return (
                <div key={label} className="flex items-center gap-1.5">
                  <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold transition-colors ${
                    done ? 'bg-green-500/20' : active ? 'border-2' : 'border'
                  }`} style={{
                    borderColor: active ? 'var(--pi-accent)' : undefined,
                    color: done ? 'oklch(65% 0.18 145)' : active ? 'var(--pi-accent)' : 'var(--pi-dim2)',
                  }}>
                    {done ? '✓' : idx}
                  </span>
                  {i < STEP_LABELS.length - 1 && <ChevronRight className="w-3 h-3" style={{ color: 'var(--pi-dim2)' }} />}
                </div>
              )
            })}
          </div>

          {/* 卡片 */}
          <div className="panel p-8">

            {/* ── Step 1：设置令牌 ── */}
            {step === 1 && (
              <div>
                <div className="mb-5">
                  <div className="flex items-center gap-2 mb-1">
                    <Lock className="w-5 h-5" style={{ color: 'var(--pi-accent)' }} />
                    <div className="text-xl font-bold" style={{ color: 'var(--pi-text)' }}>设置访问令牌</div>
                  </div>
                  <div className="text-sm" style={{ color: 'var(--pi-dim)' }}>令牌是打开元枢的钥匙。安装时已生成一个，可以直接沿用，也可以换成自己的。</div>
                </div>

                {/* 模式切换 */}
                <div className="flex gap-2 mb-4">
                  {(['auto', 'custom'] as const).map(m => (
                    <button key={m} onClick={() => { setTokenMode(m); if (m === 'auto') setToken(genToken()) }}
                      className="flex-1 py-2 rounded-lg text-sm font-medium transition-all cursor-pointer"
                      style={{
                        background: tokenMode === m ? 'var(--pi-accent)' : 'var(--pi-bg2)',
                        color: tokenMode === m ? 'var(--pi-on-accent, #fff)' : 'var(--pi-dim)',
                        border: `1px solid ${tokenMode === m ? 'var(--pi-accent)' : 'var(--pi-border)'}`,
                      }}>
                      {m === 'auto' ? '随机生成' : '自定义'}
                    </button>
                  ))}
                </div>

                <div className="relative mb-4">
                  <input
                    className="input-pi font-mono text-sm w-full pr-16"
                    aria-label="访问令牌"
                    type="text"
                    value={token}
                    onChange={e => setToken(e.target.value)}
                    readOnly={tokenMode === 'auto'}
                    placeholder="输入自定义令牌（至少8位）"
                    style={{ opacity: tokenMode === 'auto' ? 0.7 : 1 }}
                  />
                  <button
                    onClick={copyToken}
                    className="absolute right-10 top-1/2 -translate-y-1/2 cursor-pointer transition-colors"
                    title={copied ? '已复制' : '复制令牌'}
                    aria-label="复制令牌"
                    style={{ color: copied ? 'var(--pi-green, oklch(55% 0.16 145))' : 'var(--pi-dim2)' }}
                  >
                    {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </button>
                  {tokenMode === 'auto' && (
                    <button
                      onClick={() => setToken(genToken())}
                      aria-label="重新生成令牌"
                      className="absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer transition-colors"
                      title="重新生成"
                      style={{ color: 'var(--pi-dim2)' }}
                      onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.color = 'var(--pi-accent)'}
                      onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.color = 'var(--pi-dim2)'}
                    >
                      <RefreshCw className="w-4 h-4" />
                    </button>
                  )}
                </div>

                <div className="rounded-lg px-3 py-2.5 mb-4 text-xs" style={{ background: 'var(--pi-bg2)', color: 'var(--pi-dim)', border: '1px solid var(--pi-border-soft)' }}>
                  <span style={{ color: 'var(--pi-accent)' }}>·</span> 令牌保存在本机 .token 文件，不上传任何服务器<br />
                  <span style={{ color: 'var(--pi-accent)' }}>·</span> 手机或其他电脑连进来时要输入它，先复制保存好<br />
                  <span style={{ color: 'var(--pi-accent)' }}>·</span> 之后可以在「系统」页随时修改
                </div>

                {tokenErr && <div className="text-xs mb-3 rounded-lg px-3 py-2"
                  style={{ background: 'oklch(50% 0.15 30 / 0.1)', color: 'var(--pi-red, oklch(55% 0.18 30))' }}>⚠ {tokenErr}</div>}

                <button className="btn-primary w-full py-2.5" onClick={saveToken} disabled={tokenBusy || token.trim().length < 8}>
                  {tokenBusy
                    ? <span className="flex items-center justify-center gap-1.5"><span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />保存中</span>
                    : token.trim() === getToken() ? '沿用此令牌，下一步' : '保存令牌，下一步'}
                </button>
              </div>
            )}

            {/* ── Step 2：选服务商 ── */}
            {step === 2 && (
              <div>
                <div className="mb-5">
                  <div className="text-xl font-bold mb-1" style={{ color: 'var(--pi-text)' }}>选择模型服务商</div>
                  <div className="text-sm" style={{ color: 'var(--pi-dim)' }}>选一个你有 API Key 的服务商，后续可在「系统」页随时增删。</div>
                </div>
                <div className="grid grid-cols-2 gap-2 max-h-72 overflow-y-auto pr-1 mb-5">
                  {presets.map(p => (
                    <button key={p.id} onClick={() => pick(p)}
                      className="rounded-xl border text-left px-3 py-2.5 transition-all cursor-pointer hover:scale-[1.02]"
                      style={{ borderColor: 'var(--pi-border)', background: 'var(--pi-bg2)' }}
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
                  <button onClick={() => setStep(4)} className="text-xs cursor-pointer transition-colors"
                    style={{ color: 'var(--pi-dim2)' }}
                    onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.color = 'var(--pi-dim)'}
                    onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.color = 'var(--pi-dim2)'}>
                    跳过模型，稍后在「系统」页配置 →
                  </button>
                </div>
              </div>
            )}

            {/* ── Step 3：填 Key ── */}
            {step === 3 && picked && (
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
                  value={apiKey} onChange={e => setApiKey(e.target.value)} onKeyDown={e => e.key === 'Enter' && submitKey()} />
                <div className="flex items-center gap-2 mb-4">
                  <ServerCog className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--pi-dim2)' }} />
                  <input className="input-pi text-sm" placeholder="API 地址（一般不用改）"
                    value={baseUrl} onChange={e => setBaseUrl(e.target.value)} />
                </div>
                {modelErr && <div className="text-xs mb-3 rounded-lg px-3 py-2"
                  style={{ background: 'oklch(50% 0.15 30 / 0.1)', color: 'var(--pi-red, oklch(55% 0.18 30))' }}>⚠ {modelErr}</div>}
                <div className="flex gap-2">
                  <button className="btn-ghost flex-1" onClick={() => { setStep(2); setModelErr('') }} disabled={modelBusy}>返回</button>
                  <button className="btn-primary flex-1" onClick={submitKey} disabled={modelBusy || !apiKey.trim()}>
                    {modelBusy
                      ? <span className="flex items-center justify-center gap-1.5"><span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />验证中</span>
                      : '验证并保存'}
                  </button>
                </div>
                <div className="mt-3 text-center text-[11px]" style={{ color: 'var(--pi-dim2)' }}>
                  保存前会先调服务商接口验证，假 Key 不会被写入
                </div>
              </div>
            )}

            {/* ── Step 4：灵魂确认 ── */}
            {step === 4 && (
              <div>
                <div className="mb-5">
                  <div className="flex items-center gap-2 mb-1">
                    <Sparkles className="w-5 h-5" style={{ color: 'var(--pi-accent)' }} />
                    <div className="text-xl font-bold" style={{ color: 'var(--pi-text)' }}>认识你的 AI 伙伴</div>
                  </div>
                  <div className="text-sm" style={{ color: 'var(--pi-dim)' }}>默认人格已经配好。确认一下她的名字和对你的称呼，想改就改。</div>
                </div>

                {/* 灵魂预览卡 */}
                <div className="rounded-xl p-4 mb-5" style={{ background: 'var(--pi-bg2)', border: '1px solid var(--pi-border-soft)' }}>
                  <div className="flex items-start gap-3">
                    <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 text-2xl"
                      style={{ background: 'oklch(30% 0.06 270 / 0.5)', border: '1px solid oklch(40% 0.05 270 / 0.4)' }}>
                      🌸
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-base mb-0.5" style={{ color: 'var(--pi-text)' }}>{soulName}</div>
                      <div className="text-xs" style={{ color: 'var(--pi-dim)' }}>{soulKind}</div>
                    </div>
                  </div>
                </div>

                {/* 名字设置 */}
                <div className="mb-4">
                  <label htmlFor="setup-soul-name" className="flex items-center gap-1.5 text-xs font-medium mb-1.5" style={{ color: 'var(--pi-dim)' }}>
                    <Sparkles className="w-3.5 h-3.5" />
                    她叫什么？
                  </label>
                  <input
                    id="setup-soul-name"
                    className="input-pi text-sm"
                    placeholder="小语"
                    value={soulName}
                    onChange={e => setSoulName(e.target.value)}
                    maxLength={20}
                  />
                </div>

                {/* 称呼设置 */}
                <div className="mb-4">
                  <label htmlFor="setup-soul-called" className="flex items-center gap-1.5 text-xs font-medium mb-1.5" style={{ color: 'var(--pi-dim)' }}>
                    <User className="w-3.5 h-3.5" />
                    她怎么称呼你？
                  </label>
                  <input
                    id="setup-soul-called"
                    className="input-pi text-sm"
                    placeholder="伙伴、老板、朋友……"
                    value={soulCalled}
                    onChange={e => setSoulCalled(e.target.value)}
                    maxLength={20}
                  />
                  <div className="text-[11px] mt-1" style={{ color: 'var(--pi-dim2)' }}>
                    对话中她会用这个称呼叫你，之后可在「灵魂」页修改
                  </div>
                </div>

                {soulErr && <div className="text-xs mb-3 rounded-lg px-3 py-2" role="alert"
                  style={{ background: 'oklch(50% 0.15 30 / 0.1)', color: 'var(--pi-red, oklch(55% 0.18 30))' }}>⚠ {soulErr}</div>}

                <div className="flex gap-2">
                  <button className="btn-ghost flex-1" onClick={() => { setSoulName(soulLoaded.name); setSoulCalled(soulLoaded.called); setStep(5) }} disabled={soulBusy}>保持默认</button>
                  <button className="btn-primary flex-1" onClick={saveSoul} disabled={soulBusy}>
                    {soulBusy
                      ? <span className="flex items-center justify-center gap-1.5"><span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />保存中</span>
                      : '确认，完成设置'}
                  </button>
                </div>
              </div>
            )}

            {/* ── Step 5：完成 ── */}
            {step === 5 && (
              <div className="text-center py-2">
                <div className="w-16 h-16 mx-auto rounded-2xl flex items-center justify-center mb-5"
                  style={{ background: 'oklch(50% 0.15 145 / 0.12)', border: '1px solid oklch(50% 0.15 145 / 0.2)' }}>
                  <Check className="w-8 h-8" style={{ color: 'var(--pi-green, oklch(55% 0.16 145))' }} />
                </div>
                <div className="text-xl font-bold mb-1" style={{ color: 'var(--pi-text)' }}>初始化完成</div>
                <div className="text-sm mb-1" style={{ color: 'var(--pi-dim)' }}>
                  {modelCount > 1 ? `已接入 ${modelCount} 个模型，${soulName}准备好了` : `${soulName}已上线，随时开始对话`}
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
                {finishErr && <div className="text-xs mb-3" role="alert" style={{ color: 'var(--pi-red, oklch(55% 0.18 30))' }}>⚠ {finishErr}</div>}
                <button className="btn-primary w-full py-2.5 text-sm" onClick={finish}>开始使用</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
