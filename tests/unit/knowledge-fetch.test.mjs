import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchKnowledgeSource,publicAddress} from '../../engine/knowledge-fetch.mjs';
const url='https://example.org/article';
const policy={localEnabled:true,networkEnabled:true,allowedUrls:[url],currency:'USD'};
function setup(extra={}) {let requests=0,reserves=0;return {args:{url,policy,
  budget:{reserve:async()=>{reserves++;return {id:String(reserves)};},settle:async()=>{}},
  lookup:async()=>[{address:'93.184.216.34',family:4}],
  transport:async(target,opts)=>{requests++;assert.equal(opts.address,'93.184.216.34');assert.equal(opts.headers.Cookie,undefined);return {status:200,headers:{'content-type':'text/html'},body:Buffer.from('<h1>Title</h1><script>danger()</script><p>Evidence</p>')};},...extra},stats:()=>({requests,reserves})};}
test('network source requires exact authorization and public addresses',async()=>{
  for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','100.64.0.1','192.168.1.1','0.0.0.0','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1'])assert.equal(publicAddress(address),false,address);
  assert.equal(publicAddress('93.184.216.34'),true);
  const a=setup();await assert.rejects(fetchKnowledgeSource({...a.args,policy:{...policy,networkEnabled:false}}),{code:'network_disabled'});
  await assert.rejects(fetchKnowledgeSource({...a.args,url:'https://example.org/other'}),{code:'url_not_authorized'});
  await assert.rejects(fetchKnowledgeSource({...a.args,lookup:async()=>[{address:'127.0.0.1',family:4}]}),{code:'network_address_denied'});
  assert.equal(a.stats().requests,0);assert.equal(a.stats().reserves,0);
});
test('fetch pins vetted DNS, strips active content and never forwards credentials',async()=>{
  const a=setup();const snapshot=await fetchKnowledgeSource(a.args);
  assert.match(snapshot.text,/Title/);assert.doesNotMatch(snapshot.text,/danger|script/);assert.equal(snapshot.kind,'url');
  assert.equal(a.stats().requests,1);assert.equal(a.stats().reserves,1);
  const secret='https://example.org/article?token=secret';
  await assert.rejects(fetchKnowledgeSource({...a.args,url:secret,policy:{...policy,allowedUrls:[secret]}}),{code:'url_denied'});
});
test('redirects must be independently authorized and resolved again',async()=>{
  const next='https://other.example/article';let calls=0,dns=0;
  const a=setup({policy:{...policy,allowedUrls:[url,next]},lookup:async()=>{dns++;return [{address:dns===1?'93.184.216.34':'10.0.0.1',family:4}];},
    transport:async()=>{calls++;return {status:302,headers:{location:next},body:Buffer.alloc(0)};}});
  await assert.rejects(fetchKnowledgeSource(a.args),{code:'network_address_denied'});assert.equal(calls,1);assert.equal(dns,2);
});
test('oversized content and transient failures are bounded and sanitized',async()=>{
  const a=setup({transport:async()=>({status:200,headers:{'content-type':'text/plain'},body:Buffer.alloc(1024*1024+1)})});
  await assert.rejects(fetchKnowledgeSource(a.args),{code:'source_too_large'});
  const b=setup({transport:async()=>({status:429,headers:{},body:Buffer.from('secret')})});
  await assert.rejects(fetchKnowledgeSource(b.args),{code:'provider_transient',message:'provider_transient'});
});
