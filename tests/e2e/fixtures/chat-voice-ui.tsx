import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import RealtimeCall from '../../../frontend/src/components/RealtimeCall'
import { bootTheme } from '../../../frontend/src/theme/apply'
import 'virtual:uno.css'
import '../../../frontend/src/styles.css'
bootTheme()
function Fixture() {
  const [id,setId]=useState<string|null>(null), [messages,setMessages]=useState<string[]>([]), [open,setOpen]=useState(false)
  useEffect(()=>{void fetch('/api/test/session').then(r=>r.json()).then(r=>setId(r.id))},[])
  useEffect(()=>{
    const poll=()=>fetch('/api/test/messages').then(r=>r.json()).then(r=>setMessages(r.messages.map((m:any)=>m.content.map((c:any)=>c.text||'').join(''))))
    void poll();const timer=setInterval(()=>void poll(),400);return()=>clearInterval(timer)
  },[])
  return <main style={{height:'100dvh',display:'flex',flexDirection:'column',minHeight:0}} className="text-pi-text">
    <div hidden={open} className="mx-auto max-w-3xl space-y-4 p-4">
    <h1 className="text-xl font-semibold">元枢通话任务 · 隔离验收</h1>
    <p className="text-sm text-pi-dim2">测试语音与临时文件，不连接真实供应商。</p>
    <button onClick={()=>setOpen(true)} disabled={!id}>语音通话</button>
    <section aria-label="原聊天回执" className="space-y-3 border-t border-pi-border pt-4"><h2>原聊天</h2>
      {messages.map((text,i)=><p key={i} className="whitespace-pre-wrap break-words">{text}</p>)}
    </section>
    </div>
    <RealtimeCall sessionId={id} disabled={!id} open={open} onClose={()=>setOpen(false)} />
  </main>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
