import {controlData} from './control-state.mjs';

// Control intents commit first. Child files only hold isolated initial data;
// lifecycle and current design ALWAYS come from the control authority.
export async function reconcileInitialState(store) {
  const data = controlData(store.read('control'));
  for (const intent of data.intents) {
    const check = row => {
      if (row.data.initializationId !== intent.id || row.data.initialDesignId !== intent.designId)
        throw new Error('cultivation_initialization_conflict');
    };
    const existing = store.read(intent.agentId);
    if (existing.revision) {check(existing); continue;}
    try {
      await store.commit(intent.agentId, {expectedRevision: 0, actor: 'service:cultivation',
        action: 'agent.initialize', data: {initializationId: intent.id, initialDesignId: intent.designId,
          layers: {stable: {}, temporary: {}, knowledgeRefs: []}}});
    } catch (error) {
      if (error.message !== 'cultivation_revision_conflict') throw error;
      check(store.read(intent.agentId));
    }
  }
  return {initialized: data.intents.length};
}
