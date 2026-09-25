import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import ChatMediaProvider from '../src/components/ChatMediaProvider'
import Message from '../src/components/Message'
import '../src/styles.css'
import 'virtual:uno.css'

const img = '/api/ws/file?path=测试/海报.png'
const video = '/api/ws/file?path=测试/短片.webm'
const messages = [
  { id: 'a1', sessionId: 'a', role: 'user' as const, text: '验收图片', images: [img] },
  { id: 'a2', sessionId: 'a', role: 'user' as const, text: '验收视频', videos: [video] },
  { id: 'a3', sessionId: 'a', role: 'user' as const, text: '第二张图片', images: ['/api/ws/file?path=测试/第二张.png'] },
]
function Fixture() {
  const [sid, setSid] = useState('a')
  return <div style={{ padding: 16 }}>
    <button onClick={() => setSid(sid === 'a' ? 'b' : 'a')}>切换测试会话</button>
    <ChatMediaProvider key={sid} sessionId={sid} messages={messages}>
      {messages.filter(m => m.sessionId === sid).map(m => <Message key={m.id} msg={m} />)}
    </ChatMediaProvider>
  </div>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
