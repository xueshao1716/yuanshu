import {knowledgeStorage} from './knowledge-storage.mjs';
import {digest,fail} from './knowledge-state.mjs';
import {modelOnly} from './knowledge-quality.mjs';

// All maintenance stays off the chat/GET path. Cursor and UTC high-water survive restarts.
export function createKnowledgeMaintenance({wsRoot,store,budget,collect,now=Date.now}){
  const io=knowledgeStorage(wsRoot);
  async function reconcile({signal,foregroundBusy=()=>false}={}){
    const policy=await store.policy();if(policy.paused||!policy.localEnabled)return;
    const day=(await budget.status()).day;
    const state=io.read('maintenance.json',{day,offset:0});
    if(day>state.day)await store.wakeBlocked(['budget_exhausted','request_limit']);
    const entries=await store.entries({offset:state.offset,limit:20});
    for(const entry of entries){
      await new Promise(resolve=>setImmediate(resolve));
      signal?.throwIfAborted();
      if(foregroundBusy())fail('foreground_busy');
      if(!['active','source_changed','expired','source_missing'].includes(entry.status)||entry.replacementJobId)continue;
      // A method must keep its explicit manifest/run binding; never renew it as a plain excerpt.
      if(entry.kind==='method'){if(entry.expiresAt<=now())await store.invalidateEntry(entry.id,'expired');continue;}
      // Re-reading the identical assistant output is not new evidence of current state.
      if(modelOnly(entry)&&entry.expiresAt<=now()){await store.invalidateEntry(entry.id,'expired');continue;}
      const remote=entry.sources.every(s=>s.reference.kind==='url');
      const expired=entry.expiresAt<=now()||remote&&entry.sources.some(s=>now()-s.fetchedAt>=86400000);
      if(remote&&!expired)continue;
      const sources=entry.sources.map(s=>{const {hash,...ref}=s.reference;return ref;});
      let snapshots;
      try{snapshots=await collect({job:{sources},policy,signal});}
      catch(e){if(e.name==='AbortError')throw e;if(e.code==='source_missing')await store.invalidateEntry(entry.id,'source_missing');continue;}
      const sourceVersion=digest(snapshots.map(s=>[s.locator,s.hash]));
      const unchanged=snapshots.length===entry.sources.length&&snapshots.every(s=>entry.sources.some(e=>e.locator===s.locator&&e.hash===s.hash));
      if(unchanged&&!expired&&entry.status==='active')continue;
      await store.invalidateEntry(entry.id,expired?'expired':'source_changed');
      const parent=await store.get(entry.jobId);
      const job=await store.enqueue({sourceId:`review:${entry.jobId}`,sourceVersion,event:'review',
        sources:snapshots.map(s=>s.reference),sessionId:parent.sessionId,runId:parent.runId,parentRunId:parent.runId,title:'来源更新与到期复核'});
      await store.linkReplacement(entry.id,job.id);
      await new Promise(resolve=>setImmediate(resolve));
    }
    await io.transaction(()=>io.write('maintenance.json',{day:[state.day,day].sort().at(-1),offset:entries.length===20?state.offset+20:0}));
  }
  return {reconcile};
}

export function knowledgePolicyWakeReasons(previous,current){
  const reasons=new Set();
  const groups=[
    [['allowedRoots','localEnabled'],['source_not_authorized']],
    [['allowedUrls','networkEnabled'],['network_disabled','url_not_authorized']],
    [['remoteEnabled'],['remote_disabled']], [['outboundRoots'],['outbound_denied']],
    [['model','allowedModels'],['model_not_authorized']], [['rates'],['price_unknown','token_bound_unknown']],
    [['currency','rates'],['currency_mismatch']], [['dailyCost','currency'],['budget_exhausted']],
    [['maxModelRequests','maxNetworkRequests'],['request_limit']],
  ];
  for(const [keys,values] of groups)if(keys.some(k=>digest(previous[k])!==digest(current[k])))for(const value of values)reasons.add(value);
  return [...reasons];
}
