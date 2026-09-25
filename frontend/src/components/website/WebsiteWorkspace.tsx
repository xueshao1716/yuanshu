import {useEffect,useRef,useState} from 'react'
import type {Editor,Component} from 'grapesjs'
import {ArrowLeft,Undo2,Redo2,Monitor,Tablet,Smartphone,Eye,Save,Download,Share2,Maximize2,Minimize2,X} from 'lucide-react'
import {websites,previewDocument,type WebsiteDoc,type WebsiteProject,type WebsiteVersion} from '../../lib/website-api'
import WorkshopModelPicker,{useWorkshopModel} from '../WorkshopModelPicker'
import WebsiteCanvas,{canvasDocument,loadCanvas} from './WebsiteCanvas'
import WebsiteInspector from './WebsiteInspector'
import WebsiteRunPanel from './WebsiteRunPanel'

type Draft={doc:WebsiteDoc;baseVersion:string;at:string}
export default function WebsiteWorkspace({initial,onBack}:{initial:WebsiteProject;onBack:()=>void}) {
  const [project,setProject]=useState(initial),[version,setVersion]=useState(initial.selectedVersion)
  const [editor,setEditor]=useState<Editor|null>(null),[selected,setSelected]=useState<Component|null>(null)
  const [dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
  const [instruction,setInstruction]=useState(''),[tab,setTab]=useState(initial.run?'ai':'edit'),[device,setDevice]=useState('desktop'),[full,setFull]=useState(false)
  const [preview,setPreview]=useState<{doc:WebsiteDoc;version?:WebsiteVersion}|null>(null),[share,setShare]=useState('')
  const draftKey=`yuanshu-website-draft:${initial.id}`,mute=useRef(false),timer=useRef<ReturnType<typeof setTimeout>|null>(null),savedSnapshot=useRef(''),previewDialog=useRef<HTMLDialogElement>(null)
  const base=initial.versions.find(v=>v.id===initial.selectedVersion)!,latest=useRef({editor,version,dirty})
  latest.current={editor,version,dirty}
  const [draft,setDraft]=useState<Draft|null>(()=>{try{const d=JSON.parse(localStorage.getItem(draftKey)||'null');return d?.doc&&initial.versions.some(v=>v.id===d.baseVersion)?d:null}catch{return null}})
  const model=useWorkshopModel('yuanshu-website-model'),running=project.run?.status==='running'
  useEffect(()=>{if(preview&&!previewDialog.current?.open)previewDialog.current?.showModal()},[preview])
  const persist=()=>{const c=latest.current;if(!c.editor||!c.dirty)return;try{localStorage.setItem(draftKey,JSON.stringify({doc:canvasDocument(c.editor),baseVersion:c.version,at:new Date().toISOString()}))}catch{setError('本机草稿空间不足，请点击保存版本以免丢失修改')}}
  useEffect(()=>{
    const unload=(e:BeforeUnloadEvent)=>{persist();if(latest.current.dirty){e.preventDefault();e.returnValue=''}}
    const hidden=()=>{if(document.hidden)persist()}
    window.addEventListener('beforeunload',unload);document.addEventListener('visibilitychange',hidden)
    return()=>{if(timer.current)clearTimeout(timer.current);persist();window.removeEventListener('beforeunload',unload);document.removeEventListener('visibilitychange',hidden)}
  },[])
  useEffect(()=>{
    if(!running)return
    let stopped=false,timeout:ReturnType<typeof setTimeout>
    const poll=async()=>{try{const p=await websites.get(initial.id);if(!stopped){setProject(p);setError('')}}catch(e:any){if(!stopped)setError(`进度暂时连接不上，正在重连：${e.message}`)}finally{if(!stopped)timeout=setTimeout(poll,1800)}}
    timeout=setTimeout(poll,1000);return()=>{stopped=true;clearTimeout(timeout)}
  },[running,initial.id])
  function changed(){if(mute.current)return;const e=latest.current.editor,isDirty=!!e&&JSON.stringify(canvasDocument(e))!==savedSnapshot.current;setDirty(isDirty);latest.current.dirty=isDirty;if(timer.current)clearTimeout(timer.current);if(isDirty)timer.current=setTimeout(persist,600);else localStorage.removeItem(draftKey)}
  function ready(e:Editor){savedSnapshot.current=JSON.stringify(canvasDocument(e));latest.current.editor=e;setEditor(e)}
  function load(doc:WebsiteDoc,isDraft=false){if(!editor)return;mute.current=true;loadCanvas(editor,doc);if(!isDraft)savedSnapshot.current=JSON.stringify(canvasDocument(editor));mute.current=false;setSelected(null)}
  async function guard(action:()=>Promise<void>){if(busy)return;setBusy(true);setError('');setNotice('');try{await action()}catch(e:any){setError(e.message)}finally{setBusy(false)}}
  async function save(){
    if(!editor)throw new Error('画布正在加载')
    const selectedView=editor.getSelected()?.getView();if(selectedView&&'disableEditing' in selectedView&&typeof selectedView.disableEditing==='function')await selectedView.disableEditing()
    const doc=canvasDocument(editor)
    if(!latest.current.dirty)return version
    const v=await websites.save(project.id,doc,version),p=await websites.select(project.id,v.id)
    savedSnapshot.current=JSON.stringify(doc)
    setProject(p);setVersion(v.id);latest.current.version=v.id
    const unchanged=JSON.stringify(canvasDocument(editor))===JSON.stringify(doc)
    if(unchanged){setDirty(false);latest.current.dirty=false;localStorage.removeItem(draftKey);setDraft(null)}else{persist()}
    setNotice('已保存一个新版本');return v.id
  }
  async function generate(local:boolean,creative=false){await guard(async()=>{
    const targetId=local?selected?.getId():undefined
    if(local&&!targetId)throw new Error('先点击画布中要修改的元素')
    if(!instruction.trim())throw new Error('请填写希望 AI 做的修改')
    const baseVersion=await save()
    const run=await websites.generate(project.id,{model:model.value,baseVersion,targetId,instruction,mode:creative?'creative':'edit'})
    setProject(p=>({...p,run}));setTab('ai');setNotice('任务已在后台开始，可继续查看页面')
  })}
  async function resume(){await guard(async()=>{const run=await websites.generate(project.id,{resume:true});setProject(p=>({...p,run}));setTab('ai');setNotice('从原任务检查点继续；采用前不会覆盖当前画布')})}
  async function adopt(v:WebsiteVersion){await guard(async()=>{
    if(latest.current.dirty)await save()
    const p=await websites.select(project.id,v.id);setProject(p);load(v.doc);setVersion(v.id);latest.current.version=v.id;latest.current.dirty=false;setDirty(false);setPreview(null);localStorage.removeItem(draftKey);setDraft(null);setNotice('已采用此版本；原版本仍可找回')
  })}
  const openCandidate=(id:string)=>{const v=project.versions.find(v=>v.id===id);if(v)setPreview({doc:v.doc,version:v})}
  const deviceButtons=()=> <div className="site-devices" aria-label="预览尺寸">{[['desktop',Monitor,'桌面'],['tablet',Tablet,'平板'],['mobile',Smartphone,'手机']].map(([id,Icon,label]:any)=><button key={id} className="site-icon" title={label} aria-label={label} aria-pressed={device===id} onClick={()=>{setDevice(id);editor?.setDevice(id)}}><Icon size={17}/></button>)}</div>
  return <section className={`site-workshop site-workspace ${full?'is-fullscreen':''}`}>
    <header className="site-toolbar"><button className="site-icon" aria-label="返回作品" onClick={()=>{persist();onBack()}}><ArrowLeft size={18}/></button><div className="site-work-title"><strong>{project.title}</strong><span>{dirty?'有未保存修改 · 本机草稿自动保留':'当前版本已保存'}</span></div><div className="site-toolbar-actions">
      <button className="site-icon" aria-label="撤销" disabled={!editor||busy} onClick={()=>editor?.UndoManager.undo()}><Undo2 size={17}/></button><button className="site-icon" aria-label="重做" disabled={!editor||busy} onClick={()=>editor?.UndoManager.redo()}><Redo2 size={17}/></button>
      {deviceButtons()}<button className="site-button" disabled={!editor} onClick={()=>editor&&setPreview({doc:canvasDocument(editor)})}><Eye size={16}/>预览</button>
      <button className="site-button site-primary" disabled={!editor||busy||!dirty} onClick={()=>guard(async()=>{await save()})}><Save size={16}/>保存版本</button>
      <button className="site-icon" aria-label={full?'退出全屏':'全屏编辑'} onClick={()=>setFull(!full)}>{full?<Minimize2 size={17}/>:<Maximize2 size={17}/>}</button>
    </div></header>
    {error&&<p className="site-notice" role="alert">{error}</p>}{notice&&<p className="site-notice" role="status">{notice}</p>}
    {draft&&<div className="site-draft"><span>找到本机未保存草稿（{new Date(draft.at).toLocaleString()}）</span><button className="site-button" disabled={!editor||busy} onClick={()=>{load(draft.doc,true);setVersion(draft.baseVersion);latest.current.version=draft.baseVersion;changed();setDraft(null);setNotice('草稿已恢复，请保存版本')}}>恢复草稿</button><button className="site-button" onClick={()=>{localStorage.removeItem(draftKey);setDraft(null)}}>放弃草稿</button></div>}
    <WebsiteRunPanel run={project.run} busy={busy} onResume={resume} onCancel={()=>guard(async()=>setProject(await websites.cancel(project.id)))} onCandidate={openCandidate}/>
    <div className="site-edit-layout"><div className="site-stage"><WebsiteCanvas initial={base.doc} onReady={ready} onChange={changed} onSelect={setSelected}/><p className="site-canvas-hint">双击文字编辑 · 点击元素调整 · 拖动区块排序</p></div>
      <aside className="site-sidebar"><div className="site-tabs" role="tablist">{[['edit','编辑'],['ai','AI 助手'],['versions','版本 / 交付']].map(([id,label])=><button role="tab" aria-selected={tab===id} className={tab===id?'active':''} key={id} onClick={()=>setTab(id)}>{label}{id==='ai'&&running?' · 执行中':''}</button>)}</div>
        {tab==='edit'&&<WebsiteInspector editor={editor} selected={selected} onError={setError}/>}
        {tab==='ai'&&<div className="site-ai"><h3>继续打磨这个网站</h3><p className="site-muted">当前选区：{selected?`${selected.getName()} · #${selected.getId()}`:'未选择'}</p><WorkshopModelPicker value={model.value} onChange={model.set} textModels={model.textModels}/><label>修改要求<textarea rows={5} maxLength={3000} value={instruction} onChange={e=>setInstruction(e.target.value)} placeholder="例如：把这一块改成双栏，左边保留标题，右边增加三条亮点"/></label><button className="site-button site-primary" disabled={!selected||busy||running||!model.value||!instruction.trim()} onClick={()=>generate(true)}>只改选中元素</button><button className="site-button" disabled={busy||running||!model.value||!editor||!instruction.trim()} onClick={()=>generate(false)}>保留风格，修改整页</button><button className="site-button" disabled={busy||running||!model.value||!editor||!instruction.trim()} onClick={()=>generate(false,true)}>重新创意设计</button><p className="site-muted">创意设计会重新构思布局与风格，分区生成。所有操作都会先保存当前修改；候选采用前不会覆盖画布。</p></div>}
        {tab==='versions'&&<div className="site-versions"><p className="site-kicker">版本与交付</p><div className="site-add-row"><button className="site-button" disabled={busy||!editor} onClick={()=>guard(async()=>{const id=await save();setNotice(await websites.download(project.id,id))})}><Download size={15}/>导出 HTML</button><button className="site-button" disabled={busy||!editor} onClick={()=>guard(async()=>{const id=await save(),r=await websites.share(project.id,id);setShare(r.url);setNotice(r.message)})}><Share2 size={15}/>生成分享链接</button></div>{share&&<label>公网分享链接<input readOnly value={share} onFocus={e=>e.currentTarget.select()}/><a className="site-button" href={share} target="_blank" rel="noopener noreferrer">打开分享页面 ↗</a></label>}<p className="site-muted">导出静态单页，可直接打开。发布会生成公网链接；图片外链需联网。</p>{[...project.versions].reverse().map(v=><button className="site-version" key={v.id} onClick={()=>setPreview({doc:v.doc,version:v})}><strong>{v.label}{v.id===version?' · 当前':''}</strong><span>{new Date(v.createdAt).toLocaleString()}</span>{v.model&&<small>实际模型：{v.model.provider}/{v.model.id}</small>}</button>)}</div>}
      </aside>
    </div>
    {preview&&<dialog ref={previewDialog} className="site-preview-modal" aria-label="页面预览" onCancel={()=>setPreview(null)}><header><strong>{preview.version?.label||'当前画布预览'}</strong>{deviceButtons()}{preview.version&&<button className="site-button site-primary" disabled={busy} onClick={()=>adopt(preview.version!)}>采用此版本</button>}<button autoFocus className="site-icon" aria-label="关闭预览" onClick={()=>setPreview(null)}><X size={20}/></button></header><div className="site-preview-stage"><iframe title="独立网页预览" sandbox="" srcDoc={previewDocument(preview.doc)} style={{width:device==='mobile'?390:device==='tablet'?768:'100%'}}/></div></dialog>}
  </section>
}
