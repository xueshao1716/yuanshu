import ThemedSelect from '../../components/ThemedSelect'
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { StoryBeat } from '../../types'

export default function StoryStart({ busy, onStart, children }: { busy: boolean; onStart: (idea: string, kind: StoryBeat['kind']) => void; children?: ReactNode }) {
  const [idea, setIdea] = useState('')
  const [kind, setKind] = useState<StoryBeat['kind']>('novel')
  return <section className="story-start">
    <h2>从一个想法，开始一个故事</h2>
    <p>你定方向，AI 整理人物和开场。先完成一段，再沿着同一份设定往下创作。</p>
    <label htmlFor="story-idea">描述你的故事</label>
    <textarea id="story-idea" value={idea} onChange={e => setIdea(e.target.value)} disabled={busy} placeholder="例如：一个胆小的少年穿越到武道世界，靠谨慎和智慧慢慢变强。先写雨夜破庙的开场。" rows={5} />
    <div className="story-examples"><span>试试：</span>{['一个胆小少年在武道世界慢慢变强', '女孩登上雾海列车，寻找失踪的父亲'].map(text => <button key={text} disabled={busy} onClick={() => setIdea(text)}>{text}</button>)}</div>
    {children && <details className="story-settings"><summary>选择构思模型 <span>也可以交给元枢自动选择</span></summary>{children}</details>}
    <div className="story-actions"><label>先做什么<ThemedSelect value={kind} disabled={busy} onChange={e => setKind(e.target.value as StoryBeat['kind'])}><option value="novel">小说段落</option><option value="image">故事画面</option><option value="video">视频片段</option></ThemedSelect></label><button className="btn-primary" disabled={busy || !idea.trim()} onClick={() => onStart(idea.trim(), kind)}>让 AI 搭好开场</button></div>
    <p className="story-hint">先生成可修改的草稿，不会立即调用生图或视频模型。</p>
  </section>
}
