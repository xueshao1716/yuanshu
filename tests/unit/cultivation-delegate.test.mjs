import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {delegateToCultivatedAgent} from '../../engine/cultivation/delegate.mjs';

const AGENT='11111111-1111-4111-8111-111111111111';
function fakeRuntime({status='completed',verification={verdict:'pass',gaps:[]},output='结论正文',submitError=null}={}){
  const calls=[];let ticks=0;
  return {calls,get ticks(){return ticks;},
    list:c=>c==='agents'?{revision:7,items:[{id:AGENT,designId:'d1',status:'ready'},{id:'x',designId:'d1',status:'paused'}]}
      :{revision:7,items:[{id:'d1',design:{name:'小秤'}}]},
    async execute(command,kind,source){calls.push({command,kind,source});if(submitError)throw new Error(submitError);return {result:{id:'run-1'}};},
    tick(){ticks++;return Promise.resolve();},
    runView:()=>({status,reason:status==='failed'?'cultivation_provider_format':null,output,verification,agentId:AGENT})};
}
const host={executionIdentity:{},signal:undefined};
const fast={waitMs:50,pollMs:1};

test('delegate_task with agent_id submits through run.submit as mother and returns output with the independent verdict', async () => {
  const rt=fakeRuntime();
  const r=await delegateToCultivatedAgent(rt,{task:'写探店文案',agent_id:AGENT,context:['面向年轻人'],criterion:'10 条断言分级'},host,fast);
  assert.equal(r.isError,false);
  assert.match(r.text,/小秤/);assert.match(r.text,/结论正文/);assert.match(r.text,/独立验证：通过/);
  const {command,kind,source}=rt.calls[0];
  assert.equal(kind,'mother');assert.equal(source,host.executionIdentity);
  assert.equal(command.action,'run.submit');assert.equal(command.expectedRevision,7);
  assert.deepEqual(Object.keys(command.payload).sort(),['agentId','criterion','goal','input']);
  assert.match(command.payload.input,/面向年轻人/);assert.equal(command.payload.criterion,'10 条断言分级');
});

test('without a mother execution identity nothing is submitted', async () => {
  const rt=fakeRuntime();
  const r=await delegateToCultivatedAgent(rt,{task:'t',agent_id:AGENT},{},fast);
  assert.equal(r.isError,true);assert.equal(rt.calls.length,0);
});

test('unknown or paused agents list the callable ones instead of submitting', async () => {
  const rt=fakeRuntime();
  const r=await delegateToCultivatedAgent(rt,{task:'t',agent_id:'x'},host,fast);
  assert.equal(r.isError,true);assert.match(r.text,/小秤（11111111/);assert.equal(rt.calls.length,0);
});

test('oversized input is refused, not silently truncated', async () => {
  const rt=fakeRuntime();
  const r=await delegateToCultivatedAgent(rt,{task:'x'.repeat(4001),agent_id:AGENT},host,fast);
  assert.equal(r.isError,true);assert.match(r.text,/4000/);assert.equal(rt.calls.length,0);
});

test('failed, unverified and still-running outcomes are reported honestly', async () => {
  const failed=await delegateToCultivatedAgent(fakeRuntime({status:'failed',output:null,verification:null}),{task:'t',agent_id:AGENT},host,fast);
  assert.equal(failed.isError,true);assert.match(failed.text,/cultivation_provider_format/);
  const partial=await delegateToCultivatedAgent(fakeRuntime({verification:{verdict:'partial',gaps:['缺来源']}}),{task:'t',agent_id:AGENT},host,fast);
  assert.match(partial.text,/部分满足/);assert.match(partial.text,/缺来源/);assert.match(partial.text,/不会登记为经验/);
  const running=await delegateToCultivatedAgent(fakeRuntime({status:'running',output:null,verification:null}),{task:'t',agent_id:AGENT},host,fast);
  assert.equal(running.isError,false);assert.match(running.text,/等不到结果/);
  const pendingVerify=await delegateToCultivatedAgent(fakeRuntime({verification:null}),{task:'t',agent_id:AGENT},host,fast);
  assert.match(pendingVerify.text,/验证中/);
});

test('submit denials surface the cultivation reason code', async () => {
  const r=await delegateToCultivatedAgent(fakeRuntime({submitError:'cultivation_policy_disabled'}),{task:'t',agent_id:AGENT},host,fast);
  assert.equal(r.isError,true);assert.equal(r.text,'cultivation_policy_disabled');
});

test('wiring: schema exposes agent_id and server routes it to the cultivation path without touching dispatchAllowed', () => {
  const del=fs.readFileSync(new URL('../../engine/yuanshu-delegate.mjs',import.meta.url),'utf8');
  assert.match(del,/agent_id:/);assert.match(del,/criterion:/);
  const server=fs.readFileSync(new URL('../../server.mjs',import.meta.url),'utf8');
  assert.match(server,/args\?\.agent_id \? await delegateToCultivatedAgent\(cultivationRuntime/);
  assert.ok(!fs.readFileSync(new URL('../../engine/cultivation/delegate.mjs',import.meta.url),'utf8').includes('dispatchAllowed'));
});
