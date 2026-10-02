import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultPolicy} from '../../engine/cultivation/policy.mjs';
import {policyReadback} from '../../frontend/src/soul/cultivation/policy-readback.mjs';

test('policy confirmation requires an advanced revision and matching stored values',()=>{
  const policy=defaultPolicy(),command={body:{expectedRevision:1,payload:{policy}}};
  assert.equal(policyReadback(command,{revision:1,policy}).state,'stale');
  assert.equal(policyReadback(command,{revision:2,policy}).state,'matched');
  for(const change of [{dailyRequests:2},{models:['unexpected']},{enabled:true}])
    assert.equal(policyReadback(command,{revision:2,policy:{...policy,...change}}).state,'mismatch');
});
test('policy comparison handles normalization and object key ordering, not raw JSON order',()=>{
  const policy=defaultPolicy();delete policy.schedule;delete policy.timeoutMs;delete policy.motherLearning;
  const stored=Object.fromEntries(Object.entries(defaultPolicy()).reverse());
  assert.equal(policyReadback({body:{expectedRevision:1,payload:{policy}}},{revision:2,policy:stored}).state,'matched');
  assert.equal(policyReadback({body:{expectedRevision:1,payload:{}}},{revision:2,policy:stored}).state,'mismatch');
});
