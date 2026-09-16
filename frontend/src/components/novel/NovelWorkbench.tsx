import { useEffect, useRef, useState } from 'react'
import useSWR from 'swr'
import { ChevronLeft } from 'lucide-react'
import { NovelApi, type NovelChapter, type NovelPipelineNode } from '../../api'
import WorkshopModelPicker, { useWorkshopModel } from '../WorkshopModelPicker'
import NovelChapters from './NovelChapters'

const PIPELINE_LABELS = [
  { id: 'product', label: '产品化', phase: '产品化', kind: 'md', generate: true },
  { id: 'voice', label: '叙事声音', phase: '五层', kind: 'md', generate: true },
  { id: 'world', label: '世界观', phase: '五层', kind: 'md', generate: true },
  { id: 'characters', label: '人物', phase: '五层', kind: 'md', generate: true },
  { id: 'outline', label: '大纲', phase: '五层', kind: 'md', generate: true },
  { id: 'canon', label: '硬事实', phase: '五层', kind: 'md', generate: true },
  { id: 'state', label: '世界状态', phase: '真相', kind: 'json' },
  { id: 'hooks', label: '伏笔', phase: '真相', kind: 'json' },
  { id: 'ledger', label: '资源账本', phase: '真相', kind: 'json' },
  { id: 'subplots', label: '支线', phase: '真相', kind: 'json' },
  { id: 'arcs', label: '情感弧', phase: '真相', kind: 'json' },
  { id: 'matrix', label: '信息边界', phase: '真相', kind: 'json' },
  { id: 'summaries', label: '章摘要', phase: '真相', kind: 'json' },
  { id: 'write', label: '写章', phase: '写作', kind: 'write' },
  { id: 'revise', label: '修订', phase: '修订', kind: 'revise' },
  { id: 'export', label: '导出', phase: '导出', kind: 'export' },
]
const STATUSES: [string, string][] = [['draft', '草稿'], ['building', '构建中'], ['writing', '连载'], ['revising', '修订'], ['archived', '归档']]
const genreLabel: Record<string, string> = { xianxia: '仙侠', urban: '都市', scifi: '科幻', history: '历史', mystery: '悬疑', horror: '恐怖' }
function placeholderNode(content: string) {
  const t = String(content || '')
  return t.includes('待构建') || t.includes('尚未导出')
}

type Step = { id: string; name: string; args: string; status: 'running' | 'done' | 'error'; output?: string }

function useRunLog() {
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [steps, setSteps] = useState<Step[]>([])
  const abortRef = useRef<(() => void) | null>(null)
  const append = (s: string) => setLog(prev => [...prev.slice(-200), s])
  const start = (abort: () => void) => { setRunning(true); setLog([]); setSteps([]); abortRef.current = abort }
  const onEv = (ev: { type: string; data: any }, onDone?: () => void) => {
    const d = ev.data || {}
    if (ev.type === 'note') append('· ' + (d.text || ''))
    if (ev.type === 'tool') {
      const argsText = typeof d.args === 'object' && d.args !== null ? (d.args.command || d.args.path || d.args.prompt || JSON.stringify(d.args).slice(0, 100)) : String(d.args || '')
      setSteps(prev => [...prev, { id: d.id || 't' + Date.now(), name: d.name || 'tool', args: argsText, status: 'running' }])
    }
    if (ev.type === 'tool_end') setSteps(prev => prev.map(s => s.id === d.id ? { ...s, status: (d.isError ? 'error' : 'done'), output: (d.output || '').slice(0, 120) } : s))
    if (ev.type === 'error') { append('[错误] ' + (d.message || '未知错误')); setRunning(false) }
    if (ev.type === 'done') { setRunning(false); if (d.ok) { append('[完成]'); onDone?.() } }
  }
  const stop = () => { abortRef.current?.(); setRunning(false); append('[已手动停止]') }
  return { running, log, steps, start, onEv, stop }
}

export default function NovelWorkbench({ id, onBack }: { id: string; onBack: () => void }) {
  const { data, error, mutate } = useSWR(['novel-detail', id], ([, i]: readonly [string, string]) => NovelApi.detail(i), { revalidateOnFocus: false })
  const pipeline: NovelPipelineNode[] = (data?.pipeline && data.pipeline.length > 0)
    ? data.pipeline
    : PIPELINE_LABELS.map(n => ({ ...n, generate: !!n.generate, ready: false, chars: 0 }))
  const [nodeId, setNodeId] = useState('product')
  const node = pipeline.find(n => n.id === nodeId) || pipeline[0]
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState('')
  const [exported, setExported] = useState('')
  const run = useRunLog()
  const novelModel = useWorkshopModel('pi_workshop_model_novel')
  const meta = data?.meta || {}
  const chapters: NovelChapter[] = data?.chapters || []
  const nextCh = data?.nextCh || 1
  const foundationReady = ['product', 'voice', 'world', 'characters', 'outline', 'canon']
    .every(fid => pipeline.find(n => n.id === fid)?.ready)

  useEffect(() => { if (typeof data?.notes === 'string') setNote(data.notes) }, [id, data?.notes])

  useEffect(() => {
    if (!node || node.kind === 'write' || node.kind === 'revise') return
    NovelApi.node(id, node.id).then(r => { if (r.content != null) setDraft(r.content) }).catch(() => setDraft(''))
  }, [id, node?.id, node?.kind, node?.ready, node?.chars])

  const withNotes = (start: () => void) => {
    NovelApi.saveNotes({ id, notes: note }).catch(() => {}).finally(start)
  }
  const save = async () => { if (node) { await NovelApi.saveNode({ id, node: node.id, content: draft }); mutate() } }
  const studio = () => { if (run.running) return; withNotes(() => run.start(NovelApi.studio({ id, note, model: novelModel.value }, ev => run.onEv(ev, () => mutate())))) }
  const advance = () => { if (!node?.generate || run.running) return; withNotes(() => run.start(NovelApi.advance({ id, node: node.id, note, model: novelModel.value }, ev => run.onEv(ev, () => { mutate(); NovelApi.node(id, node.id).then(r => setDraft(r.content || '')) })))) }
  const write = () => { if (run.running) return; withNotes(() => run.start(NovelApi.write({ id, note, model: novelModel.value }, ev => run.onEv(ev, () => mutate())))) }
  const revise = () => { if (run.running) return; withNotes(() => run.start(NovelApi.revise({ id, note, model: novelModel.value }, ev => run.onEv(ev, () => mutate())))) }
  const doExport = async () => { const r = await NovelApi.export(id); setExported(r.content || ''); mutate() }

  if (error) return <div className="panel !p-6 text-[13px] text-red-400">加载失败</div>
  if (!data) return <div className="panel !p-6 text-[13px] text-pi-dim2">加载中…</div>
  if (data.error) return <div className="panel !p-6 text-[13px] text-red-400">{data.error}</div>

  const phases = Array.from(new Set(pipeline.map(n => n.phase)))

  return (
    <div className="space-y-4">
      <button className="flex items-center gap-1 text-xs text-pi-dim hover:text-pi-text min-h-11" onClick={onBack}>
        <ChevronLeft className="w-3.5 h-3.5" />返回书架
      </button>

      <div className="panel !p-3 flex items-baseline gap-2.5 flex-wrap">
        <h2 className="text-[17px] font-bold text-pi-text min-w-0 truncate">《{meta.title}》</h2>
        <select className="input-pi !py-2 text-[11px] w-24 min-h-11" value={meta.status || 'draft'}
          onChange={e => NovelApi.update({ id, status: e.target.value }).then(() => mutate())}>
          {STATUSES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <span className="text-[11px] text-pi-dim">{genreLabel[meta.genre] || meta.genre} · {meta.narrator || '第三人称'} · {chapters.length} 章 · 第 {nextCh} 章</span>
      </div>

      <div className="panel !p-3 space-y-2">
        <label className="text-[12px] font-semibold text-pi-text">我的意见</label>
        <p className="text-[11px] text-pi-dim2">管道自动生成设定和章节。你只需要随时改意见，再点自动生成 / 自动写 / 按意见修订。</p>
        <textarea className="input-pi text-[13px] min-h-[72px]" placeholder="例如：偏日常少装逼；第一章就掉马；反派要聪明…"
          value={note} onChange={e => setNote(e.target.value)} onBlur={() => NovelApi.saveNotes({ id, notes: note }).catch(() => {})} />
        <WorkshopModelPicker value={novelModel.value} onChange={novelModel.set} textModels={novelModel.textModels} />
        <div className="flex flex-wrap gap-2">
          {run.running
            ? <button className="min-h-11 px-4 rounded-pi-md bg-red-500/90 text-white text-xs w-full sm:w-auto" onClick={run.stop}>停止</button>
            : <>
                <button className="btn-primary text-xs px-3 min-h-11 whitespace-nowrap w-full sm:w-auto" onClick={studio}>{foundationReady ? '按意见重做设定' : '自动生成设定'}</button>
                <button className="btn-primary text-xs px-3 min-h-11 whitespace-nowrap w-full sm:w-auto" onClick={write} disabled={!foundationReady}>自动写第 {nextCh} 章</button>
                <button className="btn-ghost text-xs px-3 min-h-11 whitespace-nowrap w-full sm:w-auto" onClick={revise} disabled={!chapters.length}>按意见修订</button>
              </>}
        </div>
      </div>
      <NovelChapters id={id} chapters={chapters} onChanged={() => mutate()} />
      <div data-slot="novel-pipeline" className="flex flex-col lg:flex-row gap-4 items-start">
        <nav className="w-full lg:w-44 flex flex-col gap-3">
          {phases.map(phase => (
            <div key={phase}>
              <div className="text-[10px] text-pi-dim2 px-1 mb-1">{phase}</div>
              <div className="flex flex-wrap gap-1 lg:flex-col lg:gap-0.5">
                {pipeline.filter(n => n.phase === phase).map(n => (
                  <button key={n.id} onClick={() => setNodeId(n.id)}
                    className={`px-2.5 min-h-11 rounded-pi-md text-[12px] whitespace-nowrap lg:w-full lg:text-left ${nodeId === n.id ? 'bg-pi-accent text-pi-on-accent' : 'text-pi-dim hover:text-pi-text bg-pi-bg2/50 lg:bg-transparent'}`}>
                    <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 ${n.ready ? 'bg-emerald-400' : 'bg-pi-dim2'}`} />
                    {n.ready ? n.label : `${n.label} · 待生成`}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="flex-1 min-w-0 space-y-3">
          {node?.kind === 'export' && (
            <div className="panel !p-3 space-y-2.5">
              <button className="btn-primary text-xs px-4 min-h-11 w-full sm:w-auto" onClick={doExport}>导出全书</button>
              {exported && <pre className="text-[12px] whitespace-pre-wrap max-h-96 overflow-y-auto text-pi-dim">{exported}</pre>}
            </div>
          )}
          {node && node.kind !== 'write' && node.kind !== 'revise' && node.kind !== 'export' && (
            <div className="panel !p-3 space-y-2.5">
              {placeholderNode(draft) && (
                <p className="text-[12px] text-pi-dim">还没生成。上面填意见，点「自动生成设定」会一次写完产品化、五层和硬事实。</p>
              )}
              <textarea className="input-pi text-[13px] min-h-[280px] font-mono" value={placeholderNode(draft) ? '' : draft} placeholder={placeholderNode(draft) ? '生成后这里会变成设定正文，也可以先手写' : ''} onChange={e => setDraft(e.target.value)} />
              <div className="flex gap-2 flex-wrap">
                <button className="btn-ghost text-xs px-3 min-h-11 whitespace-nowrap w-full sm:w-auto" onClick={save}>保存</button>
                {node.generate && !run.running && <button className="btn-ghost text-xs px-3 min-h-11 whitespace-nowrap w-full sm:w-auto" onClick={advance}>按意见重做</button>}
              </div>
            </div>
          )}
          {(node?.kind === 'write' || node?.kind === 'revise') && (
            <p className="text-[12px] text-pi-dim2">用上方「自动写第 {nextCh} 章」和「按意见修订」。已写章节在上面查看、预览、修改。</p>
          )}

          {run.steps.length > 0 && (
            <div className="space-y-1.5">
              {run.steps.map((s, i) => (
                <div key={s.id || i} className="panel !p-2.5 text-[12px] font-mono">{s.name} · {s.status}{s.args ? ` · ${s.args}` : ''}</div>
              ))}
            </div>
          )}
          {run.log.length > 0 && (
            <div className="panel !p-3 max-h-40 overflow-y-auto font-mono text-[12px] text-pi-dim">{run.log.map((l, i) => <div key={i}>{l}</div>)}</div>
          )}
        </div>
      </div>
    </div>
  )
}
