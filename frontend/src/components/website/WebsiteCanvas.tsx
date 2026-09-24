import {useEffect, useRef} from 'react'
import grapesjs, {type Editor, type Component} from 'grapesjs'
import 'grapesjs/dist/css/grapes.min.css'
import type {WebsiteDoc} from '../../lib/website-api'

export const canvasDocument=(editor:Editor):WebsiteDoc=>({html:editor.getHtml(),css:editor.getCss()||''})
export function loadCanvas(editor:Editor,doc:WebsiteDoc) {
  editor.select();editor.setComponents(doc.html);editor.setStyle(doc.css);editor.UndoManager.clear();editor.clearDirtyCount()
}
export default function WebsiteCanvas({initial,onReady,onChange,onSelect}:{initial:WebsiteDoc;onReady:(e:Editor)=>void;onChange:()=>void;onSelect:(c:Component|null)=>void}) {
  const host=useRef<HTMLDivElement>(null),callbacks=useRef({onReady,onChange,onSelect})
  callbacks.current={onReady,onChange,onSelect}
  useEffect(()=>{
    const editor=grapesjs.init({
      container:host.current!,height:'100%',width:'auto',storageManager: false,noticeOnUnload:false,
      panels:{defaults:[]},devicePreviewMode:true,selectorManager:{componentFirst:true},
      parser: {optionsHtml:{allowScripts: false,allowUnsafeAttr: false,allowUnsafeAttrValue:false}},
      assetManager:{upload:false,assets:[]},
      canvas:{allowExternalDrop:false,frameContent:`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; img-src https: data:; media-src https:; style-src 'unsafe-inline'; font-src https:; base-uri 'none'; form-action 'none'"></head><body></body></html>`},
      deviceManager:{devices:[{id:'desktop',name:'桌面',width:''},{id:'tablet',name:'平板',width:'768px'},{id:'mobile',name:'手机',width:'390px'}]},
      components:initial.html,style:initial.css,
    })
    editor.on('load',()=>{
      const frame=editor.Canvas.getFrameEl();frame.title='网站编辑画布';frame.setAttribute('sandbox','allow-same-origin')
      editor.UndoManager.clear();callbacks.current.onReady(editor)
      editor.on('update',()=>callbacks.current.onChange())
    })
    editor.on('component:selected',(c:Component)=>{
      if(c===editor.getWrapper()){callbacks.current.onSelect(null);return}
      if(!c.getAttributes().id)c.addAttributes({id:c.getId()})
      callbacks.current.onSelect(c)
    })
    editor.on('component:deselected',()=>callbacks.current.onSelect(null))
    // A pasted drop is never interpreted as an executable component.
    editor.on('component:add',(c:Component)=>{c.set('script','');c.set('script-export','')})
    return()=>{editor.destroy()}
  },[])
  return <div ref={host} className="site-canvas"/>
}
