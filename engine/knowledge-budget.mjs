import {randomUUID} from 'node:crypto';
import {knowledgeStorage} from './knowledge-storage.mjs';
import {fail} from './knowledge-state.mjs';

// UTC high-water and reservations survive crashes. Unknown usage never refunds.
export function createKnowledgeBudget({wsRoot,now=Date.now}) {
  const io=knowledgeStorage(wsRoot);
  const read=()=>{
    const data=io.read('budget.json',{v:1,day:'',reservations:[]});
    if(data.v!==1||!Array.isArray(data.reservations)||typeof data.day!=='string')fail('budget_unreadable');
    for(const r of data.reservations)if(!r.id||!Number.isFinite(r.reserved)||r.reserved<0||!['model','network'].includes(r.kind)||
      r.cost!==null&&(!Number.isFinite(r.cost)||r.cost<0)||!['knowledge','cultivation'].includes(r.consumer??'knowledge')||
      typeof r.day!=='string'||typeof r.currency!=='string'||typeof r.unknown!=='boolean')fail('budget_unreadable');
    return data;
  };
  const dayOf=data=>[data.day,new Date(now()).toISOString().slice(0,10)].sort().at(-1);
  const summarize=(data,currency)=>{
    const day=dayOf(data),rows=data.reservations.filter(r=>r.day===day||r.cost===null),money=rows.filter(r=>r.currency===currency);
    const reserved=money.filter(r=>r.cost===null).reduce((n,r)=>n+r.reserved,0);
    const spent=money.filter(r=>r.cost!==null).reduce((n,r)=>n+r.cost,0);
    return {day,currency,reserved,spent,unknown:rows.filter(r=>r.unknown).length,
      modelRequests:rows.filter(r=>r.day===day&&r.kind==='model').length,networkRequests:rows.filter(r=>r.day===day&&r.kind==='network').length};
  };
  return {
    async status(){return summarize(read(),io.readState().policy.currency);},
    reserve:({kind,policy,maxCost,currency,free=false,consumer='knowledge',limits})=>io.transaction(state=>{
      const p=state.policy;
      if(p.revision!==policy?.revision||p.paused||!p.localEnabled)fail('policy_changed');
      if(!['model','network'].includes(kind))fail('invalid_budget');
      if(!['knowledge','cultivation'].includes(consumer)||consumer==='cultivation'&&
        (kind!=='model'||!limits||!Number.isSafeInteger(limits.dailyRequests)||limits.dailyRequests<0||limits.dailyRequests>1000||
         !Number.isSafeInteger(limits.dailyBudgetCents)||limits.dailyBudgetCents<0||limits.dailyBudgetCents>1000000||currency!=='USD'))fail('invalid_budget');
      if(kind==='model'&&!p.remoteEnabled||kind==='network'&&!p.networkEnabled)fail('source_not_authorized');
      if(!Number.isFinite(maxCost)||maxCost<0||maxCost===0&&!free)fail('price_unknown');
      if(currency!==p.currency)fail('currency_mismatch');
      const data=read(),status=summarize(data,currency);
      if(status[kind==='model'?'modelRequests':'networkRequests']>=p[kind==='model'?'maxModelRequests':'maxNetworkRequests'])fail('request_limit');
      const reserved=Math.ceil(maxCost*1e9)/1e9;
      if(Math.ceil((status.spent+status.reserved+reserved)*1e9)>Math.floor(p.dailyCost*1e9))fail('budget_exhausted');
      if(consumer==='cultivation'){
        const rows=data.reservations.filter(r=>r.consumer==='cultivation');
        if(rows.filter(r=>r.day===status.day).length>=limits.dailyRequests)fail('cultivation_request_limit');
        const held=rows.filter(r=>r.currency===currency&&(r.day===status.day||r.cost===null))
          .reduce((sum,r)=>sum+(r.cost??r.reserved),0);
        if(Math.ceil((held+reserved)*1e9)>limits.dailyBudgetCents*1e7)fail('cultivation_budget_exhausted');
      }
      if(data.reservations.length>=10000)fail('budget_storage_full');
      const row={id:randomUUID(),day:status.day,kind,consumer,currency,reserved,cost:null,unknown:true,settled:false,at:now()};
      data.day=status.day;data.reservations.push(row);io.write('budget.json',data);return row;
    }),
    settle:(id,usage)=>io.transaction(()=>{
      const data=read(),row=data.reservations.find(r=>r.id===id);if(!row)fail('reservation_not_found');
      if(row.settled)return row;
      if(usage&&usage.currency===row.currency&&Number.isFinite(usage.cost)&&usage.cost>=0){
        row.cost=Math.ceil(usage.cost*1e9)/1e9;row.unknown=false;
      }
      row.settled=true;io.write('budget.json',data);return row;
    }),
  };
}
