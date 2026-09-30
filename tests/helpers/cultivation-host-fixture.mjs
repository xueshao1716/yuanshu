import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRunManager} from '../../engine/run-manager.mjs';
import {createRunStore} from '../../engine/run-store.mjs';
import {createRunEventLog} from '../../engine/run-event-log.mjs';
import {initSessionManager, canAccessSessionOrigin} from '../../engine/session-manager.mjs';
import {createCultivationStorage} from '../../engine/cultivation/storage.mjs';

export const tick = () => new Promise(resolve => setImmediate(resolve));
export async function hostFixture(t, options = {}) {
  const url = new URL('../../engine/cultivation/host-identity.mjs', import.meta.url);
  assert.ok(fs.existsSync(url), 'cultivation host identity adapter missing');
  const {createCultivationHostIdentity} = await import(url);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-mother-host-'));
  const sessionsDir = path.join(root, 'sessions'); fs.mkdirSync(sessionsDir);
  const sessionId = 'fixture-session', file = path.join(sessionsDir, `${sessionId}.jsonl`);
  const rows = [{type: 'session', id: sessionId, cwd: root, timestamp: new Date().toISOString()}];
  const writeSession = () => fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  writeSession();
  const sm = {getSessionId: () => sessionId, getSessionFile: () => file, getCwd: () => root};
  const entry = {sm, gen: 1, busy: true}, entries = new Map([[sessionId, entry]]);
  initSessionManager({cwd: root, sessionsDir, activeSessions: entries});
  const store = createRunStore({rootDir: root}), eventLog = createRunEventLog({rootDir: root});
  const storage = createCultivationStorage({wsRoot: root});
  let context, release;
  const manager = createRunManager({store, eventLog, instanceId: 'fixture-host', workspaceScope: () => options.runWorkspace ?? root,
    executeChat: async (_req, res, body) => {
      context = body.__runContext; await new Promise(resolve => {release = resolve;}); res.end();
    }});
  t.after(async () => {
    manager.dispose(); release?.(); await tick(); eventLog.close(); fs.rmSync(root, {recursive: true, force: true});
  });
  const adapter = createCultivationHostIdentity({wsRoot: root,
    resolveExecution: manager.resolveExecutionIdentity, getEntry: id => entries.get(id),
    canAccess: options.canAccess ?? canAccessSessionOrigin});
  const run = manager.create({sessionId, clientRequestId: 'fixture-request', message: 'synthetic work',
    backgroundRecovery: false, ...options.body}, options.context);
  for (let n = 0; n < 100 && !context; n++) await tick();
  assert.ok(context, 'host execution did not start');
  const source = context.executionIdentity;
  const binding = {sessionId, entry, generation: entry.gen};
  const resolverContext = {workspace: storage.workspace, kind: 'mother'};
  return {root, rows, writeSession, file, entry, entries, manager, run, adapter, source, binding,
    storage, resolverContext, release: () => release(),
    resolve: () => adapter.resolveMother(source, resolverContext)};
}
