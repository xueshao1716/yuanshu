import {digest} from './knowledge-state.mjs';
import {trustedKnowledgeMethod} from './knowledge-method.mjs';
import {progressOnly} from './knowledge-quality.mjs';
const suspicious=/ignore (all |previous |prior )?instructions|reveal.{0,30}(system prompt|secret|token)|忽略.{0,12}(指令|规则)|泄露.{0,12}(密钥|令牌)|修改.{0,12}(人格|基因|权限)/i;
export function extractLocal(snapshots,job) {
  const source=snapshots.find(s=>s.kind==='run_result')||snapshots[0];if(!source)return null;
  if(source.authority==='model_output'&&progressOnly(source.text))return null;
  const focus=String(job.focus||'').trim().slice(0,240);
  const match=focus?source.text.toLowerCase().indexOf(focus.toLowerCase()):-1;
  const start=match<0?0:Math.max(source.text.lastIndexOf('\n',match)+1,match-200);
  const text=source.text.slice(start,start+1200).trim();
  return {kind:job.event==='failed'?'observation':'source',text,sourceId:source.id,sourceHash:source.hash,
    offset:source.text.indexOf(text),scope:'仅说明该来源的陈述；并非独立事实核验',runtime:source.kind.startsWith('run')};
}
export function validateCandidate({candidate,snapshots,job,entries=[],now=Date.now(),methodProof}) {
  if(!candidate?.text?.trim())return {state:'skipped',reason:'no_material'};
  const method=candidate.kind==='method'&&trustedKnowledgeMethod(methodProof)&&methodProof.candidateHash===digest(candidate);
  if(!['source','observation'].includes(candidate.kind)&&!method)return {state:'review_required',reason:
    candidate.kind==='method'&&methodProof?.ok===false?methodProof.reason:'independent_evidence_required'};
  const source=snapshots.find(s=>s.id===candidate.sourceId&&s.hash===candidate.sourceHash);
  if(!source||digest(source.text)!==source.hash||!Number.isInteger(candidate.offset)||candidate.offset<0||
    source.text.slice(candidate.offset,candidate.offset+candidate.text.length)!==candidate.text)return {state:'blocked',reason:'excerpt_mismatch'};
  if(suspicious.test(candidate.text))return {state:'review_required',reason:'untrusted_instructions'};
  if(!method&&source.authority==='model_output'&&progressOnly(candidate.text))return {state:'skipped',reason:'low_quality_model_output'};
  // Only explicit one-line key/value statements support this conservative conflict check.
  // Scope prevents unrelated sessions from being treated as competing authorities.
  const pair=candidate.text.match(/^([^\n:：]{2,64})[:：]\s*([^\n]{1,200})$/);
  const claimKey=pair?digest([job.sessionId||'',pair[1].trim().toLowerCase()]):null;
  const claimValue=pair?pair[2].trim():candidate.text;
  const conflicts=entries.filter(e=>claimKey&&e.claimKey===claimKey&&(e.claimValue||e.text)!==claimValue&&
    ['active','conflict'].includes(e.status)).map(e=>e.id);
  const approval=job.approval,approved=approval?.source==='authenticated_ui'&&approval.decision==='accept_source'&&
    approval.sourceVersion===job.sourceVersion&&approval.candidateHash===digest(candidate)&&approval.policyRevision===job.policyRevision;
  if(conflicts.length&&(!approved||conflicts.some(id=>!approval.conflicts.includes(id))))return {state:'review_required',reason:'source_conflict',conflicts};
  if(job.event==='correction'&&!approved)return {state:'review_required',reason:'correction_requires_review'};
  return {state:'ready',reason:'attributed_excerpt',entry:{kind:job.event==='failed'?'observation':candidate.kind,text:candidate.text,
    claimKey,claimValue,sessionId:job.sessionId||null,scope:candidate.scope||'仅来源陈述',sourceVersion:job.sourceVersion,verified:method,status:'active',
    ...(method?{method:methodProof.method}:{}),verification:method?'readonly_json_contract':'exact_excerpt',sources:[{id:source.id,hash:source.hash,locator:source.locator,reference:source.reference,offset:candidate.offset,
      length:candidate.text.length,authority:source.authority,fetchedAt:source.fetchedAt}],expiresAt:now+(candidate.runtime?7:30)*86400000}};
}
