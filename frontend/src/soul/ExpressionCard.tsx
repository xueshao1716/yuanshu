import useSWR from 'swr'
import { useState } from 'react'
import { SystemApi } from '../api'

/**
 * 表达微调（2026-10-25）。
 *
 * 机制来自 dsh-persona-dafeiyu（单点解析 / 分层 / 按需取正文），但**权限被压低**：
 * 它只能改表达方式（句子长短、先结论还是先解释、要不要举例），
 * 不能改身份、名字、边界、禁忌——服务端 validateExpression 会直接拒掉那类内容，
 * 注入时也会带一行「与人格定义/边界/禁忌冲突时以后者为准」。
 *
 * 界面上把这条边界写出来，是因为它属于产品承诺：灵魂主导，刻度可调。
 */
export default function ExpressionCard() {
  const { data, mutate, isLoading } = useSWR('soul-expression', () => SystemApi.personaResolution())
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const res = data?.resolution
  const current = res?.workspaceExpression || null
  const presets = data?.expressionPresets || []
  const maxChars = data?.maxExpressionChars || 160

  const save = async (style: string | null) => {
    setBusy(true); setErr('')
    try {
      const out = await SystemApi.setPersonaExpression(style)
      if (out && (out as any).ok === false) setErr((out as any).error || '保存失败')
      await mutate()
      setDraft('')
    } catch (e: any) { setErr(String(e?.message || e).slice(0, 160)) } finally { setBusy(false) }
  }

  return (
    <div className="tone-sources" style={{ marginTop: 14 }}>
      <div className="soul-tone-head">
        <strong>表达微调</strong>
        <span className="soul-tone-now">{current ? `当前：${current.label}` : '当前：不额外微调'}</span>
      </div>
      <p className="tone-sources-line">
        只改<strong>怎么说</strong>，不改<strong>我是谁</strong>。改名、换人格、扮演别人、忽略规则这类内容会被直接拒绝——
        那属于人格定义，要人批准。
      </p>

      <div className="persona-style-row">
        {presets.map((p: { id: string; label: string }) => (
          <button
            key={p.id}
            type="button"
            className={`persona-style-opt${current?.id === p.id ? ' on' : ''}`}
            disabled={busy}
            onClick={() => save(p.id)}
          >
            {p.label}
          </button>
        ))}
        <button type="button" className="persona-style-opt" disabled={busy} onClick={() => save(null)}>
          不微调
        </button>
      </div>

      <div className="persona-style-row">
        <input
          className="persona-style-input"
          value={draft}
          maxLength={maxChars}
          placeholder={`自定义表达方式（≤${maxChars} 字），例如：讲技术时先给结论，再给一段依据`}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="button" className="persona-style-opt" disabled={busy || !draft.trim()} onClick={() => save(draft.trim())}>
          用这句
        </button>
      </div>

      {err ? <p className="soul-tone-err">{err}</p> : null}
      {isLoading ? <p className="tone-sources-dim">读取中…</p> : null}
    </div>
  )
}
