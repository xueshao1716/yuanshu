import {clonePayload, validScope} from './state.mjs';
import {defaultPolicy, validatePolicy} from './policy.mjs';
import {validateDesign, assertNoExpansion} from './designs.mjs';

export const id = v => v !== 'control' && validScope(v);
export const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const fail = () => {throw new Error('cultivation_invalid_control');};
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const label = v => typeof v === 'string' && v.length > 0 && v.length <= 120 && !/[\x00-\x1f]/.test(v);
const actor = (v, workspace) => exact(v, ['actorId', 'originId', 'kind', 'workspace', 'commandHash']) &&
  label(v.actorId) && label(v.originId) && ['human', 'mother'].includes(v.kind) &&
  v.workspace === workspace && hash(v.commandHash);
export const emptyControl = () => ({policy: defaultPolicy(), designs: [], agents: [], intents: [], receipts: []});

export function controlData(record) {
  if (record.revision === 0) return emptyControl();
  const d = clonePayload(record.data);
  if (!exact(d, ['policy', 'designs', 'agents', 'intents', 'receipts'])) fail();
  try {validatePolicy(d.policy);} catch {fail();}
  for (const key of ['designs', 'agents', 'intents', 'receipts']) {
    if (!Array.isArray(d[key]) || d[key].length > 256) fail();
    const ids = d[key].map(r => r?.id);
    if (ids.some(v => !id(v)) || new Set(ids).size !== ids.length) fail();
  }
  const designs = new Map();
  for (const row of d.designs) {
    if (!exact(row, ['id', 'parentId', 'author', 'design']) || !actor(row.author, record.workspace) ||
        row.author.kind !== 'mother' || row.parentId !== null && !designs.has(row.parentId)) fail();
    try {validateDesign(row.design);} catch {fail();}
    if (row.parentId !== null) {
      const parent = designs.get(row.parentId);
      if (parent.author.actorId !== row.author.actorId) fail();
      // Historical designs may contain a previously authorized remote flag;
      // current policy gates new revisions, while state replay must remain
      // able to read the already committed lineage.
      try {assertNoExpansion(row.design, parent.design, {allowRemoteExpansion:true});} catch {fail();}
    }
    designs.set(row.id, row);
  }
  for (const a of d.agents) {
    if (!exact(a, ['id', 'mentorId', 'designId', 'history', 'status', 'dispatchAllowed', 'cancellation']) ||
        !label(a.mentorId) || !designs.has(a.designId) || !Array.isArray(a.history) ||
        a.history.length < 1 || a.history.some(v => !designs.has(v)) || a.history.at(-1) !== a.designId ||
        !['ready', 'paused', 'archived'].includes(a.status) || a.dispatchAllowed !== false ||
        !['not_requested', 'pending_confirmation'].includes(a.cancellation) ||
        a.status !== 'ready' && a.cancellation !== 'pending_confirmation') fail();
    for (const [index, designId] of a.history.entries()) {
      const current = designs.get(designId), previous = designs.get(a.history[index - 1]);
      if (current.author.actorId !== a.mentorId) fail();
      if (!index) continue;
      if (current.parentId !== previous.id && !a.history.slice(0, index).includes(designId)) fail();
      try {assertNoExpansion(current.design, previous.design, {allowRemoteExpansion:true});} catch {fail();}
    }
  }
  const agents = new Map(d.agents.map(a => [a.id, a]));
  if (d.intents.length !== d.agents.length || new Set(d.intents.map(i => i.agentId)).size !== d.agents.length) fail();
  for (const intent of d.intents) {
    if (!exact(intent, ['id', 'agentId', 'designId']) || !agents.has(intent.agentId) ||
        intent.designId !== agents.get(intent.agentId).history[0]) fail();
  }
  if (d.receipts.length !== record.revision) fail();
  for (const [index, r] of d.receipts.entries()) {
    if (!exact(r, ['id', 'actor', 'commandHash', 'revision', 'result']) ||
        !actor(r.actor, record.workspace) || r.commandHash !== r.actor.commandHash ||
        r.revision !== index + 1 || !exact(r.result, ['id']) ||
        r.result.id !== 'control' && !id(r.result.id)) fail();
  }
  receiptLinks(record, d, designs, agents);
  return d;
}

function receiptLinks(record, data, designs, agents) {
  const createdDesigns = new Set(), createdAgents = new Set();
  for (const [index, receipt] of data.receipts.entries()) {
    const event = record.audit[index], source = receipt.actor, resultId = receipt.result.id;
    if (!event || event.actor !== `${source.kind}:${source.actorId}`) fail();
    if (event.action === 'policy.set') {
      if (source.kind !== 'human' || resultId !== 'control') fail();
    } else if (['design.submit', 'design.revise'].includes(event.action)) {
      const row = designs.get(resultId);
      if (!row || createdDesigns.has(resultId) || source.kind !== 'mother' ||
          Object.keys(source).some(k => source[k] !== row.author[k]) ||
          (event.action === 'design.submit') !== (row.parentId === null) ||
          row.parentId !== null && !createdDesigns.has(row.parentId)) fail();
      createdDesigns.add(resultId);
    } else {
      const row = agents.get(resultId);
      const mother = ['agent.register', 'agent.adopt'].includes(event.action);
      if (!row || !['agent.register', 'agent.adopt', 'agent.pause', 'agent.resume', 'agent.archive', 'agent.rollback']
        .includes(event.action) || source.kind !== (mother ? 'mother' : 'human') ||
          mother && source.actorId !== row.mentorId) fail();
      if (event.action === 'agent.register') {
        if (createdAgents.has(resultId) || !createdDesigns.has(row.history[0])) fail();
        createdAgents.add(resultId);
      } else if (!createdAgents.has(resultId)) fail();
    }
  }
  if (createdDesigns.size !== designs.size || createdAgents.size !== agents.size) fail();
}
