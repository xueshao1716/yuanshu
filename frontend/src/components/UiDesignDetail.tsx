import { useEffect, useState } from 'react'
import { ModelsApi } from '../api'
import { designs, openDesign, type DesignProject } from '../lib/ui-design-api'
import { designButton, designField } from '../lib/ui-design-styles'

export default function UiDesignDetail({initial,onBack}:{initial:DesignProject;onBack:()=>void}) {
  const [p,setP]=useState(initial), [models,setModels]=useState<{key:string;name:string}[]>([])
  const [model,setModel]=useState(''), [group,setGroup]=useState(''), [instruction,setInstruction]=useState('')
  const [error,setError]=useState(''), [busy,setBusy]=useState(false)
  const running=p.run?.status==='running', selected=p.versions.find(v=>v.id===p.selectedVersion)
  useEffect(()=>{let cancelled=false;ModelsApi.list().then(data=>{
    if(cancelled) return
    const list=data.models.filter(m=>{const c=m.capabilities; const keys=Array.isArray(c)?c:Object.entries(c||{}).filter(([,v])=>v).map(([k])=>k);return !keys.includes('image')&&!keys.includes('video')}).map(m=>({key:`${m.provider}/${m.id}`,name:m.name||m.id}))
    setModels(list);const current=data.current?`${data.current.provider}/${data.current.id}`:''
    setModel(list.some(m=>m.key===current)?current:list[0]?.key||'')
  }).catch(e=>{if(!cancelled)setError(e.message)});return()=>{cancelled=true}},[])
  useEffect(()=>{
    if(!running)return
    let cancelled=false, timer: ReturnType<typeof setTimeout>
    const poll=async()=>{try{const next=await designs.get(p.id);if(!cancelled)setP(next)}catch(e:any){if(!cancelled)setError(e.message)}finally{if(!cancelled)timer=setTimeout(poll,2500)}}
    timer=setTimeout(poll,1000);return()=>{cancelled=true;clearTimeout(timer)}
  },[p.id,running])
  async function action(work:()=>Promise<unknown>) {setError('');setBusy(true);try{await work();setP(await designs.get(p.id))}catch(e:any){setError(e.message)}finally{setBusy(false)}}
  const blocked=busy||running
  return <div className="space-y-5">
    <button className={designButton} onClick={onBack}>返回作品列表</button>
    <div><h2 className="text-xl font-medium">{p.title}</h2><p className="mt-2 whitespace-pre-wrap text-sm text-pi-dim">{p.brief}</p>
      {p.references&&<details className="mt-3 text-sm"><summary className="cursor-pointer min-h-11">本作品参考</summary><p className="whitespace-pre-wrap">{p.references}</p></details>}</div>
    <div className="flex flex-wrap items-end gap-3">
      <label className="min-w-0 flex-1 space-y-1"><span className="text-sm">设计模型</span><select aria-label="设计模型" className={designField} value={model} onChange={e=>setModel(e.target.value)} disabled={blocked}>{!models.length&&<option value="">没有可用文本模型</option>}{models.map(m=><option key={m.key} value={m.key}>{m.name} · {m.key}</option>)}</select></label>
      <button className={designButton} disabled={blocked||!model} onClick={()=>action(()=>designs.generate(p.id,{model}))}>生成两个方向</button>
    </div>
    <p className="text-sm text-pi-dim">生成在服务器继续运行，离开页面后可回来查看。模型只使用本作品需求与参考。</p>
    {p.run&&<p role="status" className="text-sm">{running?'生成中':p.run.status==='completed'?'生成完成':p.run.status==='partial'?'部分完成':'生成未完成'} · {p.run.completed}/{p.run.total}{p.run.error&&` · ${p.run.error}`}</p>}
    {error&&<p role="alert" className="text-sm">{error}</p>}
    <div className="grid gap-3 sm:grid-cols-2">
      {p.versions.map((v,i)=><article key={v.id} className={`min-w-0 rounded-pi-lg border p-4 ${p.selectedVersion===v.id?'border-pi-accent bg-pi-bg2':'border-pi-border-soft'}`}>
        <h3 className="font-medium">V{i+1} · {v.label}{p.selectedVersion===v.id?' · 当前选用':''}</h3>
        <p className="mt-2 break-words text-xs text-pi-dim">{new Date(v.createdAt).toLocaleString()} · {v.doc.frames.length} 屏 · {v.doc.groups.length} 组</p>
        <p className="mt-1 break-words text-xs text-pi-dim">{v.model?`实际模型：${v.model.provider}/${v.model.id}`:'手动画布保存'} · 结构检查通过，视觉效果请预览确认</p>
        <div className="mt-3 flex flex-wrap gap-2"><button className={designButton} onClick={()=>{try{openDesign(p,v)}catch(e:any){setError(e.message)}}}>打开画布 / 预览</button><button className={designButton} disabled={blocked||p.selectedVersion===v.id} onClick={()=>action(async()=>{await designs.select(p.id,v.id);setGroup('')})}>选用此版</button></div>
      </article>)}
    </div>
    {!p.versions.length&&<p className="text-sm text-pi-dim">先生成两个方向，再打开画布调整；每次保存都会保留一个新版本。</p>}
    {selected&&<form className="space-y-3 rounded-pi-lg border border-pi-border-soft p-4" onSubmit={e=>{e.preventDefault();action(()=>designs.generate(p.id,{model,baseVersion:selected.id,groupId:group,instruction}))}}>
      <h3 className="font-medium">只改当前版本的一组组件</h3>
      <label className="block space-y-1"><span className="text-sm">要修改的组件组</span><select className={designField} required value={group} onChange={e=>setGroup(e.target.value)}><option value="">请选择组件组</option>{selected.doc.groups.map(g=><option key={g.id} value={g.id}>{g.items.map(i=>i.label).filter(Boolean).join(' · ').slice(0,80)||g.id}（{g.id}）</option>)}</select></label>
      <label className="block space-y-1"><span className="text-sm">修改要求</span><textarea className={designField} required rows={3} maxLength={3000} value={instruction} onChange={e=>setInstruction(e.target.value)} placeholder="例如：把报名按钮改为描边，文字改成预约体验" /></label>
      <p className="text-xs text-pi-dim">其他组件组、屏幕和主题保持不变。结果另存为候选版本，不覆盖当前版本。</p>
      <button className={designButton} disabled={blocked||!group||!model}>生成局部修改版</button>
    </form>}
  </div>
}
