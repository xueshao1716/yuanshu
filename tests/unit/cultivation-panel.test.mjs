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

test('learning observation is page-scoped and stale data cannot prepare adoption',()=>{
  const panel=source('frontend/src/soul/cultivation/Panel.tsx'),learning=source('frontend/src/soul/cultivation/Learning.tsx');
  const evidence=source('frontend/src/soul/cultivation/Evidence.tsx'),api=source('frontend/src/soul/cultivation/api.ts');
  for(const text of ['coverage={experience.data.coverage}','stale={!!experience.error}'])assert.ok(panel.includes(text),text);
  for(const text of ['authorized={authorized&&!stale}','!stale&&!items.length','本页暂无记录'])assert.ok(learning.includes(text),text);
  for(const text of ['本页候选','补证记录','关联失效','旧数据','observedAt','not_checked','latestDecisions','设计版本','未提供证据观察字段'])assert.ok(evidence.includes(text),text);
  for(const text of ['observation?:','coverage?:'])assert.ok(api.includes(text),text);
  assert.ok(!evidence.includes('dangerouslySetInnerHTML'));assert.ok(!evidence.includes('fetch('));
  assert.ok(evidence.includes('个体 {item.agentId}'),'older servers preserve visible individual attribution');
});

test('learning UI distinguishes prior authorization, execution records and unverified effects',()=>{
  const resources=source('frontend/src/soul/cultivation/Resources.tsx');
  const learning=source('frontend/src/soul/cultivation/Learning.tsx'),evidence=source('frontend/src/soul/cultivation/Evidence.tsx');
  const api=source('frontend/src/soul/cultivation/api.ts');
  for(const text of ['motherLearning','默认关闭','控制版本','已过期','人格','不删除历史对话'])assert.ok(resources.includes(text),text);
  for(const text of ['事先授权','execution_record','失败、取消或结果未知','实际引用不等于验证有效'])assert.ok(learning.includes(text),text);
  assert.ok(!learning.includes('分享给母体必须由主人签名'));
  assert.ok(evidence.includes('执行记录'));
  assert.ok(api.includes('motherLearning?:boolean'));assert.ok(api.includes("generatedRole:'model_generated'|'execution_record'"));
});
