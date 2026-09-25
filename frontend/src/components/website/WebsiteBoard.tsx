import {lazy, Suspense, useEffect, useState} from 'react'
import {ArrowUpRight, ArrowLeft, Plus, Layers} from 'lucide-react'
import {websites, type WebsiteProject, type WebsiteSummary, type WebsiteTemplate} from '../../lib/website-api'
import WorkshopModelPicker,{useWorkshopModel} from '../WorkshopModelPicker'
import './website.css'
const WebsiteWorkspace=lazy(()=>import('./WebsiteWorkspace'))
const LegacyUiBoard=lazy(()=>import('../LegacyUiBoard'))
export default function WebsiteBoard() {
  const [templates,setTemplates]=useState<WebsiteTemplate[]>([]),[projects,setProjects]=useState<WebsiteSummary[]>([])
  const [project,setProject]=useState<WebsiteProject|null>(null),[template,setTemplate]=useState('')
  const model=useWorkshopModel('yuanshu-website-model')
  const [title,setTitle]=useState(''),[brief,setBrief]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[legacy,setLegacy]=useState(false)
  const refresh=()=>websites.list().then(r=>setProjects(r.projects))
  useEffect(()=>{
    let alive=true
    websites.templates().then(t=>alive&&setTemplates(t.templates)).catch(e=>alive&&setError(`参考模板暂不可用：${e.message}，仍可直接开始设计`))
    websites.list().then(p=>alive&&setProjects(p.projects)).catch(e=>alive&&setError(e.message))
    const id=sessionStorage.getItem('yuanshu-website-project')
    if(id)websites.get(id).then(p=>alive&&setProject(p)).catch(e=>{if(alive){setError(e.message);sessionStorage.removeItem('yuanshu-website-project')}})
    return()=>{alive=false}
  },[])
  const open=(p:WebsiteProject)=>{setProject(p);sessionStorage.setItem('yuanshu-website-project',p.id)}
  async function create(e:React.FormEvent){e.preventDefault();setBusy(true);setError('');try{open(await websites.create({title,brief,template:template||undefined,model:model.value,generate:true}))}catch(e:any){setError(e.message)}finally{setBusy(false)}}
  if(project)return <Suspense fallback={<p role="status">正在加载编辑器…</p>}><WebsiteWorkspace key={project.id} initial={project} onBack={()=>{setProject(null);sessionStorage.removeItem('yuanshu-website-project');refresh().catch(e=>setError(e.message))}} /></Suspense>
  if(legacy)return <div className="site-workshop"><button className="site-button" onClick={()=>setLegacy(false)}><ArrowLeft size={16}/>返回网站工坊</button><Suspense fallback={<p>正在加载旧版…</p>}><LegacyUiBoard/></Suspense></div>
  return <section className="site-workshop site-board">
    <header className="site-board-heading"><div><h2>一个想法，开始一个网站。</h2><p>说出你想做的页面，让 AI 构思并完成设计，再亲手调整每个细节。</p></div><button className="site-button" onClick={()=>setLegacy(true)}><Layers size={16}/>旧版作品与草稿</button></header>
    {error&&<p role="alert" className="site-notice">{error}</p>}
    <form className="site-create" onSubmit={create}><div><h3>你想做什么网站？</h3><p className="site-muted">内容、风格与布局从你的想法展开。生成过程随时可看，完成后先预览，再决定采用。</p></div><div className="site-form-fields"><label>描述你的想法<textarea required rows={4} maxLength={6000} value={brief} onChange={e=>setBrief(e.target.value)} placeholder="例如：一个摩托车俱乐部网站，像公路电影的片头，有路线故事、聚会与加入入口。大胆一点。"/></label><label>网站名称（选填）<input maxLength={100} value={title} onChange={e=>setTitle(e.target.value)} placeholder="留空时按想法命名"/></label><WorkshopModelPicker value={model.value} onChange={model.set} textModels={model.textModels}/><button className="site-button site-primary" disabled={busy||!model.value||!brief.trim()}><Plus size={17}/>{busy?'正在启动设计…':'开始 AI 设计'}</button></div></form>
    <details className="site-references"><summary>参考模板（选填）{template?' · 已选择参考':''}</summary><p className="site-muted">只提供灵感，不限制 AI 的布局和风格。</p><button className="site-button" aria-pressed={!template} onClick={()=>setTemplate('')}>不使用模板，自由设计</button><div className="site-template-grid" role="group" aria-label="选择参考模板">{templates.map(t=><button key={t.id} type="button" className={`site-template ${template===t.id?'is-selected':''}`} aria-pressed={template===t.id} onClick={()=>setTemplate(template===t.id?'':t.id)}>
      <div className={`site-template-view ${t.tone}`}><iframe title={`${t.name}预览`} srcDoc={t.preview} sandbox="" tabIndex={-1} loading="lazy"/></div>
      <div className="site-template-caption"><div><strong>{t.name}</strong><p>{t.subtitle}</p></div><ArrowUpRight size={20}/></div>
    </button>)}</div></details>
    <section className="site-projects"><div className="site-section-title"><h3>你的作品</h3><span className="site-muted">{projects.length} 个网站</span></div>{!projects.length?<p className="site-muted">从上面写下第一个想法。编辑过程中会保留本机草稿。</p>:<div className="site-project-list">{projects.map(p=><button className="site-project" key={p.id} disabled={busy} onClick={async()=>{setBusy(true);try{open(await websites.get(p.id))}catch(e:any){setError(e.message)}finally{setBusy(false)}}}><div><strong>{p.title}</strong><p>{p.brief.slice(0,70)}</p></div><span>{p.versionCount} 个版本 <ArrowUpRight size={16}/></span></button>)}</div>}</section>
  </section>
}
