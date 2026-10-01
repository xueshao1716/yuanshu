import { useEffect, useRef, useState } from 'react'
import { CultivationApi, type MediaDesign } from './api'
import type { Action } from './Authorization'
import { errorText } from '../shared'

export default function Media({agentId,kind,design,revision,authorized,onAction}:{agentId:string;kind:string;design:MediaDesign;revision:number;authorized:boolean;onAction:(a:Action)=>void}) {
  const [src,setSrc]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const generation=useRef(0)
  useEffect(()=>()=>{generation.current++},[])
  if(!design.asset)return null
  const asset=design.asset
  const preview=async()=>{
    if(busy)return
    const request=++generation.current;setBusy(true);setError('');setSrc('')
    try{const value=await CultivationApi.media(agentId,kind,asset)
      if(request===generation.current){
        const allowed=kind==='voice'?['audio/wav','audio/ogg','audio/mpeg']:['image/png','image/jpeg','image/webp']
        if(!allowed.includes(value.mime))throw new Error('媒体类型无法预览，请核对原始资产。')
        setSrc(`data:${value.mime};base64,${value.base64}`)
      }
    }catch(e){if(request===generation.current)setError(errorText(e))}finally{if(request===generation.current)setBusy(false)}
  }
  return <div className="cultivation-media">
    <div className="soul-actions"><button disabled={busy} onClick={()=>void preview()}>{busy?'正在读取…':src?'重新读取媒体':kind==='voice'?'载入声音预览':'载入图片预览'}</button>
      {src&&<button onClick={()=>setSrc('')}>关闭预览</button>}
      <button disabled={!authorized||busy} onClick={()=>onAction({method:'POST',path:'/assets/revoke',payload:{agentId,id:asset.id,version:asset.version},revision,label:'撤销该个体的媒体资产'})}>撤销媒体资产</button></div>
    {error&&<p role="alert">读取失败：{error}。可以重新读取，或核对资产是否已撤销。</p>}
    {src&&(kind==='voice'?<audio controls preload="none" src={src} aria-label={design.description}/>:<img src={src} alt={design.description}/>)}
  </div>
}
