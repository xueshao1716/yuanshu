import { useEffect, useRef, useState } from 'react'
import { Sparkles } from 'lucide-react'
import PageHeader from '../components/PageHeader'
import { useApp } from '../store'
import PersonaEditor from '../soul/PersonaEditor'
import Genes from '../soul/Genes'
import History from '../soul/History'
import VoiceAppearance from '../soul/VoiceAppearance'
import Memory from '../soul/Memory'
import Overview, { sections, type Section } from '../soul/Overview'
import { Learning, Mother, Rhythm, Team } from '../soul/LiveSections'
import { Confirmations, SessionChoice } from '../soul/Confirmations'
import { errorText } from '../soul/shared'
import '../soul/soul.css'

const draftSections: Section[] = ['identity', 'genes', 'history']

export default function Soul() {
  const { currentSessionId } = useApp()
  const [section,setSection] = useState<Section>('overview'), [visited,setVisited] = useState<Section[]>(['overview'])
  const [sessionId,setSessionId] = useState(currentSessionId || '')
  const [busy,setBusy] = useState(false), [message,setMessage] = useState(''), [failed,setFailed] = useState(false), [dirty,setDirty] = useState(false)
  const running = useRef(false), heading = useRef<HTMLHeadingElement>(null)
  const open = (id: Section) => {setSection(id); setVisited(prev=>prev.includes(id)?prev:[...prev,id]); requestAnimationFrame(()=>heading.current?.focus())}
  const run = async (work:()=>Promise<unknown>) => {
    if(running.current) return false
    running.current=true; setBusy(true); setFailed(false); setMessage('正在处理；若需要批准，请核对下方确认卡。')
    try {await work(); setMessage('操作已完成。'); return true}
    catch(e) {setFailed(true); setMessage(errorText(e)); return false}
    finally {running.current=false; setBusy(false)}
  }
  useEffect(() => {
    if(!dirty && !busy) return
    const unload = (e:BeforeUnloadEvent) => {e.preventDefault(); e.returnValue=''}
    const leave = (e:Event) => {
      if (busy) {e.preventDefault(); setFailed(false); setMessage('当前操作尚未结束，请先确认或拒绝，或等待请求结束。'); return}
      if (!window.confirm('人格草稿尚未保存。离开会丢弃草稿，确定离开吗？')) e.preventDefault()
    }
    window.addEventListener('beforeunload',unload)
    window.addEventListener('yuanshu:before-route',leave)
    return ()=>{window.removeEventListener('beforeunload',unload); window.removeEventListener('yuanshu:before-route',leave)}
  },[dirty,busy])
  const title = sections.find(([id])=>id===section)!
  const props = {sessionId,busy,run}
  return <div className="soul-page">
    <div className="soul-shell">
      <PageHeader title="灵魂培养中心" description="从身份到经历，让每一次改变都有来处，也有退路。" meta={<span>{dirty ? '人格草稿未保存 · 分区切换会保留，离开页面前请处理' : '连接现有人格、aibody 与天团记录'}</span>} actions={<Sparkles aria-hidden="true" className="soul-mark" />} />
      <div className="soul-layout">
        <nav className="soul-nav" aria-label="培养分区">{sections.map(([id,label,hint])=><button key={id} aria-current={section===id?'page':undefined} onClick={()=>open(id)}><span>{label}</span><small>{hint}</small></button>)}</nav>
        <label className="soul-mobile-nav">培养分区<select value={section} onChange={e=>open(e.target.value as Section)}>{sections.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
        <main className="soul-workarea">
          <header className="soul-section-heading"><h2 ref={heading} tabIndex={-1}>{title[1]}</h2><p>{title[2]}</p></header>
          {['identity','voice','genes','history'].includes(section) || busy ? <SessionChoice sessionId={sessionId} setSessionId={setSessionId} disabled={busy} /> : null}
          <Confirmations sessionId={sessionId} active={draftSections.includes(section) || section === 'voice' || busy} busy={busy} />
          {message && <p role={failed?'alert':'status'} className="soul-notice">{message}</p>}
          {(visited.includes('identity') || visited.includes('voice')) && <div hidden={!(section === 'identity' || section === 'voice')}><PersonaEditor {...props} designMode={section === 'voice'} onDirtyChange={setDirty}/></div>}
          {visited.filter(id => id === section || draftSections.includes(id)).map(id=><div key={id} hidden={id!==section}>
            {id==='overview'?<Overview open={open}/>:id==='identity'?null:id==='genes'?<Genes {...props}/>:id==='rhythm'?<Rhythm/>:id==='memory'?<Memory/>:id==='learning'?<Learning/>:id==='mother'?<Mother/>:id==='team'?<Team/>:id==='voice'?<VoiceAppearance/>:<History {...props}/>}
          </div>)}
        </main>
      </div>
    </div>
  </div>
}
