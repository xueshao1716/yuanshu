import ThemedSelect from '../../components/ThemedSelect'
import { useState } from 'react'
import { StoryApi } from '../../api'
import type { StoryCharacter, StoryProject } from '../../types'

// 与角色对台词（照 Laper 的 Playground 补的）：拿一句话去"试"，看这个角色会不会这么说。
// 这是"重视对话创作"最直接的检验手段——写台词时最怕的就是"所有人都一个腔调"。
//
// 对话会留档在 `beat.playground`（有上限）：对台词是创作过程的一部分，
// 而且"这个角色这么说过了"本身就是要保持一致的既成事实。
export default function StoryPlayground({ project, sceneId, beatId, characters, turns, busy, onDone, onPick }: {
  project: StoryProject
  sceneId: string
  beatId: string
  characters: StoryCharacter[]
  turns: { role: string; text: string }[]
  busy: boolean
  onDone: (project: StoryProject) => void
  onPick?: (characterId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [who, setWho] = useState(characters[0]?.id || '')
  const [message, setMessage] = useState('')
  const [msg, setMsg] = useState('')
  const [sending, setSending] = useState(false)
  const active = characters.find(c => c.id === who) || characters[0]

  const send = async () => {
    if (!message.trim()) { setMsg('先说一句你想对他说的话'); return }
    setSending(true); setMsg('')
    try {
      const r = await StoryApi.playground(project.id, { sceneId, beatId, characterId: active?.id, message: message.trim() })
      onDone(r.project)
      setMessage('')
    } catch (e: any) { setMsg(e?.message || '角色没回话，过会儿再试') } finally { setSending(false) }
  }
  const clear = async () => {
    setSending(true)
    try { const r = await StoryApi.playgroundClear(project.id, { sceneId, beatId }); onDone(r.project); setMsg('已清空这一段的试戏记录') }
    catch (e: any) { setMsg(e?.message || '清空失败') } finally { setSending(false) }
  }

  return <div className="story-playground">
    <div className="story-head">
      <span>与角色对台词 · {turns.length ? `${turns.length} 句` : '还没试过'}</span>
      <button className="btn-ghost" disabled={busy} onClick={() => setOpen(o => !o)}>{open ? '收起' : '试戏（Playground）'}</button>
    </div>
    {open && <div className="story-playground-body">
      {!characters.length && <p className="story-hint">这个故事还没有角色：先在下方设定里加一个，或让 AI 补一段设定。</p>}
      {characters.length > 0 && <>
        <div className="story-playground-row">
          <label>扮演谁<ThemedSelect aria-label="试戏角色" value={who} disabled={busy || sending} onChange={e => { setWho(e.target.value); onPick?.(e.target.value) }}>
            {characters.map(c => <option key={c.id} value={c.id}>{c.name || c.id}</option>)}
          </ThemedSelect></label>
          <button className="btn-ghost" disabled={busy || sending || !turns.length} onClick={clear}>清空记录</button>
        </div>
        {turns.length > 0 && <ul className="story-playground-turns">
          {turns.map((t, i) => <li key={i} className={`story-playground-turn is-${t.role}`}>
            <span>{t.role === 'character' ? (active?.name || '角色') : '你'}</span>
            <p>{t.text}</p>
          </li>)}
        </ul>}
        <div className="story-playground-row">
          <input aria-label="对角色说的话" value={message} disabled={busy || sending}
            onChange={e => setMessage(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
            placeholder="对 TA 说一句（比如：用这段台词的反应试探他）" />
          <button className="btn-primary" disabled={busy || sending || !active} onClick={send}>{sending ? '他在想…' : '说'}</button>
        </div>
        <p className="story-hint">角色只能依据设定与「全剧至今」说话，不许编新设定、不许给创作建议；回复不入正片，只留在这一段的试戏记录里（最多 20 句）。</p>
      </>}
      {msg && <p role="status" className="story-notice">{msg}</p>}
    </div>}
  </div>
}
