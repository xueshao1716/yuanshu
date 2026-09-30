import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {collectLocalSources} from './knowledge-sources.mjs';
import {scopeKey} from './run-recovery.mjs';
import {digest,fail} from './knowledge-state.mjs';
const signed=new WeakSet();
const manifestKeys=new Set(['version','checker','sourcePath','offset','length','artifactPath','assertions']);
function parseManifest(text){
  let m;try{m=JSON.parse(text);}catch{fail('method_manifest_invalid');}
  if(!m||typeof m!=='object'||Array.isArray(m)||Object.keys(m).some(k=>!manifestKeys.has(k))||m.version!==1||
    m.checker!=='json-contract-v1'||typeof m.sourcePath!=='string'||typeof m.artifactPath!=='string'||
    !Number.isInteger(m.offset)||m.offset<0||!Number.isInteger(m.length)||m.length<1||m.length>1200||
    !Array.isArray(m.assertions)||!m.assertions.length||m.assertions.length>32)fail('method_manifest_invalid');
  for(const a of m.assertions)if(!a||Object.keys(a).some(k=>!['pointer','equals'].includes(k))||
    typeof a.pointer!=='string'||!a.pointer.startsWith('/')||a.pointer.length>256||/~(?![01])/.test(a.pointer)||
    !Object.hasOwn(a,'equals')||a.equals!==null&&!['string','number','boolean'].includes(typeof a.equals)||
    typeof a.equals==='string'&&a.equals.length>500)fail('method_manifest_invalid');
  return m;
}
function checksPass(text,assertions){
  let data;try{data=JSON.parse(text);}catch{return false;}
  return assertions.every(a=>{
    let value=data;
    for(const key of a.pointer.slice(1).split('/').map(k=>k.replaceAll('~1','/').replaceAll('~0','~'))){
      if(!value||typeof value!=='object'||!Object.hasOwn(value,key))return false;value=value[key];
    }
    return isDeepStrictEqual(value,a.equals);
  });
}
export const trustedKnowledgeMethod=proof=>Boolean(proof&&signed.has(proof));
// Fixed read-only JSON equality checks. Never evaluates source code, commands, scripts or model verdicts.
export function createKnowledgeMethods({wsRoot,runRoot,runStore,taskEvidence,now=Date.now}){
  const environment=(runId,sessionId)=>({workspace:digest(scopeKey(wsRoot)),platform:process.platform,
    nodeMajor:process.versions.node.split('.')[0],runId,sessionId});
  const authorize=(source)=>{
    const run=runStore.get(source.runId);
    if(!run||run.sessionId!==source.sessionId||run.status!=='completed'||run.request?.origin==='knowledge'||
      scopeKey(run.backgroundRecovery?.scope||'')!==scopeKey(wsRoot))fail('source_not_authorized');
    return run;
  };
  return {
    async collect({job,policy}){
      const source=job.sources[0];if(job.sources.length!==1||source.kind!=='method')fail('invalid_source');authorize(source);
      const [manifest]=await collectLocalSources({wsRoot,runRoot,runStore,sources:[{kind:'file',path:source.path}],policy,now});
      if(Buffer.byteLength(manifest.text)>32768)fail('method_manifest_invalid');const m=parseManifest(manifest.text);
      const snapshots=await collectLocalSources({wsRoot,runRoot,runStore,policy,now,
        sources:[{kind:'file',path:m.sourcePath},{kind:'file',path:m.artifactPath}]});
      if(m.offset+m.length>snapshots[0].text.length||!m.artifactPath.endsWith('.json'))fail('method_manifest_invalid');
      return [snapshots[0],manifest,snapshots[1]];
    },
    candidate(snapshots){
      const [source,manifest]=snapshots,m=parseManifest(manifest.text);
      return {kind:'method',text:source.text.slice(m.offset,m.offset+m.length),sourceId:source.id,sourceHash:source.hash,
        offset:m.offset,scope:'仅当前任务产物通过指定 JSON 字段契约；不证明方法普遍有效或任务已验收'};
    },
    verify({candidate,snapshots,job}){
      if(job.sources?.[0]?.kind!=='method')return null;
      const source=job.sources[0];authorize(source);
      const [,manifest,artifact]=snapshots,m=parseManifest(manifest.text);
      let evidence;try{evidence=taskEvidence.get(source.runId);}catch{return {ok:false,reason:'method_artifact_unbound'};}
      const expected=path.relative(path.resolve(wsRoot),path.resolve(wsRoot,m.artifactPath)).replaceAll('\\','/');
      const bound=evidence.artifacts.find(a=>a.path===expected&&!a.error&&a.digest===artifact.hash);
      if(evidence.status!=='completed'||evidence.sessionId!==source.sessionId||!bound)return {ok:false,reason:'method_artifact_unbound'};
      if(!checksPass(artifact.text,m.assertions))return {ok:false,reason:'method_check_failed'};
      const proof={ok:true,candidateHash:digest(candidate),method:{checker:m.checker,manifestHash:manifest.hash,
        artifactHash:bound.digest,artifactPath:artifact.locator,assertions:m.assertions,runDigest:evidence.digest,
        environment:environment(source.runId,source.sessionId)}};
      signed.add(proof);return proof;
    },
    sameEnvironment(method){return digest(method?.environment)===digest(environment(method?.environment?.runId,method?.environment?.sessionId));},
  };
}
