import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {initFileLock} from '../../engine/file-lock.mjs';
import {createCultivationStorage} from '../../engine/cultivation/storage.mjs';
import {createIdentityAuthority} from '../../engine/cultivation/identity.mjs';
import {defaultPolicy} from '../../engine/cultivation/policy.mjs';

export const draft = () => ({name: 'Synthetic character', rationale: 'Test independent learning',
  goals: ['Check a synthetic result'], curriculum: ['Read and test'], temporaryExpression: 'Curious',
  observation: 'Track test evidence', recovery: 'Pause and review',
  appearance: {description: 'Synthetic portrait', asset: null},
  clothing: {description: 'Synthetic coat', asset: null}, voice: {description: 'Synthetic voice', asset: null},
  permissions: {model: 'fixture-model', tools: [], dataScopes: [], remote: false, costUpperBoundCents: 0},
  protectedProposalRefs: []});
export const enabledPolicy = () => ({...defaultPolicy(), enabled: true, dailyRequests: 1,
  models: ['fixture-model'], expiresAt: '2027-01-01T00:00:00.000Z'});
export async function controlFixture(t, extra = {}) {
  const url = new URL('../../engine/cultivation/controls.mjs', import.meta.url);
  if (!fs.existsSync(url)) throw new Error('controls implementation missing');
  const {createCultivationControls} = await import(url);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-cultivation-controls-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  initFileLock({dir: path.join(root, 'locks')});
  const store = createCultivationStorage({wsRoot: root, ...extra.storage});
  const human = {active: true}, mother = {active: true};
  const authority = createIdentityAuthority({workspace: store.workspace,
    resolveHuman: s => s === human && s.active ? {actorId: 'fixture-user', originId: 'fixture-grant'} : null,
    resolveMother: s => s === mother && s.active ? {actorId: 'fixture-mother', originId: 'fixture-run'} : null});
  const controls = createCultivationControls({store, authority, now: () => Date.parse('2026-09-30'), ...extra.controls});
  const command = (action, payload, overrides = {}) => ({action, payload, requestId: randomUUID(),
    expectedRevision: store.read('control').revision, ...overrides});
  const execute = (c, kind = 'human') => controls.execute(c, authority.issue(kind, kind === 'human' ? human : mother, c));
  const register = async () => {
    await execute(command('policy.set', {policy: enabledPolicy()}));
    const submitted = await execute(command('design.submit', {design: draft()}), 'mother');
    const registered = await execute(command('agent.register', {designId: submitted.result.id}), 'mother');
    return {agentId: registered.result.id, designId: submitted.result.id};
  };
  return {root, store, authority, human, mother, controls, command, execute, register};
}
