import { useEffect, useState } from 'react'
import { apiUrl } from '../api'
import { designs, type DesignProject, type DesignSummary } from '../lib/ui-design-api'
import UiDesignDetail from './UiDesignDetail'
import { designField, designButton } from '../lib/ui-design-styles'
export default function LegacyUiBoard() {
  const [projects, setProjects] = useState<DesignSummary[]>([])
  const [project, setProject] = useState<DesignProject | null>(null)
  const [title, setTitle] = useState(''), [brief, setBrief] = useState(''), [references, setReferences] = useState('')
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const refresh = () => designs.list().then(data => setProjects(data.projects))
  useEffect(() => {
    let disposed = false
    designs.list().then(data => { if (!disposed) setProjects(data.projects) }).catch(e => {if (!disposed) setError(e.message)})
    const id = sessionStorage.getItem('yuanshu-ui-project')
    if (id) designs.get(id).then(p => {if (!disposed) setProject(p)}).catch(e => {if (!disposed) setError(e.message)})
    return () => {disposed = true}
  }, [])
  async function open(id: string) {
    setError(''); setBusy(true)
    try {setProject(await designs.get(id)); sessionStorage.setItem('yuanshu-ui-project',id)}
    catch(e: any) {setError(e.message)} finally {setBusy(false)}
  }
  return <section className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-pi-dim">需求属于作品，修改留下版本。M3E 画布负责拖拽与交互预览。</p>
      <a className={designButton} href={apiUrl('/static/workshop-ui/index.html?vanilla=1')}>打开原有草稿</a>
    </div>
    {error && <p role="alert" className="text-sm text-pi-text">{error}</p>}
    {project ? <UiDesignDetail key={project.id} initial={project} onBack={() => {setProject(null);sessionStorage.removeItem('yuanshu-ui-project');refresh().catch(e=>setError(e.message))}} /> :
      <div className="grid gap-5 lg:grid-cols-2">
        <form className="space-y-4 rounded-pi-lg border border-pi-border-soft bg-pi-bg2 p-4" onSubmit={async e => {
          e.preventDefault();setBusy(true);setError('')
          try {const p=await designs.create({title,brief,references});setProject(p);sessionStorage.setItem('yuanshu-ui-project',p.id)}
          catch(err: any) {setError(err.message)} finally {setBusy(false)}
        }}>
          <h2 className="text-lg font-medium">新建界面作品</h2>
          <label className="block space-y-1"><span>作品名称</span><input className={designField} required maxLength={100} value={title} onChange={e=>setTitle(e.target.value)} placeholder="例如：周末活动报名页" /></label>
          <label className="block space-y-1"><span>这次要解决什么</span><textarea className={designField} required maxLength={6000} rows={4} value={brief} onChange={e=>setBrief(e.target.value)} placeholder="给谁用、主要操作、必须出现的内容" /></label>
          <label className="block space-y-1"><span>本作品参考（可选）</span><textarea className={designField} maxLength={6000} rows={3} value={references} onChange={e=>setReferences(e.target.value)} placeholder="粘贴参考文字或素材说明；不会自动读取链接或其他会话" /></label>
          <button className={designButton} disabled={busy}>{busy?'创建中…':'创建作品'}</button>
        </form>
        <div className="space-y-3">
          <h2 className="text-lg font-medium">已有作品</h2>
          {!projects.length && <p className="text-sm text-pi-dim">还没有作品。旧版画布草稿仍可从上方打开。</p>}
          {projects.map(p=><button key={p.id} disabled={busy} onClick={()=>open(p.id)} className="block w-full rounded-pi-lg border border-pi-border-soft p-4 text-left hover:bg-pi-bg2"><span className="block font-medium">{p.title}</span><span className="mt-1 block text-sm text-pi-dim">{p.versionCount} 个版本 · {p.brief.slice(0,90)}</span></button>)}
        </div>
      </div>}
  </section>
}
