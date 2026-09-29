import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
const mod=await import('../../frontend/src/realtime/task-state.mjs').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND') throw e;return {}})
test('task UI keeps batched proposals, never reopens submitting or accepted cards, and clears pending on hangup',()=>{
  assert.equal(typeof mod.reduceTaskState,'function')
  let s=mod.emptyTaskState()
  const event={type:'task.proposal',id:'p1',tasks:[{title:'报告',instruction:'生成报告'}]}
  s=mod.reduceTaskState(s,event); s=mod.reduceTaskState(s,{...event,id:'p2'})
  assert.equal(s.proposals.length,2)
  s=mod.reduceTaskState(s,{type:'task.submitting',id:'p1'})
  s=mod.reduceTaskState(s,event); assert.equal(s.proposals[0].status,'submitting')
  s=mod.reduceTaskState(s,{type:'task.receipt',proposalId:'p1',result:{tasks:[{id:'t1'}]}})
  s=mod.reduceTaskState(s,event); assert.equal(s.proposals[0].status,'accepted')
  s=mod.reduceTaskState(s,{type:'task.disconnected'})
  assert.equal(s.proposals[0].status,'accepted'); assert.equal(s.proposals[1].status,'closed')
  assert.ok(mod.taskStatusText({status:'completed',delivery:{status:'pending'}}).includes('回写'))
  assert.ok(!mod.taskStatusText({status:'completed'}).includes('验收通过'))
})
test('task controls provide editable transcript, confirmation and persistent authenticated list without autosubmit',()=>{
  const source=fs.readFileSync(new URL('../../frontend/src/components/RealtimeCall.tsx',import.meta.url),'utf8')
  assert.ok(source.includes('RealtimeTasks'),'real task panel must be mounted')
  assert.ok(!source.includes('仅聊天，不执行电脑任务'))
  assert.ok(fs.readFileSync(new URL('../../frontend/src/components/CallScreen.tsx',import.meta.url),'utf8').includes('交给元枢'))
  const panel=fs.readFileSync(new URL('../../frontend/src/components/RealtimeTasks.tsx',import.meta.url),'utf8')
  for(const text of ['确认执行','不执行','刷新任务','停止任务','textarea','maxLength={12000}','touch-hit','aria-live']) assert.ok(panel.includes(text),text)
  const api=fs.readFileSync(new URL('../../frontend/src/realtime/tasks.ts',import.meta.url),'utf8')
  assert.ok(api.includes('Authorization')); assert.ok(api.includes("cache: 'no-store'")); assert.ok(!api.includes('?token='))
})

test('recent history never hides pending confirmations or tasks still eligible to stop',()=>{
  assert.equal(typeof mod.visibleProposals,'function')
  assert.equal(typeof mod.visibleTasks,'function')
  const proposals=[{id:'pending',status:'pending'},{id:'submitting',status:'submitting'},...Array.from({length:10},(_,i)=>({id:'p'+i,status:'declined'}))]
  const visible=mod.visibleProposals(proposals)
  assert.ok(visible.some(p=>p.id==='pending'));assert.ok(visible.some(p=>p.id==='submitting'))
  assert.ok(visible.length<=8)
  const tasks=[{id:'running',status:'running'},...Array.from({length:25},(_,i)=>({id:'t'+i,status:'completed'}))]
  assert.ok(mod.visibleTasks(tasks).some(t=>t.id==='running'))
  const panel=fs.readFileSync(new URL('../../frontend/src/components/RealtimeTasks.tsx',import.meta.url),'utf8')
  assert.ok(panel.includes('visibleProposals(proposals)'));assert.ok(panel.includes('visibleTasks(tasks)'))
})
