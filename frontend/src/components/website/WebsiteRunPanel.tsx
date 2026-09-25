import {useEffect,useState} from 'react'
import type {WebsiteRun} from '../../lib/website-api'
export default function WebsiteRunPanel({run,onCancel,onCandidate,onResume,busy}:{run?:WebsiteRun;onCancel:()=>void;onCandidate:(id:string)=>void;onResume:()=>void;busy:boolean}) {
  const [now,setNow]=useState(Date.now())
  useEffect(()=>{if(run?.status!=='running')return;const t=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(t)},[run?.status])
  if(!run)return null
  const running=run.status==='running'
  return <div className="site-run">
    <div className="site-section-title"><strong role="status">{running?'AI 正在设计':run.status==='completed'?'候选版本已就绪':run.status==='cancelled'?'已停止':'本次生成未完成'}</strong>{running&&<span>{Math.max(0,Math.floor((now-Date.parse(run.startedAt))/1000))} 秒</span>}</div>
    <p className="site-muted">请求模型：{run.requestedModel} · 本次响应模型：{run.actualModel||'尚未确认'}</p>
    {run.lastSuccessfulModel&&<p className="site-muted">最近成功模型：{run.lastSuccessfulModel}（历史记录）</p>}
    {run.progress&&<p role="status">{run.progress.phase==='thinking'?'模型正在思考':run.progress.phase==='output'?'正在接收页面内容':'等待模型返回'} · 已接收正文 {run.progress.characters} 字符{run.progress.thinkingCharacters>0&&<> · 思考 {run.progress.thinkingCharacters} 字符</>}</p>}
    {run.checkpoint?.plan&&<p>已保存 {run.checkpoint.sections.length} / {run.checkpoint.plan.sections.length} 个区块</p>}
    <ol aria-label="设计进度">{run.events.slice(-6).map((e,i)=><li key={i}><time>{new Date(e.at).toLocaleTimeString('zh-CN',{hour12:false})}</time>{e.message}</li>)}</ol>
    {run.error&&<p className="site-notice" role="alert">{run.error}</p>}
    {running?<><p className="site-muted">任务在服务端执行，离开页面不会主动取消。流式通道 90 秒无新内容才停止；单次调用最多 5 分钟，整轮最多 15 分钟。非流式通道等待整包返回。中断片段会保留，完成校验前不会替换画布。</p><button className="site-button" disabled={busy} onClick={onCancel}>停止本次生成</button></>:run.resultVersion?<button className="site-button site-primary" onClick={()=>onCandidate(run.resultVersion!)}>查看候选页面</button>:run.checkpoint&&<button className="site-button site-primary" disabled={busy} onClick={onResume}>继续本次任务</button>}
  </div>
}
