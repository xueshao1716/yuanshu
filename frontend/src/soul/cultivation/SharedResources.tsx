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
    <p className="soul-hint">和知识页是同一份设置，改这里两边都生效。</p>
    {open&&<>
      <LoadState error={policy.error} loading={policy.isLoading} retry={()=>policy.mutate().catch(()=>undefined)}/>
      {policy.data&&<KnowledgePolicy policy={policy.data} refreshed={async()=>{await policy.mutate();await refresh()}}/>}
    </>}
  </details>
}
