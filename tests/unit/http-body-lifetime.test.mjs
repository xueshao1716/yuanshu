import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {httpJsonFetch,httpBufferFetch} from '../../engine/http.mjs';

async function slowBody(t) {
  let headers;
  const sent=new Promise(resolve=>{headers=resolve;});
  const server=http.createServer((_req,res)=>{
    res.writeHead(200,{'Content-Type':'application/json'});
    res.write('{"ok":');headers();
    const timer=setTimeout(()=>res.end('true}'),350);
    res.once('close',()=>clearTimeout(timer));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  return {url:`http://127.0.0.1:${server.address().port}`,sent};
}

for(const [label,request] of [['JSON',httpJsonFetch],['binary',httpBufferFetch]]) {
  test(`${label} timeout covers body after headers have arrived`,async t=>{
    const {url}=await slowBody(t);
    await assert.rejects(request(url,{timeout:80}),/timeout/);
  });
  test(`${label} cancellation still closes request after response headers`,async t=>{
    const {url,sent}=await slowBody(t),controller=new AbortController();
    const pending=request(url,{timeout:2000,signal:controller.signal});
    const rejected=assert.rejects(pending);
    await sent;
    // Allow fetch to deliver headers before cancelling the body read.
    await new Promise(resolve=>setTimeout(resolve,40));
    controller.abort();
    await rejected;
  });
}

test('completed buffered response remains cached beyond request deadline',async t=>{
  const {url}=await slowBody(t);
  const result=await httpJsonFetch(url,{timeout:500});
  await new Promise(resolve=>setTimeout(resolve,200));
  assert.deepEqual(await result.json(),{ok:true});
  assert.equal(await result.text(),'{"ok":true}');
});
