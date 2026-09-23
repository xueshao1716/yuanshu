import { useEffect, useState } from 'react'
import { Camera, Shuffle } from 'lucide-react'
import { SCENES, dailyIdea, sceneBackdrop, sceneFor } from './studio-state.mjs'
import { imageForSkin } from './widget-state.mjs'
import { saveStudioPhoto } from './studio-photo'
import './studio.css'

type Props = { skin: string; name: string; scene: string; chooseScene: (id: string) => void }
export function WidgetStudio({ skin, name, scene, chooseScene }: Props) {
  const [offset, setOffset] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [failed, setFailed] = useState(false)
  const selected = sceneFor(scene), idea = dailyIdea(new Date(), offset), image = imageForSkin(skin)
  useEffect(() => { setFailed(false) }, [image])
  const save = async () => {
    if (saving) return
    setSaving(true); setNotice(''); setRevealed(true)
    try { await saveStudioPhoto(scene, image, name, idea); setNotice('照片已生成，请查看浏览器下载。') }
    catch { setNotice('照片未能保存，请稍后再试。') }
    finally { setSaving(false) }
  }
  return <div className="xiaoyu-studio">
    <div className="xiaoyu-stage" data-scene={scene} style={{ background: selected.bg, color: selected.ink }}>
      <img className="xiaoyu-set" src={'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(sceneBackdrop(scene))} alt="" />
      <p className="xiaoyu-scene-title">{selected.title}</p>
      {failed ? <span className="xiaoyu-stage-fallback">{name}的展台</span> : <img key={image} className="xiaoyu-stage-doll" src={image} alt={`${name}的${selected.label}展台`} onLoad={() => setFailed(false)} onError={() => setFailed(true)} />}
      <span className="xiaoyu-stage-caption">{name}的桌面展台</span>
    </div>
    <div className="xiaoyu-scene-picker" role="group" aria-label="展台场景">{SCENES.map(s =>
      <button key={s.id} type="button" aria-pressed={s.id === scene} onClick={() => chooseScene(s.id)}>{s.label}</button>,
    )}</div>
    <div className="xiaoyu-idea">
      {revealed ? <div key={offset} className="xiaoyu-idea-reveal" role="status"><strong>{idea.title}</strong><p>{idea.text}</p></div>
        : <div><strong>今天的灵感，藏在这里。</strong><p>一张小签，给创作换个角度。</p></div>}
      <div className="xiaoyu-studio-actions">
        <button type="button" onClick={() => { if (revealed) setOffset(n => n + 1); setRevealed(true) }}><Shuffle size={15} />{revealed ? '换个灵感' : '拆开今日签'}</button>
        <button type="button" disabled={saving} onClick={save}><Camera size={15} />{saving ? '保存中…' : '留张合影'}</button>
      </div>
      {notice && <p role="status">{notice}</p>}
    </div>
  </div>
}
