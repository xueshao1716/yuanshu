import {clone,fail} from './knowledge-state.mjs';
export const defaultKnowledgePolicy = () => ({revision:1,localEnabled:true,paused:false,remoteEnabled:false,networkEnabled:false,
  dailyCost:0,currency:'USD',maxModelRequests:20,maxNetworkRequests:20,inputTokens:6000,outputTokens:1200,
  allowedRoots:[],allowedUrls:[],allowedModels:[],outboundRoots:[],model:'',rates:{},concurrency:1});
export function patchKnowledgePolicy(current, patch, revision) {
  if (revision !== current.revision) fail('revision_conflict');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('invalid_policy');
  const defaults=defaultKnowledgePolicy();
  if(Object.keys(patch).some(k=>!(k in defaults)||['revision','concurrency'].includes(k))) fail('invalid_policy');
  const p={...current,...clone(patch),revision:revision+1};
  for (const key of ['localEnabled','paused','remoteEnabled','networkEnabled']) if(typeof p[key]!=='boolean') fail('invalid_policy');
  for (const key of ['dailyCost','maxModelRequests','maxNetworkRequests','inputTokens','outputTokens'])
    if(!Number.isFinite(p[key])||p[key]<0||p[key]>1_000_000) fail('invalid_policy');
  for(const key of ['maxModelRequests','maxNetworkRequests','inputTokens','outputTokens']) if(!Number.isInteger(p[key])) fail('invalid_policy');
  for(const key of ['allowedRoots','allowedUrls','allowedModels','outboundRoots'])
    if(!Array.isArray(p[key])||p[key].length>100||p[key].some(s=>typeof s!=='string'||!s.trim()||s.length>2048)) fail('invalid_policy');
  if(typeof p.model!=='string'||p.model.length>300||!['USD','CNY','EUR'].includes(p.currency)) fail('invalid_policy');
  if(!p.rates||typeof p.rates!=='object'||Array.isArray(p.rates)||Object.keys(p.rates).length>100) fail('invalid_policy');
  for(const rate of Object.values(p.rates)) {
    if(!rate||!['USD','CNY','EUR'].includes(rate.currency)||!['input','output'].every(k=>Number.isFinite(rate[k])&&rate[k]>=0)||
      (rate.input===0&&rate.output===0&&rate.free!==true)) fail('invalid_policy');
  }
  return p;
}
