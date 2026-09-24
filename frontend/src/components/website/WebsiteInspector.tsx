import {useEffect,useState} from 'react'
import type {Component,Editor} from 'grapesjs'
import {Copy,Trash2,ArrowUp,Plus} from 'lucide-react'
const textEscape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
const safeLink=(s:string)=>!s||/^(https:\/\/|#[\w-]+$|mailto:|tel:)/i.test(s)
export default function WebsiteInspector({editor,selected,onError}:{editor:Editor|null;selected:Component|null;onError:(s:string)=>void}) {
  const [,render]=useState(0),[source,setSource]=useState(''),[href,setHref]=useState('')
  useEffect(()=>{
    if(!selected)return
    const refresh=()=>{setSource(selected.getAttributes().src||'');setHref(selected.getAttributes().href||'');render(x=>x+1)}
    refresh();selected.on('change',refresh);return()=>{selected.off('change',refresh)}
  },[selected])
  function add(kind:string){
    if(!editor)return
    const content:Record<string,string>={text:'<p style="font-size:20px;line-height:1.8;padding:20px">双击修改这段文字。</p>',section:'<section style="padding:60px 6%;background-color:#ece9df;color:#292e26"><h2>新的篇章</h2><p>在这里继续你的故事。</p></section>',link:'<a href="#hero" style="display:inline-block;padding:16px 24px;border:1px solid currentColor;border-radius:30px">了解更多 ↗</a>',image:'<img src="https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=1000&q=80" alt="山峦" style="width:100%;height:320px;object-fit:cover"/>'}
    const parent=selected?.parent()||editor.getWrapper();if(!parent)return
    const added=parent.append(content[kind],selected?{at:selected.index()+1}:{})[0];if(added)editor.select(added)
  }
  const style=(key:string,value:string)=>{if(/[<>;{}\\]|url\s*\(/i.test(value)){onError('请填写单个样式值，不要粘贴代码');return}selected?.addStyle({[key]:value})}
  const input=(label:string,key:string,placeholder:string)=><label key={key}>{label}<input key={`${selected?.getId()}-${key}-${selected?.getStyle()[key]}`} defaultValue={String(selected?.getStyle()[key]||'')} placeholder={placeholder} onBlur={e=>style(key,e.target.value)} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur()}}/></label>
  return <div className="site-inspector"><p className="site-kicker">直接编辑</p>
    <div className="site-add-row">{[['section','区块'],['text','文字'],['image','图片'],['link','链接']].map(([key,label])=><button className="site-button" key={key} disabled={!editor} onClick={()=>add(key)}><Plus size={13}/>{label}</button>)}</div>
    {!selected?<p className="site-muted site-empty-selection">点击画布中的元素开始编辑。双击文字可原位输入；选中区块后可拖动它的位置。</p>:<>
      <div className="site-selection"><strong>{selected.getName()}</strong><span>#{selected.getId()}</span></div>
      <div className="site-add-row"><button className="site-button" onClick={()=>{const p=selected.parent();if(p&&p!==editor?.getWrapper())editor?.select(p)}}><ArrowUp size={14}/>选上层</button><button className="site-button" onClick={()=>{const clone=selected.clone();selected.parent()?.append(clone,{at:selected.index()+1});editor?.select(clone)}}><Copy size={14}/>复制</button><button className="site-button" onClick={()=>selected.remove()}><Trash2 size={14}/>删除</button></div>
      {!selected.is('image')&&(selected.components().length===0||selected.components().every(c=>c.is('textnode')))&&<label>文字内容<textarea key={selected.getId()+selected.get('content')} defaultValue={selected.getEl()?.textContent||''} rows={3} onBlur={e=>selected.components(textEscape(e.target.value))}/></label>}
      {selected.is('image')&&<><label>图片地址（HTTPS）<input value={source} onChange={e=>setSource(e.target.value)} onBlur={()=>{if(/^https:\/\//i.test(source))selected.addAttributes({src:source});else onError('图片地址需要以 https:// 开头')}}/></label><label>替换本机图片<input type="file" accept="image/png,image/jpeg,image/webp" onChange={e=>{const file=e.target.files?.[0];if(!file)return;if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>350000){onError('请选择小于 350KB 的 PNG、JPEG 或 WebP 图片；大图可用 HTTPS 地址');return}const target=selected,reader=new FileReader();reader.onload=()=>target.addAttributes({src:String(reader.result)});reader.onerror=()=>onError('图片读取失败');reader.readAsDataURL(file);e.target.value=''}}/></label><label>图片说明<input key={selected.getId()} defaultValue={selected.getAttributes().alt||''} onBlur={e=>selected.addAttributes({alt:e.target.value})}/></label></>}
      {selected.get('tagName')==='a'&&<label>跳转链接<input value={href} onChange={e=>setHref(e.target.value)} onBlur={()=>{if(safeLink(href))selected.addAttributes({href});else onError('链接请使用 HTTPS、锚点、邮箱或电话')}}/></label>}
      <div className="site-property-grid">{input('文字颜色','color','#ffffff')}{input('背景颜色','background-color','#172013')}{input('字号','font-size','48px')}{input('行高','line-height','1.4')}{input('内边距','padding','24px')}{input('外边距','margin','0')}{input('宽度','width','100%')}{input('最小高度','min-height','200px')}{input('圆角','border-radius','16px')}{input('元素间距','gap','24px')}</div>
      <label>布局<select value={String(selected.getStyle().display||'')} onChange={e=>style('display',e.target.value)}><option value="">跟随原样式</option><option value="block">纵向区块</option><option value="flex">弹性排列</option><option value="grid">网格</option></select></label>
      <label>对齐<select value={String(selected.getStyle()['text-align']||'')} onChange={e=>style('text-align',e.target.value)}><option value="">跟随原样式</option><option value="left">居左</option><option value="center">居中</option><option value="right">居右</option></select></label>
    </>}
  </div>
}
