import {controlData, id, exact} from './control-state.mjs';

const fail = code => {throw new Error(`cultivation_${code}`);};
export function createCultivationProjection({store}) {
  let cached = null, fingerprint, everExisted = false;
  const current = () => {
    try {
      const before = store.version('control');
      if (before === null && everExisted) fail('state_unreadable');
      if (cached && before === fingerprint) return cached;
      cached = null;
      const record = store.read('control'), data = controlData(record);
      if (store.version('control') !== before) fail('state_changing');
      everExisted ||= before !== null;
      fingerprint = before;
      cached = {record, data};
      return cached;
    } catch (error) {cached = null; throw error;}
  };
  const overview = () => {
    const {record, data} = current();
    return {revision: record.revision, state: data.designs.length ? 'designs_available' : 'waiting_for_design',
      policy: structuredClone(data.policy), agentCount: data.agents.length, designCount: data.designs.length,
      executorAvailable: false, usage: null, observations: 'not_observed'};
  };
  const list = (collection, {limit = 20, cursor = null} = {}) => {
    if (!['agents', 'designs', 'events', 'runs', 'experience'].includes(collection)) fail('collection_not_found');
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail('invalid_pagination');
    const {record, data} = current();
    let offset = 0;
    if (cursor !== null) {
      let decoded;
      try {
        if (typeof cursor !== 'string' || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) fail('invalid_cursor');
        decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      } catch {fail('invalid_cursor');}
      if (!exact(decoded, ['workspace', 'revision', 'collection', 'offset']) ||
          decoded.workspace !== store.workspace || decoded.collection !== collection ||
          !Number.isSafeInteger(decoded.revision) || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0)
        fail('invalid_cursor');
      if (decoded.revision !== record.revision) fail('cursor_stale');
      offset = decoded.offset;
    }
    const supported = collection !== 'runs' && collection !== 'experience';
    const rows = collection === 'events' ? record.audit : data[collection] ?? [];
    if (offset > rows.length) fail('invalid_cursor');
    const end = Math.min(offset + limit, rows.length);
    const nextCursor = end < rows.length ? Buffer.from(JSON.stringify({workspace: store.workspace,
      revision: record.revision, collection, offset: end})).toString('base64url') : null;
    return {revision: record.revision, supported, items: structuredClone(rows.slice(offset, end)), nextCursor};
  };
  const detail = agentId => {
    if (!id(agentId)) fail('invalid_scope');
    const {record, data} = current(), agent = data.agents.find(a => a.id === agentId);
    if (!agent) return null;
    const child = store.read(agentId), intent = data.intents.find(i => i.agentId === agentId);
    if (child.revision && (child.data.initializationId !== intent.id || child.data.initialDesignId !== intent.designId))
      fail('initialization_conflict');
    return {revision: record.revision, agent: structuredClone(agent),
      design: structuredClone(data.designs.find(d => d.id === agent.designId)),
      initialization: child.revision ? 'complete' : 'pending', executorAvailable: false};
  };
  return Object.freeze({overview, list, detail});
}
