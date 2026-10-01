import test from 'node:test';
import assert from 'node:assert/strict';
import {createCultivationExperience} from '../../engine/cultivation/experience.mjs';
import {digest} from '../../engine/knowledge-state.mjs';
import {pageRecords} from '../../engine/cultivation/pagination.mjs';

const observedAt=1790852400000,workspace='a'.repeat(64);
function fixture(count=1){
  const runs=Array.from({length:count},(_,i)=>({id:`run-${i}`,cultivation:{
    agentId:`agent-${i}`,designId:`design-${i}`,knowledgeJobId:digest(`job-${i}`),output:`Candidate ${i}`}}));
  const jobs=runs.map(run=>({id:run.cultivation.knowledgeJobId,runId:run.id,state:'review_required',
    reason:'independent_evidence_required',revision:1,provenance:{outputHash:digest(run.cultivation.output)}}));
  let reads=0;
  const knowledge={getMany:async ids=>{reads++;return ids.map(id=>jobs.find(j=>j?.id===id)??null);}};
  const create=()=>createCultivationExperience({workspace,now:()=>observedAt,
    repo:{page:q=>pageRecords(runs,workspace,'experience',q)},knowledge});
  return {runs,jobs,knowledge,create,bridge:create(),reads:()=>reads};
}
const decision=(scope,action,version,at=10)=>({scope,decision:action,version,at,entryId:'entry-1',
  actor:{kind:scope==='mother'?'human':'mother',actorId:'private-actor',workspace},reason:'private-reason',sourceVersion:'private-source'});

test('experience observation identifies the complete recorded origin without promoting generated output',async()=>{
  const f=fixture(),page=await f.bridge.list(),item=page.items[0];
  assert.deepEqual(item.observation,{
    lineage:{agentId:'agent-0',designId:'design-0',runId:'run-0',knowledgeJobId:f.jobs[0].id},
    linkState:'linked',generatedRole:'model_generated',resolutionRecorded:false,
    sourceCurrent:'not_checked',latestDecisions:[],userAcceptance:null,
  });
  assert.deepEqual(page.coverage,{basis:'returned_page',returnedCount:1,hasMore:false,observedAt});
  assert.equal(item.evidenceCount,0);assert.equal(item.userAcceptance,null);
});

test('resolution and latest per-scope decisions remain historical, detached and minimally projected',async()=>{
  const f=fixture(),job=f.jobs[0];job.resolution={jobId:'resolution-1',entryId:'entry-1'};
  // Append order, not wall-clock time, is authoritative in the existing ledger.
  job.learning=[decision('agent-0','adopt',1,300),decision('mother','adopt',1,200),decision('agent-0','retire',2,100)];
  const before=structuredClone(job),{observation:o}= (await f.bridge.list()).items[0];
  assert.ok(o,'observation is present');
  assert.equal(o.resolutionRecorded,true);assert.equal(o.lineage.resolutionJobId,'resolution-1');
  assert.equal(o.lineage.entryId,'entry-1');assert.equal(o.sourceCurrent,'not_checked');assert.equal(o.userAcceptance,null);
  assert.deepEqual(o.latestDecisions,[
    {scope:'agent-0',decision:'retire',version:2,at:100,entryId:'entry-1',actor:{kind:'mother'}},
    {scope:'mother',decision:'adopt',version:1,at:200,entryId:'entry-1',actor:{kind:'human'}},
  ]);
  assert.ok(!JSON.stringify(o).includes('private-'));o.latestDecisions[0].actor.kind='changed';
  assert.deepEqual(job,before,'projection never changes source records');
});

for(const defect of ['missing','runId','outputHash'])test(`invalid ${defect} hides all resolution and adoption projections`,async()=>{
  const f=fixture();f.jobs[0].resolution={jobId:'secret-resolution',entryId:'secret-entry'};
  f.jobs[0].learning=[decision('mother','adopt',1)];
  if(defect==='missing')f.jobs.splice(0);
  else if(defect==='runId')f.jobs[0].runId='other-run';
  else f.jobs[0].provenance.outputHash=digest('changed');
  const item=(await f.bridge.list()).items[0];
  assert.equal(item.state,'invalidated');assert.equal(item.reason,'source_unavailable');
  assert.ok(item.observation,'invalid links still expose their run attribution');
  assert.equal(item.observation.linkState,'invalidated');assert.equal(item.observation.resolutionRecorded,false);
  assert.deepEqual(item.observation.latestDecisions,[]);assert.equal(item.resolution,null);assert.deepEqual(item.learning,[]);
  assert.ok(!JSON.stringify(item).includes('secret-'));assert.equal(item.observation.lineage.agentId,'agent-0');
});

test('coverage stays page-local and identities survive paging and bridge recreation',async()=>{
  const f=fixture(51),first=await f.bridge.list({limit:50});
  assert.deepEqual(first.coverage,{basis:'returned_page',returnedCount:50,hasMore:true,observedAt});
  const last=await f.create().list({limit:50,cursor:first.nextCursor});
  assert.deepEqual(last.coverage,{basis:'returned_page',returnedCount:1,hasMore:false,observedAt});
  assert.equal(last.items[0].observation.lineage.designId,'design-50');
  assert.deepEqual((await f.create().list({limit:50})).items[0].observation,first.items[0].observation);
  assert.equal(f.reads(),3,'one batch per page, no record-by-record reads');
  await assert.rejects(f.bridge.list({limit:51}),/invalid_pagination/);
});

test('empty pages have explicit coverage and absent optional design fields remain unknown',async()=>{
  const empty=await fixture(0).bridge.list();
  assert.deepEqual(empty.coverage,{basis:'returned_page',returnedCount:0,hasMore:false,observedAt});
  const f=fixture();delete f.runs[0].cultivation.designId;
  const o=(await f.bridge.list()).items[0].observation;
  assert.ok(o);assert.equal(o.lineage.designId,null);assert.deepEqual(o.latestDecisions,[]);
});

test('knowledge read failure propagates without a success-shaped empty page',async()=>{
  const f=fixture();f.knowledge.getMany=async()=>{throw new Error('fixture-read-failed');};
  await assert.rejects(f.bridge.list(),/fixture-read-failed/);
});
