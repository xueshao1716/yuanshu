import {validatePolicy, assertRequest} from './policy.mjs';
import {validateDesign, assertAdoptable, assertNoExpansion} from './designs.mjs';
import {exact, id} from './control-state.mjs';

const fields = {'policy.set': ['policy'], 'design.submit': ['design'],
  'design.revise': ['parentId', 'design'], 'agent.register': ['designId'],
  'agent.pause': ['agentId'], 'agent.resume': ['agentId'], 'agent.archive': ['agentId'],
  'agent.adopt': ['agentId', 'designId'], 'agent.rollback': ['agentId', 'designId']};
export function commandKinds(c) {
  if (!exact(c, ['action', 'payload', 'requestId', 'expectedRevision']) || !id(c.requestId) ||
      !Number.isSafeInteger(c.expectedRevision) || c.expectedRevision < 0 ||
      !Object.hasOwn(fields, c.action) || !exact(c.payload, fields[c.action]))
    throw new Error('cultivation_invalid_command');
  for (const key of ['agentId', 'designId', 'parentId'])
    if (Object.hasOwn(c.payload, key) && !id(c.payload[key])) throw new Error('cultivation_invalid_command');
  return ['design.submit', 'design.revise', 'agent.register', 'agent.adopt'].includes(c.action) ? ['mother'] : ['human'];
}
const fail = reason => {throw new Error(`cultivation_${reason}`);};
export function transition(data, c, actor, {now, verifyAsset, entityId, intentId}) {
  const p = c.payload;
  const design = designId => data.designs.find(d => d.id === designId) ?? fail('design_not_found');
  const adopt = (d, agentId) => assertAdoptable(d.design, data.policy, {now: now(), agentId, verifyAsset});
  const envelope = (next, previous) => {
    const remoteExpansion = next.permissions.remote && !previous.permissions.remote;
    assertNoExpansion(next, previous, {allowRemoteExpansion:remoteExpansion});
    if (remoteExpansion) assertRequest(data.policy, next.permissions, now());
  };
  if (c.action === 'policy.set') {data.policy = validatePolicy(p.policy); return {id: 'control'};}
  if (c.action.startsWith('design.')) {
    const d = validateDesign(p.design);
    if (p.parentId) {
      const parent = design(p.parentId);
      if (parent.author.actorId !== actor.actorId) fail('identity_denied');
      envelope(d, parent.design);
    }
    const row = {id: entityId, parentId: p.parentId ?? null, author: actor, design: d};
    data.designs.push(row);
    return {id: row.id};
  }
  if (c.action === 'agent.register') {
    const d = design(p.designId), agentId = entityId;
    if (d.author.actorId !== actor.actorId) fail('identity_denied');
    adopt(d, agentId);
    if (data.agents.filter(a => a.status !== 'archived').length >= data.policy.maxAgents) fail('population_limit');
    data.agents.push({id: agentId, mentorId: actor.actorId, designId: d.id, history: [d.id],
      status: 'ready', dispatchAllowed: false, cancellation: 'not_requested'});
    data.intents.push({id: intentId, agentId, designId: d.id});
    return {id: agentId};
  }
  const a = data.agents.find(a => a.id === p.agentId) ?? fail('agent_not_found');
  if (a.status === 'archived') fail('invalid_transition');
  if (c.action === 'agent.pause' || c.action === 'agent.archive') {
    a.status = c.action === 'agent.pause' ? 'paused' : 'archived';
    a.cancellation = 'pending_confirmation';
  } else if (c.action === 'agent.resume') {
    if (a.status !== 'paused') fail('invalid_transition');
    adopt(design(a.designId), a.id);
    a.status = 'ready';
    a.cancellation = 'not_requested';
  } else {
    if (c.action === 'agent.adopt' && a.mentorId !== actor.actorId) fail('identity_denied');
    const next = design(p.designId), current = design(a.designId);
    if (c.action === 'agent.rollback') {
      if (!a.history.includes(next.id)) fail('design_lineage');
    } else if (next.parentId !== current.id) fail('design_lineage');
    envelope(next.design, current.design);
    adopt(next, a.id);
    a.designId = next.id;
    a.history.push(next.id);
  }
  // Dispatch is decided by the executor's live gates, never this projection.
  a.dispatchAllowed = false;
  return {id: a.id};
}
