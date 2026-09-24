import {lazy, Suspense, useEffect, useState} from 'react'
import {ArrowUpRight, ArrowLeft, Plus, Layers} from 'lucide-react'
import {websites, type WebsiteProject, type WebsiteSummary, type WebsiteTemplate} from '../../lib/website-api'
import './website.css'
const WebsiteWorkspace=lazy(()=>import('./WebsiteWorkspace'))
const LegacyUiBoard=lazy(()=>import('../LegacyUiBoard'))
export default function WebsiteBoard() {
  const [templates,setTemplates]=useState<WebsiteTemplate[]>([]),[projects,setProjects]=useState<WebsiteSummary[]>([])
  const [project,setProject]=useState<WebsiteProject|null>(null),[template,setTemplate]=useState('cinema')
  const [title,setTitle]=useState(''),[brief,setBrief]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[legacy,setLegacy]=useState(false)
  const refresh=()=>websites.list().then(r=>setProjects(r.projects))
  useEffect(()=>{
    let alive=true
    Promise.all([websites.templates(),websites.list()]).then(([t,p])=>{if(alive){setTemplates(t.templates);setProjects(p.projects)}}).catch(e=>alive&&setError(e.message))
    const id=sessionStorage.getItem('yuanshu-website-project')
    if(id)websites.get(id).then(p=>alive&&setProject(p)).catch(e=>{if(alive){setError(e.message);sessionStorage.removeItem('yuanshu-website-project')}})
    return()=>{alive=false}
  },[])
  const open=(p:WebsiteProject)=>{setProject(p);sessionStorage.setItem('yuanshu-website-project',p.id)}
  async function create(e:React.FormEvent){e.preventDefault();setBusy(true);setError('');try{open(await websites.create({title,brief,template}))}catch(e:any){setError(e.message)}finally{setBusy(false)}}
  if(project)return <Suspense fallback={<p role="status">正在加载编辑器…</p>}><WebsiteWorkspace key={project.id} initial={project} onBack={()=>{setProject(null);sessionStorage.removeItem('yuanshu-website-project');refresh().catch(e=>setError(e.message))}} /></Suspense>
  if(legacy)return <div className="site-workshop"><button className="site-button" onClick={()=>setLegacy(false)}><ArrowLeft size={16}/>返回网站工坊</button><Suspense fallback={<p>正在加载旧版…</p>}><LegacyUiBoard/></Suspense></div>
  return <section className="site-workshop site-board">
    <header className="site-board-heading"><div><h2>让想法，成为可触碰的页面。</h2><p>选一个起点，直接改文字、图片与布局。需要灵感时，再让 AI 接手。</p></div><button className="site-button" onClick={()=>setLegacy(true)}><Layers size={16}/>旧版作品与草稿</button></header>
    {error&&<p role="alert" className="site-notice">{error}</p>}
    <div className="site-template-grid" role="group" aria-label="选择起步模板">{templates.map(t=><button key={t.id} type="button" className={`site-template ${template===t.id?'is-selected':''}`} aria-pressed={template===t.id} onClick={()=>setTemplate(t.id)}>
      <div className={`site-template-view ${t.tone}`}><iframe title={`${t.name}预览`} srcDoc={t.preview} sandbox="" tabIndex={-1} loading="lazy"/></div>
      <div className="site-template-caption"><div><strong>{t.name}</strong><p>{t.subtitle}</p></div><ArrowUpRight size={20}/></div>
    </button>)}</div>
    <form className="site-create" onSubmit={create}><div><p className="site-kicker">Start with your story</p><h3>给这个页面一个主题。</h3><p className="site-muted">模板即刻可编辑，无需等待模型。</p></div><div className="site-form-fields"><label>网站名称<input required maxLength={100} value={title} onChange={e=>setTitle(e.target.value)} placeholder="例如：山野俱乐部"/></label><label>页面要讲什么<textarea required rows={2} maxLength={6000} value={brief} onChange={e=>setBrief(e.target.value)} placeholder="给谁看、要传递什么、希望访客做什么"/></label><button className="site-button site-primary" disabled={busy||!templates.length}><Plus size={17}/>{busy?'正在创建…':'用此模板开始'}</button></div></form>
    <section className="site-projects"><div className="site-section-title"><h3>你的作品</h3><span className="site-muted">{projects.length} 个网站</span></div>{!projects.length?<p className="site-muted">第一个页面，从上面的模板开始。编辑过程中会保留本机草稿。</p>:<div className="site-project-list">{projects.map(p=><button className="site-project" key={p.id} disabled={busy} onClick={async()=>{setBusy(true);try{open(await websites.get(p.id))}catch(e:any){setError(e.message)}finally{setBusy(false)}}}><div><strong>{p.title}</strong><p>{p.brief.slice(0,70)}</p></div><span>{p.versionCount} 个版本 <ArrowUpRight size={16}/></span></button>)}</div>}</section>
  </section>
}
