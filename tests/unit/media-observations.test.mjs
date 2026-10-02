import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFileSync} from 'node:fs';
import {createReplyTts} from '../../engine/reply-tts.mjs';
import * as diagnostics from '../../engine/media-observations.mjs';
import {initMediaApi, generateImage, startVideoJob, checkVideoJob, generateTTS} from '../../engine/media-api.mjs';

test('malformed accepted responses remain visible for TTS, video and async image', async () => {
  let calls=0;
  const server=http.createServer((req,res)=>{calls++;req.resume();res.writeHead(200);res.end('not json');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
  initMediaApi({resolveAuth:p=>p==='stepfun-plan'?null:{key:'fixture-only',baseUrl},readJsonFile:()=>({})});
  try {
    for(const operation of [()=>generateTTS('fixture'),()=>startVideoJob('fixture','video-v2.5','fixture'),
      ()=>checkVideoJob('fixture','video-v2.5','fixture-task'),()=>generateImage('modelscope','image-v1','fixture','1024x1024')]) {
      const before=diagnostics.mediaObservations.snapshot().items.length;
      try{await operation();}catch{}
      assert.equal(diagnostics.mediaObservations.snapshot().items.length,before+1);
      assert.equal(diagnostics.mediaObservations.snapshot().items[0].code,'invalid_response');
    }
    assert.equal(calls,4);
  } finally {await new Promise(resolve=>server.close(resolve));initMediaApi();}
});

test('reply playback records actual failures, not validation or cancellation', async () => {
  let response={ok:false,status:403},calls=0;
  const service=createReplyTts({getModelList:()=>[{id:'stepaudio-2.5-tts',provider:'fixture'}],readStore:()=>({}),
    resolveAuth:()=>({key:'secret',baseUrl:'https://private.example'}),request:async()=>{calls++;return response;}});
  const before=diagnostics.mediaObservations.snapshot().items.length;
  await assert.rejects(service.synthesize({text:''}));
  assert.equal(calls,0);
  await assert.rejects(service.synthesize({text:'private prompt'}));
  assert.equal(diagnostics.mediaObservations.snapshot().items.length,before+1);
  assert.equal(diagnostics.mediaObservations.snapshot().items[0].status,403);
  response={ok:true,status:200,buffer:()=>Buffer.from('not audio')};
  await assert.rejects(service.synthesize({text:'private prompt'}));
  assert.equal(diagnostics.mediaObservations.snapshot().items[0].code,'invalid_response');
  assert.equal(diagnostics.mediaObservations.snapshot().items[0].phase,'reply');
  assert.equal(calls,2);
});

test('model management exposes authenticated read-only passive diagnostics', () => {
  const read=name=>readFileSync(new URL('../../'+name,import.meta.url),'utf8');
  const server=read('server.mjs').split('\n');
  assert.ok(server.some(line=>line.includes('["GET", "/api/models/media-observations"')&&line.includes('mediaObservations.snapshot()')&&line.includes('no-store')));
  const api=read('frontend/src/api.ts').split('\n');
  assert.ok(api.some(line=>line.includes('mediaObservations:')&&line.includes('/api/models/media-observations')&&!line.includes('POST')));
  assert.ok(read('frontend/src/components/ModelChannels.tsx').includes('<MediaObservations'));
  const panel=read('frontend/src/components/models/MediaObservations.tsx');
  for(const required of ['近期实际调用失败','不代表通道健康','实时通话','KeysApi.mediaObservations()','role="alert"','touch-hit'])assert.ok(panel.includes(required),required);
  for(const forbidden of ['KeysApi.verify','KeysApi.discover','setInterval'])assert.ok(!panel.includes(forbidden));
});

test('records expire after 24 hours and snapshot never exposes arbitrary fields', () => {
  let time=Date.parse('2026-10-02T00:00:00Z');
  const store=diagnostics.createMediaObservations({now:()=>time});
  store.record({kind:'image',provider:'fixture',model:'image',status:503,endpoint:'secret',prompt:'secret'});
  time+=86400001;
  assert.deepEqual(store.snapshot().items,[]);
});

test('passive diagnostics retain bounded detached records, never raw payloads', () => {
  const store = diagnostics.createMediaObservations({limit: 2});
  for (const status of [401, 403, 429]) store.record({kind:'image', provider:'fixture', model:'image-v1', status,
    key:'sk-secret', prompt:'private words', error:'https://private.example/?key=secret'});
  const result = store.snapshot();
  assert.deepEqual(result.items.map(x=>x.status), [429,403]);
  assert.equal(result.scope,'process');
  assert.equal(result.items[1].code,'access_denied');
  assert.doesNotMatch(JSON.stringify(result), /sk-secret|private|https:/);
  result.items[0].provider = 'mutated';
  assert.equal(store.snapshot().items[0].provider,'fixture');
  store.record({kind:'image',provider:'https://private.example',model:'sk-secret',status:403});
  assert.doesNotMatch(JSON.stringify(store.snapshot()), /private|sk-secret/);
});

test('observed request is called once, preserves response/error, ignores cancellation', async () => {
  const store = diagnostics.createMediaObservations();let calls=0;
  const response={ok:false,status:403};
  const context={kind:'tts',provider:'fixture',model:'speech',store};
  assert.equal(await diagnostics.observeMediaRequest(context,async()=>{calls++;return response;}),response);
  assert.equal(calls,1);assert.equal(store.snapshot().items.length,1);
  const error=Object.assign(new Error('secret URL'),{code:'ECONNRESET'});
  await assert.rejects(diagnostics.observeMediaRequest(context,async()=>{throw error;}),e=>e===error);
  assert.equal(store.snapshot().items[0].code,'network_error');
  const controller=new AbortController();controller.abort();
  await assert.rejects(diagnostics.observeMediaRequest({...context,signal:controller.signal},async()=>{throw error;}));
  assert.equal(store.snapshot().items.length,2);
  await diagnostics.observeMediaRequest(context,async()=>({ok:true,status:202}));
  assert.equal(store.snapshot().items.length,2,'accepted response is not proof of completed media');
});

test('actual media HTTP failures are visible without retries, payloads or credentials', async () => {
  let calls=0,status=403;
  const server=http.createServer((req,res)=>{calls++;req.resume();res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({error:'private prompt sk-secret https://private.example'}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
  initMediaApi({resolveAuth:p=>p==='stepfun-plan'?null:{key:'fixture-only',baseUrl},readJsonFile:()=>({})});
  try {
    const before=diagnostics.mediaObservations.snapshot().items.length;
    await assert.rejects(generateImage('fixture','image-v1','private prompt','1024x1024'),e=>e.status===403);
    await assert.rejects(generateImage('minimax','image-v1','private prompt','1024x1024'),e=>e.status===403);
    await startVideoJob('fixture','video-v2.5','private prompt');
    await checkVideoJob('fixture','video-v2.5','task-fixture');
    await generateTTS('private prompt');
    assert.equal(calls,5,'diagnostics must not add probes or retry purchases');
    const items=diagnostics.mediaObservations.snapshot().items;
    assert.equal(items.length-before,5);
    assert.deepEqual(items.slice(0,5).map(x=>x.kind),['tts','video','video','image','image']);
    assert.doesNotMatch(JSON.stringify(items), /private|fixture-only|127\.0\.0\.1/);
    status=200;
    await assert.rejects(generateImage('fixture','image-v1','private prompt','1024x1024'));
    assert.equal(diagnostics.mediaObservations.snapshot().items[0].code,'invalid_response');
  } finally {await new Promise(resolve=>server.close(resolve));initMediaApi();}
});
