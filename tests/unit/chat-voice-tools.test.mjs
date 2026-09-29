import test from 'node:test'
import assert from 'node:assert/strict'
const mod = await import('../../engine/chat-voice-tools.mjs').catch(e => { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; return {} })
function fixture(t, extra = {}) {
  assert.equal(typeof mod.createChatVoiceTools, 'function', 'main chat confirmation handler exists')
  const events = [], replies = [], submissions = []; let allowed = true
  const handler = mod.createChatVoiceTools({ conversationId: 'origin', callPrefix: 'ticket',
    runtime: { submit: async input => { submissions.push(input); return { id: 'group', tasks: input.tasks.map((v,i) => ({...v,id:'task'+i,status:'queued'})) } }, list: async () => [] },
    canAccess: () => allowed, emit: e => events.push(e), reply: (id, result) => replies.push({id,result}), ...extra })
  t.after(() => handler.close())
  return {handler,events,replies,submissions,deny:()=>{allowed=false}}
}
const call = (args = { tasks: [{ title: '报告', instruction: '生成报告' }] }) => ({call_id:'call1', name:'propose_tasks', arguments:JSON.stringify(args)})
test('model proposal cannot execute until explicit page confirmation; double confirmation is idempotent', async t => {
  const f=fixture(t); await f.handler.call(call()); assert.equal(f.submissions.length,0)
  const p=f.events.find(e=>e.type==='task.proposal'); assert.ok(p.id)
  await Promise.all([f.handler.confirm({id:p.id,approved:true}),f.handler.confirm({id:p.id,approved:true})])
  assert.equal(f.submissions.length,1); assert.equal(f.submissions[0].conversationId,'origin')
  assert.ok(f.events.some(e=>e.type==='task.receipt' && e.proposalId===p.id))
  await f.handler.confirm({id:p.id,approved:true}); assert.equal(f.submissions.length,1)
})
test('manual transcript uses same confirmation without fabricating provider outputs', async t => {
  const f=fixture(t); await f.handler.propose({requestId:'manual1',text:'做一份报告'})
  await f.handler.propose({requestId:'manual1',text:'做一份报告'})
  assert.equal(f.events.filter(e=>e.type==='task.proposal').length,2)
  const p=f.events[0]; await f.handler.confirm({id:p.id,approved:true})
  assert.equal(f.submissions.length,1); assert.equal(f.replies.length,0)
})
test('decline, expiry and disconnect do not execute pending proposals', async t => {
  const f=fixture(t,{confirmationMs:15}); await f.handler.call(call())
  await f.handler.confirm({id:f.events[0].id,approved:false})
  assert.ok(f.events.some(e=>e.type==='task.resolved'))
  await f.handler.propose({requestId:'expires',text:'任务'})
  await new Promise(r=>setTimeout(r,30)); assert.ok(f.events.some(e=>e.type==='task.expired'))
  await f.handler.propose({requestId:'closed',text:'任务'}); const id=f.events.at(-1).id
  f.handler.close(); await f.handler.confirm({id,approved:true}); assert.equal(f.submissions.length,0)
})
test('original session authorization is rechecked at confirmation', async t => {
  const f=fixture(t); await f.handler.call(call()); f.deny()
  await f.handler.confirm({id:f.events[0].id,approved:true})
  assert.equal(f.submissions.length,0); assert.ok(f.events.some(e=>e.type==='task.error'))
})
test('rejects provider permission overrides, unknown tools and malformed arguments', async t => {
  const f=fixture(t)
  for(const args of [{tasks:[{title:'x',instruction:'y'}],conversationId:'foreign'},{tasks:[{title:'x',instruction:'y'}],approved:true},{tasks:[{title:'x',instruction:'y',model:'x'}]}]) {
    await f.handler.call({...call(args),call_id:'c'+f.replies.length})
  }
  await f.handler.call({...call(),call_id:'shell',name:'shell'})
  assert.equal(f.events.filter(e=>e.type==='task.proposal').length,0); assert.equal(f.submissions.length,0)
  assert.ok(f.replies.every(r=>r.result.error))
})
test('supports bounded multi-task dependencies and status queries bound to origin', async t => {
  let queried
  const f=fixture(t,{runtime:{list:async id=>{queried=id;return [{id:'t',title:'x',status:'completed',delivery:{status:'delivered'}}]}}})
  await f.handler.call(call({tasks:[{title:'a',instruction:'a'},{title:'b',instruction:'b',dependsOn:[0]}]}))
  assert.deepEqual(f.events[0].tasks[1].dependsOn,[0])
  await f.handler.call({call_id:'list',name:'list_tasks',arguments:'{}'})
  assert.equal(queried,'origin'); assert.equal(f.replies.at(-1).result.tasks[0].delivery,'delivered')
})
test('hangup during accepted submission does not cancel or repeat durable work', async t => {
  let release,submitted=0
  const f=fixture(t,{runtime:{submit:async ()=>{submitted++;return new Promise(r=>{release=r})}}})
  await f.handler.call(call()); const p=f.events[0], pending=f.handler.confirm({id:p.id,approved:true})
  await f.handler.confirm({id:p.id,approved:true})
  assert.equal(f.events.at(-1).type,'task.submitting','repeat confirmation must never reopen a submitting proposal')
  f.handler.close(); release({id:'g',tasks:[]}); await pending
  assert.equal(submitted,1); assert.equal(f.events.filter(e=>e.type==='task.receipt').length,0)
})
