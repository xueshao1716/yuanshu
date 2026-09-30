import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {directChat,initModelClient} from '../../engine/model-client.mjs';
for(const api of ['openai-completions','openai-responses'])for(const stream of [false,true]){
  if(api==='openai-responses'&&stream)continue;
  test(`knowledge strict ${api} stream=${stream} never hides extra 404 request`,async t=>{
    let requests=0;
    const server=http.createServer((req,res)=>{requests++;res.writeHead(404,{'Content-Type':'application/json'});res.end('{}');});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
    const model={provider:'fixture',id:'text',api,baseUrl:`http://127.0.0.1:${server.address().port}/v1`};
    initModelClient({authPath:'auth',readJsonFile:p=>p==='auth'?{fixture:{key:'fixture-key'}}:{},getModelList:()=>[model]});
    await assert.rejects(directChat(model,'fixture',[],{stream,throwOnError:true,allowEndpointFallback:false,trackModelHealth:false}),/HTTP 404/);
    assert.equal(requests,1);
    await directChat(model,'fixture',[],{stream,trackModelHealth:false});assert.equal(requests,3,'legacy callers retain fallback');
  });
}
