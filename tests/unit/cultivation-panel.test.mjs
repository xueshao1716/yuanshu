import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=p=>fs.existsSync(p)?fs.readFileSync(p,'utf8'):'';

test('cultivation setup exposes shared settings and design readiness before registration',()=>{
 const resources=source('frontend/src/soul/cultivation/Resources.tsx');
 const preset=source('frontend/src/soul/cultivation/PolicyPreset.tsx');
 assert.ok(resources.includes('<SharedResources'));
 assert.ok(preset.includes('<DesignReadiness'));
 const readiness=source('frontend/src/soul/cultivation/DesignReadiness.tsx');
 for(const text of ['design.check','blockedBy','不调用模型','重新检查','knowledge.'])assert.ok(readiness.includes(text),text);
});

test('readonly diagnostics show action-specific blockers, model identifiers and bounded rejection history',()=>{
  const view=source('frontend/src/soul/cultivation/Diagnostics.tsx'),api=source('frontend/src/soul/cultivation/api.ts');
  assert.ok(source('frontend/src/soul/cultivation/Resources.tsx').includes('<Diagnostics revision={value.revision}'));
  for(const text of ['CultivationApi.preflight','CultivationApi.models','CultivationApi.denials','blockedBy','nextAction','role="alert"','role="status"','重新检查','尚未探活','数据已变化','nextCursor'])assert.ok(view.includes(text),text);
  assert.ok(!view.includes('CultivationApi.execute'));assert.ok(!view.includes('setInterval'));
  for(const text of ['/preflight?','/models','/denials'])assert.ok(api.includes(text),text);
});
test('cultivation panel is mounted explicitly, with honest empty state and hidden polling disabled',()=>{
  assert.ok(source('frontend/src/pages/Soul.tsx').includes("id==='cultivation'?<Cultivation sessionId={sessionId}/>"));
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
  assert.ok(panel.includes('key={JSON.stringify([sessionId,action])}'));
});

test('session approval is policy-only, answered through registry and invalidated on unmount',()=>{
  const auth=source('frontend/src/soul/cultivation/Authorization.tsx');
  for(const text of ["action.method==='PUT'&&action.path==='/policy'",'ConfirmApi.answer(',
    'alive.current=false','if(!alive.current)', '提交结果尚待核对','!sessionId'])assert.ok(auth.includes(text),text);
  const panel=source('frontend/src/soul/cultivation/Panel.tsx');
  assert.ok(panel.includes('const authorized=!!overview.data?.humanGrantAvailable'));
  assert.ok(panel.includes('sessionId={sessionId}'));
});
test('bounded cultivation preset uses a real design and keeps tools and unrelated actions closed',()=>{
  const preset=source('frontend/src/soul/cultivation/PolicyPreset.tsx')+source('frontend/src/soul/cultivation/grant-preset.mjs');
  for(const text of ['design.permissions.model','dailyRequests: GRANT_DAILY_REQUESTS','GRANT_DAILY_REQUESTS = 5','GRANT_DAILY_BUDGET_CENTS = 50','tools: []',
    'allowRemote: true','maxAgents: 1','motherLearning: false','knowledge:approved-cultivation',
    '不会自动开始付费任务','nextCursor'])assert.ok(preset.includes(text),text);
  const resources=source('frontend/src/soul/cultivation/Resources.tsx');
  assert.ok(resources.includes('value.sessionGrantAvailable&&!!sessionId'));
  assert.ok(resources.includes('disabled={!value.humanGrantAvailable||!reason.trim()}'));
});

test('cultivation primary path is hands-off and keeps computer credentials out of the design flow',()=>{
  const panel=source('frontend/src/soul/cultivation/Panel.tsx');
  const preset=source('frontend/src/soul/cultivation/PolicyPreset.tsx');
  const resources=source('frontend/src/soul/cultivation/Resources.tsx');
  for(const text of ['小语自己设计和培养','你只需查看方案并放权','不需要电脑密码','高级设置']) assert.ok(`${panel}\n${preset}\n${resources}`.includes(text),text);
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
