import {clonePayload, advanceRecord} from './state.mjs';
import {randomUUID} from 'node:crypto';
import {controlData} from './control-state.mjs';
import {commandKinds, transition} from './control-transition.mjs';
import {reconcileInitialState} from './control-sync.mjs';

export function createCultivationControls({store, authority, now = Date.now, verifyAsset}) {
  const read = () => {const row = store.read('control'); return {...row, data: controlData(row)};};
  const execute = async (input, principal) => {
    const c = clonePayload(input), kinds = commandKinds(c);
    const authenticate = () => {
      if (!authority) throw new Error('cultivation_identity_unavailable');
      const actor = authority.assert(principal, c, kinds);
      if (actor.workspace !== store.workspace) throw new Error('cultivation_identity_denied');
      return actor;
    };
    const actor = authenticate();
    const existingReceipt = row => {
      const found = row.data.receipts.find(r => r.id === c.requestId);
      if (!found) return null;
      if (found.commandHash !== actor.commandHash || found.actor.actorId !== actor.actorId ||
          found.actor.kind !== actor.kind || found.actor.originId !== actor.originId)
        throw new Error('cultivation_idempotency_conflict');
      return found;
    };
    const finish = async receipt => {
      // A failed second-file write reports an error; retry uses this receipt and
      // the same intent, never re-registers a child or executes a model call.
      if (c.action === 'agent.register') await reconcileInitialState(store);
      return structuredClone(receipt);
    };
    const base = store.read('control'), before = {...base, data: controlData(base)};
    const retry = existingReceipt(before);
    if (retry) {authenticate(); return finish(retry);}
    if (before.revision !== c.expectedRevision) throw new Error('cultivation_revision_conflict');
    const context = {now, verifyAsset, entityId: randomUUID(), intentId: randomUUID()};
    const result = transition(before.data, c, actor, context);
    const receipt = {id: c.requestId, actor, commandHash: actor.commandHash,
      revision: before.revision + 1, result};
    before.data.receipts.push(receipt);
    controlData(advanceRecord(base, before.data,
      {actor: `${actor.kind}:${actor.actorId}`, action: c.action, at: new Date(now()).toISOString()}));
    try {
      await store.commit('control', {expectedRevision: c.expectedRevision,
        actor: `${actor.kind}:${actor.actorId}`, action: c.action, data: before.data}, {guard: locked => {
        authenticate();
        // Policy expiry and asset revocation may change while waiting for lock.
        transition(controlData(locked), c, actor, context);
        return true;
      }});
    } catch (error) {
      if (error.message !== 'cultivation_revision_conflict') throw error;
      authenticate();
      const concurrent = existingReceipt(read());
      if (!concurrent) throw error;
      return finish(concurrent);
    }
    return finish(receipt);
  };
  return Object.freeze({read, execute, reconcile: () => reconcileInitialState(store)});
}
