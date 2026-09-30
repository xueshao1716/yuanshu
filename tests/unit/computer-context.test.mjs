import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../../engine/gateway.mjs';
import { scheduleToolCalls } from '../../engine/tool-scheduler.mjs';
import { createUnifiedToolExecutor } from '../../engine/tools/unified-tools.mjs';
import { computerTool, COMPUTER_TOOL_SCHEMA } from '../../engine/computer-use/tools.mjs';
import { createComputerUse } from '../../engine/computer-use/controller.mjs';
import registry from '../../engine/tools/confirm-registry.mjs';

test('scheduler to desktop chain trusts host session, never model arguments, and carries cancellation', async t => {
  let observations = 0;
  const win = { handle:'fixture', pid:1, title:'Isolated test', process:'notepad' };
  const adapter = { supported:true, windows:async()=>[win],
    observe:async()=>{ observations++; return { window:win, elements:[{id:'field', name:'Body',type:'Edit',actions:['type']}] }; },
    act:async()=>assert.fail('cancelled operation must not reach native input') };
  const service = createComputerUse({adapter,registry,sessionExists:s=>s==='host-session'});
  const windows = await service.windows();
  await service.grant({windowId:windows[0].id,sessionId:'host-session'});
  const execute = createUnifiedToolExecutor({extraExecutors:{computer_use:(args,ctx)=>computerTool(service,args,ctx)}});
  const gateway = await createGateway({defaultExecutor:execute});
  gateway.tools.register({...COMPUTER_TOOL_SCHEMA.function, parallel:false, executor:(args,ctx)=>execute('computer_use',args,ctx)});
  t.after(async()=>{service.stop();registry.cancelAll('host-session');await gateway.dispose();});
  const run = async (args, sessionId, signal) => (await scheduleToolCalls({
    toolCalls:[{id:'fixture-call',function:{name:'computer_use',arguments:JSON.stringify(args)}}],
    tools:gateway.tools,executionContext:{sessionId},signal,
  }))[0].out;
  const forged = await run({action:'observe',sessionId:'host-session'},'other-session');
  assert.equal(forged.isError,true);
  assert.equal(observations,0);
  const missing = await run({action:'observe',sessionId:'host-session'});
  assert.equal(missing.isError,true);
  assert.equal(observations,0);
  const observed = await run({action:'observe',sessionId:'forged'},'host-session');
  assert.equal(observed.isError,undefined);
  assert.equal(observations,1);
  const seen = JSON.parse(observed.text);
  const abort = new AbortController();
  const job = run({action:'type',observationId:seen.observationId,elementId:'field',text:'test'},'host-session',abort.signal);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(registry.hasPending('host-session'),true);
  abort.abort();
  const cancelled = await job;
  assert.equal(cancelled.isError,true);
  assert.equal(registry.hasPending('host-session'),false);
  assert.equal(service.status().busy,false);
});
