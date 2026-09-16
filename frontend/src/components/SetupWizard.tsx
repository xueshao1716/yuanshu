import { useEffect, useMemo, useState } from 'react'
import { KeysApi } from '../api'
import { Check, ChevronRight, KeyRound, ServerCog } from 'lucide-react'

// ══ 首启向导（M1）：全新部署还没有任何模型密钥时，引导用户三步完成初始化 ══
// 触发：登录后 /api/keys/status 的 pi 列表为空；调试可用 ?setup=1 强制显示
// 流程：选服务商 → 填 Key（后端先验证后写入，假 Key 不会污染 auth.json）→ 完成

const POPULAR = ['deepseek', 'openrouter', 'zai', 'qwen', 'openai', 'anthropic', 'google', 'moonshotai']

type Preset = { id: string; name: string; baseUrl: string }

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
      // 常用的排前面，其余按名称
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
      // 统计可用模型数给完成页一个正反馈
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
    <div className="relative min-h-screen flex items-center justify-center px-4 overflow-hidden"
      style={{ background: 'radial-gradient(1100px 550px at 50% -10%, var(--pi-bg2) 0%, var(--pi-bg) 60%)' }}>
      <div className="relative z-10 panel w-full max-w-xl p-8">
        {/* 品牌头 */}
        <div className="text-center mb-6">
          <div className="text-3xl font-black text-pi-accent tracking-tight">◈ 元枢</div>
          <div className="text-pi-dim text-sm mt-1">初始化向导 · 三步让小语上线</div>
        </div>

        {/* 步骤指示 */}
        <div className="flex items-center justify-center gap-2 mb-6 text-xs">
          {['选择服务商', '填入密钥', '完成'].map((label, i) => (
            <div key={label} className="flex items-center gap-2">
              <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                step > i + 1 ? 'bg-pi-green text-pi-on-green' : step === i + 1 ? 'bg-pi-accent text-pi-on-accent' : 'bg-pi-bg3 text-pi-dim2'}`}>
                {step > i + 1 ? '✓' : i + 1}
              </span>
              <span className={step === i + 1 ? 'text-pi-text' : 'text-pi-dim2'}>{label}</span>
              {i < 2 && <ChevronRight className="w-3 h-3 text-pi-dim2" />}
            </div>
          ))}
        </div>

        {step === 1 && (
          <div>
            <div className="text-pi-dim text-sm mb-3">选择一个模型服务商（后面还能在「系统」页随时增删）：</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-80 overflow-y-auto pr-1">
              {presets.map(p => (
                <button key={p.id} onClick={() => pick(p)}
                  className="rounded-xl border border-pi-border bg-pi-bg2 hover:border-pi-accent hover:bg-pi-bg3 transition-colors px-3 py-2.5 text-left cursor-pointer">
                  <div className="text-[13px] font-medium text-pi-text truncate">{p.name}</div>
                  <div className="text-[11px] text-pi-dim2 truncate">{p.id}</div>
                </button>
              ))}
              {!presets.length && <div className="col-span-3 text-center text-pi-dim2 text-sm py-6">加载中…</div>}
            </div>
            <div className="mt-5 text-center">
              <button onClick={onDone} className="text-pi-dim2 hover:text-pi-dim text-xs cursor-pointer">
                跳过，稍后在「系统」页配置 →
              </button>
            </div>
          </div>
        )}

        {step === 2 && picked && (
          <div>
            <div className="flex items-center gap-2 mb-4">
              <span className="w-8 h-8 rounded-lg bg-pi-accent/15 flex items-center justify-center"><KeyRound className="w-4 h-4 text-pi-accent" /></span>
              <div>
                <div className="text-[15px] font-semibold text-pi-text">{picked.name}</div>
                <div className="text-[11px] text-pi-dim2">密钥只写入本机 auth.json，不会上传</div>
              </div>
            </div>
            <input className="input-pi mb-3" type="password" autoFocus placeholder="粘贴 API Key"
              value={apiKey} onChange={e => setApiKey(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} />
            <div className="flex items-center gap-2 mb-3">
              <ServerCog className="w-4 h-4 text-pi-dim2 flex-shrink-0" />
              <input className="input-pi" placeholder="API 地址（一般不用改）"
                value={baseUrl} onChange={e => setBaseUrl(e.target.value)} />
            </div>
            {err && <div className="text-pi-red text-xs mb-3">⚠ {err}</div>}
            <div className="flex gap-2">
              <button className="btn-ghost flex-1" onClick={() => { setStep(1); setErr('') }} disabled={busy}>返回</button>
              <button className="btn-primary flex-1" onClick={submit} disabled={busy || !apiKey.trim()}>
                {busy ? '验证中…' : '验证并保存'}
              </button>
            </div>
            <div className="mt-3 text-[11px] text-pi-dim2 text-center">保存前会先调服务商接口验证，假 Key 不会被写入</div>
          </div>
        )}

        {step === 3 && (
          <div className="text-center py-4">
            <div className="w-14 h-14 mx-auto rounded-full bg-pi-green/15 flex items-center justify-center mb-4">
              <Check className="w-7 h-7 text-pi-green" />
            </div>
            <div className="text-lg font-bold text-pi-text mb-1">初始化完成</div>
            <div className="text-pi-dim text-sm mb-6">小语已上线，随时开始对话</div>
            <button className="btn-primary px-8 py-2.5" onClick={onDone}>开始使用</button>
          </div>
        )}
      </div>
    </div>
  )
}
