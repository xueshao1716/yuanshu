import { useState } from 'react'
import useSWR from 'swr'
import { KnowledgeApi, knowledgePolling } from '../../knowledge/api'
import KnowledgePolicy from '../../knowledge/KnowledgePolicy'
import { LoadState } from '../shared'

export default function SharedResources({refresh}:{refresh:()=>Promise<unknown>}) {
  const [open,setOpen]=useState(false)
  const policy=useSWR(open?'knowledge-policy':null,KnowledgeApi.policy,knowledgePolling)
  return <details onToggle={e=>setOpen(e.currentTarget.open)}>
    <summary>共享模型与额度设置</summary>
    <p className="soul-hint">这里与知识页面是同一份设置，不是另一套授权。修改会同时影响知识与培养；仅展开不会改设置或调用模型。</p>
    {open&&<>
      <LoadState error={policy.error} loading={policy.isLoading} retry={()=>policy.mutate().catch(()=>undefined)}/>
      {policy.data&&<KnowledgePolicy policy={policy.data} refreshed={async()=>{await policy.mutate();await refresh()}}/>}
    </>}
  </details>
}
