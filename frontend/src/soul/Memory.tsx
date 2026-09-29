import { useState } from 'react'
import useSWR from 'swr'
import { MemoryApi, RecallApi } from '../api'
import { Block, date, errorText, LoadState } from './shared'
export default function Memory() {
  const stats = useSWR('soul-recall', RecallApi.stats), snapshots = useSWR('soul-memory-snapshots', MemoryApi.snapshots)
  const [query,setQuery] = useState(''), [result,setResult] = useState<Awaited<ReturnType<typeof RecallApi.search>> | null>(null)
  const [busy,setBusy] = useState(false), [error,setError] = useState('')
  const search = async () => {if(!query.trim()) return; setBusy(true); setError(''); setResult(null); try{setResult(await RecallApi.search(query.trim()))} catch(e){setError(errorText(e))} finally{setBusy(false)}}
  return <>
    <Block title="记忆与关系" hint="关系称呼、定位和边界在人格定义中维护；这里查看实际回忆索引与快照，不把索引数量当作关系亲密度。">
      <LoadState error={stats.error} loading={stats.isLoading} retry={stats.mutate} />
      {stats.data && <dl className="soul-facts"><div><dt>已索引会话</dt><dd>{stats.data.sessions}</dd></div><div><dt>回忆片段</dt><dd>{stats.data.snippets}</dd></div><div><dt>最近重建</dt><dd>{date(stats.data.lastRebuild)}</dd></div></dl>}
      <form onSubmit={e => {e.preventDefault(); void search()}}><label className="soul-field">搜索已有回忆<input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="名字、经历或约定" /></label><button disabled={busy || !query.trim()}>{busy ? '搜索中…' : '检索回忆'}</button></form>
      {error && <p role="alert">{error}</p>}
      {result && <p>找到 {result.total} 条结果，展示前 {Math.min(result.hits.length,20)} 条。</p>}
      {result?.hits.slice(0,20).map((hit,i) => <article className="soul-record" key={i}><h4>{String(hit.name || '未命名会话')}</h4><p><small>{hit.role === 'user' ? '你的消息' : hit.role === 'assistant' ? '助手回复' : '回忆片段'} · {date(hit.ts)}</small></p><p className="soul-preserve">{String(hit.text || '片段没有可显示的正文')}</p><details><summary>来源详情</summary><pre>{JSON.stringify(hit,null,2)}</pre></details></article>)}
      <a href="#/sessiondb">进入会话库核对原始上下文</a>
    </Block>
    <Block title="记忆快照" hint="快照只证明当时保存过内容，不代表全部记忆都正确。恢复操作仍在原管理流程中进行。">
      <LoadState error={snapshots.error} loading={snapshots.isLoading} retry={snapshots.mutate} />
      {snapshots.data?.total === 0 && <p>没有可读取的记忆快照。</p>}
      {snapshots.data?.items.slice(0,10).map(s => <div className="soul-record" key={s.id}><h4>{s.reason || '未记录原因'}</h4><p>{date(s.timestamp)} · {Math.round(s.bytes/1024)} KB</p></div>)}
      <a href="#/board">到工作台查看记忆维护与恢复</a>
    </Block>
  </>
}
