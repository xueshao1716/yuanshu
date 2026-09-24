import {useEffect,useState} from 'react'
import type {WebsiteRun} from '../../lib/website-api'
export default function WebsiteRunPanel({run,onCancel,onCandidate}:{run?:WebsiteRun;onCancel:()=>void;onCandidate:(id:string)=>void}) {
  const [now,setNow]=useState(Date.now())
  useEffect(()=>{if(run?.status!=='running')return;const t=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(t)},[run?.status])
  if(!run)return null
  const running=run.status==='running'
  return <div className="site-run" role="status"><div className="site-section-title"><strong>{running?'AI 正在设计':run.status==='completed'?'候选版本已就绪':run.status==='cancelled'?'已停止':'本次生成未完成'}</strong>{running&&<span>{Math.max(0,Math.floor((now-Date.parse(run.startedAt))/1000))} 秒</span>}</div><p className="site-muted">请求模型：{run.requestedModel}</p><ol>{run.events.map((e,i)=><li key={i}><time>{new Date(e.at).toLocaleTimeString('zh-CN',{hour12:false})}</time>{e.message}</li>)}</ol>{run.error&&<p className="site-notice">{run.error}</p>}{running?<><p className="site-muted">后台继续执行，切换页面或手机锁屏不会主动取消。模型未返回前只能显示等待阶段。</p><button className="site-button" onClick={onCancel}>停止本次生成</button></>:run.resultVersion&&<button className="site-button site-primary" onClick={()=>onCandidate(run.resultVersion!)}>查看候选页面</button>}</div>
}
