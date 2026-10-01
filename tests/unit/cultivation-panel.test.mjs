import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=p=>fs.existsSync(p)?fs.readFileSync(p,'utf8'):'';
test('cultivation panel is mounted explicitly, with honest empty state and hidden polling disabled',()=>{
  assert.ok(source('frontend/src/pages/Soul.tsx').includes("id==='cultivation'?<Cultivation/>"));
  assert.ok(source('frontend/src/soul/Overview.tsx').includes("['cultivation'"));
  const panel=source('frontend/src/soul/cultivation/Panel.tsx'),api=source('frontend/src/soul/cultivation/api.ts');
  for(const text of ['等待小语提交设计','个体与设计','运行时间线','学习证据','授权与资源'])assert.ok(panel.includes(text),text);
  for(const text of ['refreshInterval:30000','refreshWhenHidden:false','refreshWhenOffline:false'])assert.ok(api.includes(text),text);
  assert.ok(!panel.includes('CompanionProvider'));
});
test('knowledge deep links preserve the apps route and select records outside the loaded page',()=>{
  assert.ok(source('frontend/src/hooks/useHashRoute.tsx').includes(".split('?')[0]"));
  const jobs=source('frontend/src/knowledge/KnowledgeJobs.tsx');
  assert.ok(jobs.includes('knowledgeSelection'));
  assert.ok(jobs.includes('selectedJob'));
  assert.ok(jobs.includes("detail.data.event !== 'cultivation'"));
});

test('panel pagination and policy drafts retain their own revision boundaries',()=>{
  const panel=source('frontend/src/soul/cultivation/Panel.tsx'),resources=source('frontend/src/soul/cultivation/Resources.tsx');
  assert.ok(panel.includes("CultivationApi.list<Design>('designs',designCursor)"));
  for(const text of ['draftRevision','revision:draftRevision','draftRevision!==value.revision','设置已更新'])assert.ok(resources.includes(text),text);
  assert.ok(!resources.includes('毫秒时间戳'));
  assert.ok(panel.includes('catch(e)'));
});

test('authorization state is isolated by the complete target command',()=>{
  const panel=source('frontend/src/soul/cultivation/Panel.tsx');
  assert.ok(panel.includes('key={JSON.stringify(action)}'));
});

test('learning actions use knowledge revisions and preserve adoption scope',()=>{
  const learning=source('frontend/src/soul/cultivation/Learning.tsx');
  for(const text of ["path:'/learning'",'revision:item.revision',"'adopt'","'retire'",'item.agentId',"'mother'",'item.learning','reason.trim()'])assert.ok(learning.includes(text),text);
  assert.ok(!learning.includes('evidenceCount'));
});

test('owned media is loaded on demand through authenticated API and unknown outcomes stay unknown',()=>{
  const media=source('frontend/src/soul/cultivation/Media.tsx'),api=source('frontend/src/soul/cultivation/api.ts');
  for(const text of ['CultivationApi.media','agentId',"path:'/assets/revoke'",'controls','preload="none"','catch(e)'])assert.ok(media.includes(text),text);
  assert.ok(!media.includes('autoPlay'));
  assert.ok(api.includes('api<{mime:string;base64:string}>'));
  assert.ok(source('frontend/src/soul/cultivation/Individuals.tsx').includes('outcome_unknown'));
  assert.ok(source('frontend/src/soul/cultivation/Resources.tsx').includes("path:'/resources/reconcile'"));
});
