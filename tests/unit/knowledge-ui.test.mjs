import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=name=>{try{return fs.readFileSync(new URL('../../frontend/src/'+name,import.meta.url),'utf8');}catch{return '';}};
test('knowledge mutations let the shared API serialize JSON and set its content type',()=>{
 const api=read('knowledge/api.ts');
 assert.ok(api.includes("{ method: 'POST', body }"));
 assert.ok(!api.includes('body: JSON.stringify(body)'));
});
test('knowledge center shows distinct stages, errors, revisioned controls and bounded polling',()=>{
 const panel=read('knowledge/KnowledgePanel.tsx'),jobs=read('knowledge/KnowledgeJobs.tsx'),api=read('knowledge/api.ts');
 for(const text of ['knowledge-status','role="alert"','KnowledgePolicy','KnowledgeJobs','KnowledgeSource'])assert.ok(panel.includes(text),text);
 for(const text of ['refreshWhenHidden: false','refreshInterval: 30000','revision','limit=20'])assert.ok((api+jobs).includes(text),text);
 for(const text of ['blocked','review_required','retry_wait','committed','cancelled','nextAttemptAt','sources','validation'])assert.ok(jobs.includes(text),text);
});
test('policy makes authorization, unknown usage and cost explicit; new intake replaces private script generation',()=>{
 const policy=read('knowledge/KnowledgePolicy.tsx'),panel=read('knowledge/KnowledgePanel.tsx');
 for(const text of ['allowedRoots','allowedUrls','outboundRoots','remoteEnabled','networkEnabled','dailyCost','currency','tokenBound','rates','KnowledgeApi.models'])assert.ok(policy.includes(text),text);
 assert.ok(panel.includes('预留'));assert.ok(panel.includes('未知'));
 assert.ok(!read('pages/Apps.tsx').includes('RefineApi.plan()'));
 assert.ok(read('components/LearningIntakePanel.tsx').includes('<KnowledgePanel'));
 assert.ok(read('components/LearningIntakePanel.tsx').includes('experience?.entries'));
 assert.ok(!read('components/LearningIntakePanel.tsx').includes('待提炼任务'));
 const soul=read('soul/LiveSections.tsx');assert.ok(soul.includes('KnowledgeApi.status'));assert.ok(soul.includes('href="#/apps"'));assert.ok(!soul.includes('<KnowledgePolicy'));
});
test('supplement UI links evidence to its original job with both revisions',()=>{
 const api=read('knowledge/api.ts'),jobs=read('knowledge/KnowledgeJobs.tsx'),source=read('knowledge/KnowledgeSource.tsx'),panel=read('knowledge/KnowledgePanel.tsx');
 for(const text of ['/supplement','policyRevision','relatedJobId'])assert.ok(api.includes(text),text);
 assert.ok(jobs.includes('parent={detail.data}'));assert.ok(panel.includes('policyRevision={policy.data?.revision}'));
 assert.ok(source.includes('KnowledgeApi.supplement(parent.id, source, parent.revision, revision)'));
 assert.ok(source.includes('<fieldset disabled={busy}'));assert.ok(source.includes('if (busy) return'));
});
test('policy refresh preserves drafts and warns about stale revisions and unconverted prices',()=>{
 const panel=read('knowledge/KnowledgePanel.tsx'),policy=read('knowledge/KnowledgePolicy.tsx');
 assert.ok(!panel.includes('key={policy.data.revision}'));
 for(const text of ['policy.revision > draft.revision','setDraft(saved)','重新载入最新设置','不会自动换算','rate.currency !== draft.currency','disabled={busy || stale || currencyMismatch}'])assert.ok(policy.includes(text),text);
});
test('related evidence does not promise pagination-blind navigation and failed refresh releases controls',()=>{
 const jobs=read('knowledge/KnowledgeJobs.tsx');
 assert.ok(!jobs.includes('setSelected(detail.data!.relatedJobId!)'));
 assert.ok(jobs.includes('Promise.allSettled'));
 const panel=read('knowledge/KnowledgePanel.tsx');
 assert.ok(panel.includes('Promise.allSettled([status.mutate(), policy.mutate()])'), 'status refresh must not reject before resetting busy');
});

test('knowledge detail distinguishes execution, objective checks, human acceptance and team model review',()=>{
 const jobs=read('knowledge/KnowledgeJobs.tsx'),view=read('knowledge/KnowledgeProvenance.tsx'),api=read('knowledge/api.ts');
 assert.ok(jobs.includes('<KnowledgeProvenance value={detail.data.provenance}'));
 for(const text of ['任务执行','客观检查','人工验收','模型评审','不等于方法已验证','unavailable','unknown'])assert.ok(view.includes(text),text);
 assert.ok(api.includes('provenance?:'));assert.ok(api.includes('replacementJobId?:'));
 assert.ok(api.includes("source_replaced:"));
});
test('intake errors and capacity pressure are visible and queue refresh consumes rejections',()=>{
 const panel=read('knowledge/KnowledgePanel.tsx'),api=read('knowledge/api.ts'),jobs=read('knowledge/KnowledgeJobs.tsx');
 assert.ok(panel.includes('status.data.intake?.lastError'));
 assert.ok(api.includes('intake?:'));assert.ok(api.includes('knowledge_storage_full:'));
 assert.ok(!jobs.includes('void list.mutate()'));assert.ok(jobs.includes('onClick={() => void refreshQueue()}'));
});
test('human source review has explicit confirmation, reason, history and both revision fences',()=>{
 const view=read('knowledge/KnowledgeReview.tsx'),jobs=read('knowledge/KnowledgeJobs.tsx'),api=read('knowledge/api.ts');
 for(const text of ['KnowledgeApi.review','confirmed','note','job.revision','policyRevision','accept_source','keep_existing','reject','min-h-11','role="alert"'])assert.ok(view.includes(text),text);
 assert.ok(jobs.includes('<KnowledgeReview'));assert.ok(api.includes('/review'));assert.ok(view.includes('job.reviews'));
});
test('method enrollment exposes an explicit fixed checker manifest without promising task approval',()=>{
 const source=read('knowledge/KnowledgeSource.tsx'),review=read('knowledge/KnowledgeReview.tsx');
 assert.ok(source.includes('value="method"'));assert.ok(source.includes('json-contract-v1'));
 assert.ok(source.includes('不替代任务或天团验收'));assert.ok(review.includes('job.candidate?.text'));
});
test('method detail exposes the exact contract, artifact version and environment rather than a generic PASS',()=>{
 const jobs=read('knowledge/KnowledgeJobs.tsx'),view=read('knowledge/KnowledgeMethod.tsx'),api=read('knowledge/api.ts');
 assert.ok(jobs.includes('<KnowledgeMethod value={detail.data.validation?.entry}'));
 for(const text of ['artifactHash','manifestHash','artifactPath','assertions','environment','当前产物','不替代','scope'])assert.ok(view.includes(text),text);
 assert.ok(api.includes('method?: KnowledgeMethodData'));
});
test('resolved supplementary history is visible without offering duplicate adjudication or implying source validity',()=>{
 const jobs=read('knowledge/KnowledgeJobs.tsx'),review=read('knowledge/KnowledgeReview.tsx'),panel=read('knowledge/KnowledgePanel.tsx'),api=read('knowledge/api.ts');
 for(const text of ['displayState','已由补证解决','resolution.jobId','resolution.entryId','不代表来源当前仍可引用'])assert.ok(jobs.includes(text),text);
 assert.ok(review.split('\n').some(l=>l.includes("job.state === 'review_required'")&&l.includes('!job.resolution')));
 assert.ok(jobs.split('\n').filter(l=>l.includes('<KnowledgeSource parent=')||l.includes("onClick={() => act(")).every(l=>l.includes('!detail.data.resolution')));
 assert.ok(panel.includes('counts?.resolved'));assert.ok(api.includes('resolution?:'));assert.ok(api.includes('job_resolved:'));
});
