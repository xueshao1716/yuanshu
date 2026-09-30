import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {initFileLock} from '../../engine/file-lock.mjs';
import {createKnowledgeStore} from '../../engine/knowledge-store.mjs';
import {digest,guardFor} from '../../engine/knowledge-state.mjs';
import {createVoiceAdmission} from '../../engine/chat-voice-admission.mjs';
function fixture(t){const wsRoot=fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-knowledge-hardening-'));t.after(()=>fs.rmSync(wsRoot,{recursive:true,force:true}));initFileLock({dir:path.join(wsRoot,'locks')});return {wsRoot,store:createKnowledgeStore({wsRoot})};}
test('policy change releases and fences active work immediately; blocked source never gets a claim',async t=>{
 const {store}=fixture(t);const a=await store.enqueue({sourceId:'a',sourceVersion:digest('a'),event:'manual',sources:[]});
 const job=await store.claim('test');await store.updatePolicy({paused:true},1);
 assert.equal((await store.get(a.id)).state,'queued');await assert.rejects(store.transition(job.id,guardFor(job),{state:'extracting'}));
 await store.block(a.id,'source_missing');await store.updatePolicy({paused:false},2);assert.equal(await store.claim('other'),null);
});
test('failed attempts may be explicitly retried without carrying old candidate validation',async t=>{
 const {store}=fixture(t);await store.enqueue({sourceId:'a',sourceVersion:digest('a'),event:'manual',sources:[]});
 const job=await store.claim('test'),failed=await store.transition(job.id,guardFor(job),{state:'failed',attempts:3,candidate:{text:'old'}});
 const retried=await store.control(job.id,'retry',failed.revision);assert.equal(retried.state,'queued');assert.equal(retried.stage,'collecting');assert.equal(retried.attempts,0);assert.equal(retried.candidate,undefined);
});
test('voice activity exposes a readonly busy signal',()=>{
 const a=createVoiceAdmission({getToken:()=>'',readSession:()=>null});assert.equal(typeof a.isActive,'function');assert.equal(a.isActive(),false);
 a.acquire({login:'test'});assert.equal(a.isActive(),true);a.release({login:'test'});assert.equal(a.isActive(),false);
});
test('resuming paused ready work discards stale evidence validation',async t=>{
 const {store}=fixture(t);await store.enqueue({sourceId:'a',sourceVersion:digest('a'),event:'manual',sources:[]});
 let job=await store.claim('test');
 for(const state of ['extracting','validating','ready'])job=await store.transition(job.id,guardFor(job),{state,candidate:{text:'old'},validation:{entry:{text:'old'}}});
 job=await store.control(job.id,'pause',job.revision);job=await store.control(job.id,'resume',job.revision);
 assert.equal(job.stage,'collecting');assert.equal(job.validation,undefined);assert.equal(job.candidate,undefined);
});
