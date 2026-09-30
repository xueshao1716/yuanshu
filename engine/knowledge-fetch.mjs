import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import {digest,fail} from './knowledge-state.mjs';
import {providerError} from './knowledge-provider.mjs';
const MAX=1024*1024;
const denied=new net.BlockList();
for(const [ip,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],
  ['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]])denied.addSubnet(ip,prefix,'ipv4');
// IPv6 is deliberately unsupported here until mapped/transition address validation is available.
export const publicAddress=address=>net.isIP(address)===4&&!denied.check(address,'ipv4');
export function authorizedUrl(input,policy){
  let u;try{u=new URL(input);}catch{fail('url_denied');}
  if(u.protocol!=='https:'||u.username||u.password||u.hash||u.search||u.port&&u.port!=='443')fail('url_denied');
  if(!policy.allowedUrls.some(raw=>{try{return new URL(raw).href===u.href;}catch{return false;}}))fail('url_not_authorized');
  return u;
}
export function knowledgeTransport(url,{address,signal,headers}){
  return new Promise((resolve,reject)=>{
    const req=https.request(url,{method:'GET',headers,signal,agent:false,
      lookup:(_hostname,options,callback)=>options?.all?callback(null,[{address,family:4}]):callback(null,address,4)},res=>{
      if(Number(res.headers['content-length'])>MAX){res.destroy();req.destroy();reject(Object.assign(new Error('source_too_large'),{code:'source_too_large'}));return;}
      const chunks=[];let size=0;
      res.on('data',chunk=>{size+=chunk.length;if(size>MAX){res.destroy(Object.assign(new Error('source_too_large'),{code:'source_too_large'}));}else chunks.push(chunk);});
      res.once('error',reject);res.once('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
    });
    req.once('error',reject);req.end();
  });
}
export async function fetchKnowledgeSource({url,policy,budget,signal,lookup=dns.lookup,transport=knowledgeTransport,now=Date.now}){
  if(!policy.networkEnabled||!policy.localEnabled||policy.paused)fail('network_disabled');
  const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000);
  let target=authorizedUrl(url,policy);
  for(let hop=0;hop<=3;hop++){
    combined.throwIfAborted();
    let addresses;
    let abort;
    try {addresses=await Promise.race([lookup(target.hostname,{all:true}),new Promise((_,reject)=>{
      abort=()=>reject(Object.assign(new Error('provider_transient'),{code:'provider_transient'}));
      combined.addEventListener('abort',abort,{once:true});
    })]);}catch{fail('provider_transient');}finally{combined.removeEventListener('abort',abort);}
    if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))fail('network_address_denied');
    combined.throwIfAborted();
    const reservation=await budget.reserve({kind:'network',policy,maxCost:0,currency:policy.currency,free:true});
    let response;
    try{response=await transport(target,{address:addresses[0].address,signal:combined,
      headers:{Accept:'text/plain, text/html','Accept-Encoding':'identity','User-Agent':'Yuanshu-Knowledge/1.0'}});}
    catch(e){await budget.settle(reservation.id,null);if(e.code==='source_too_large')throw e;throw providerError(e);}
    await budget.settle(reservation.id,{cost:0,currency:policy.currency});combined.throwIfAborted();
    if([301,302,303,307,308].includes(response.status)){
      if(hop===3)fail('redirect_limit');let next;try{next=new URL(response.headers.location,target).href;}catch{fail('url_denied');}
      target=authorizedUrl(next,policy);continue;
    }
    if(response.status<200||response.status>=300)throw providerError({status:response.status});
    if(response.body.length>MAX)fail('source_too_large');
    if(response.headers['content-encoding']&&response.headers['content-encoding']!=='identity')fail('source_format_unsupported');
    const type=String(response.headers['content-type']||'').split(';')[0];
    if(!['text/html','text/plain','text/markdown'].includes(type))fail('source_format_unsupported');
    let text=response.body.toString('utf8');
    if(type==='text/html')text=text.replace(/<(script|style|noscript|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ').replace(/<!--[^]*?-->/g,' ').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
    const hash=digest(text),locator=target.href;
    return {id:digest([locator,hash]),kind:'url',locator,hash,text,authority:'source',fetchedAt:now(),reference:{kind:'url',url:locator,hash}};
  }
}
