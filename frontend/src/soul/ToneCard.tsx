import useSWR from 'swr'
import { useState } from 'react'
import { SystemApi } from '../api'

/**
 * 语气档（2026-10-25 从输入框搬到灵魂培育）。
 *
 * 为什么搬家：产品是"一个人格在长"，语气是**人格的一部分**，不是"换个角色聊天"。
 * 放在输入框旁边，等于把"人设切换"做成随时可换的开关——语义错了。
 * 这里改的是**工作区**档位（长期有效）；会话级临时覆盖仍保留在引擎里（会话 > 工作区），
 * 但不再给主入口，避免把"调语气"用成"换人格"。
 */
export default function ToneCard() {
  const { data, mutate, isLoading } = useSWR('soul-tone', () => SystemApi.personaResolution())
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const current = data?.resolution?.workspaceStyle || null
  const presets = data?.stylePresets || []
  const maxChars = data?.maxStyleChars || 200
  const total = data?.resolution?.chars || 0

  const save = async (style: string | null) => {
    setBusy(true); setErr('')
    try {
      const out = await SystemApi.setPersonaWorkspaceStyle(style)
      if (out && !out.ok) setErr((out as any).error || '保存失败')
      await mutate()
      setDraft('')
    } catch (e: any) { setErr(String(e?.message || e).slice(0, 120)) } finally { setBusy(false) }
  }

  return (
    <div className="soul-tone">
      <div className="soul-tone-head">
        <strong>语气档</strong>
        <span className="soul-tone-now">
          {current ? `当前：${current.label}` : '当前：跟随人格定义'}
        </span>
      </div>
      <p className="soul-tone-hint">
        只调语气，不改身份。人格定义仍是唯一真相（改它要人批准）；这里是长期设定，不是逐句指令。
        {total ? ` 人格段现在共 ${total} 字。` : ''}
      </p>

      <div className="persona-style-row">
        {presets.map((p) => (
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
          回到人格定义
        </button>
      </div>

      <div className="persona-style-row">
        <input
          className="persona-style-input"
          value={draft}
          maxLength={maxChars}
          placeholder={`自定义（≤${maxChars} 字），例如：讲技术时先给结论再给依据`}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="button" className="persona-style-opt" disabled={busy || !draft.trim()} onClick={() => save(draft.trim())}>
          用这句
        </button>
      </div>

      {err ? <p className="soul-tone-err">{err}</p> : null}
      {isLoading ? <p className="soul-tone-hint">读取中…</p> : null}
    </div>
  )
}
