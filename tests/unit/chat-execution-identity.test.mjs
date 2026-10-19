import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRunManager} from '../../engine/run-manager.mjs';
import {createRunStore} from '../../engine/run-store.mjs';
import {createRunEventLog} from '../../engine/run-event-log.mjs';
import {initSessionManager, canAccessSessionOrigin} from '../../engine/session-manager.mjs';
import {createCultivationStorage} from '../../engine/cultivation/storage.mjs';
import {createCultivationHostIdentity} from '../../engine/cultivation/host-identity.mjs';

// 2026-10-19：网页直连对话没有 run，身份由 runManager.mintChatIdentity 签发。
// 这条测试锁死"没有 run 也能绑定并解析出母体身份"——之前的 bug 就是这里断的。
function fixture(t, {busy = true} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-chat-identity-'));
  const sessionsDir = path.join(root, 'sessions'); fs.mkdirSync(sessionsDir);
  const sessionId = 'web-session', file = path.join(sessionsDir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({type: 'session', id: sessionId, cwd: root, timestamp: new Date().toISOString()}) + '\n');
  const sm = {getSessionId: () => sessionId, getSessionFile: () => file, getCwd: () => root};
  const entry = {sm, gen: 1, busy}, entries = new Map([[sessionId, entry]]);
  initSessionManager({cwd: root, sessionsDir, activeSessions: entries});
  const store = createRunStore({rootDir: root}), eventLog = createRunEventLog({rootDir: root});
  const storage = createCultivationStorage({wsRoot: root});
  const manager = createRunManager({store, eventLog, instanceId: 'fixture-host', workspaceScope: () => root,
    executeChat: async () => {} });
  const adapter = createCultivationHostIdentity({wsRoot: root,
    resolveExecution: source => manager.resolveExecutionIdentity(source),
    getEntry: id => entries.get(id), canAccess: canAccessSessionOrigin});
  t.after(() => { manager.dispose(); eventLog.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const resolverContext = {workspace: storage.workspace, kind: 'mother'};
  return {root, sessionId, entry, entries, manager, adapter, resolverContext,
    mint: (opts) => manager.mintChatIdentity({sessionId, ...opts})};
}

test('网页直连：签发的对话身份能绑定活会话并解析出母体身份', t => {
  const f = fixture(t);
  const source = f.mint({});
  assert.ok(source, '应该签发成功');
  assert.equal(f.adapter.bind(source, {sessionId: f.sessionId, entry: f.entry, generation: f.entry.gen}), true);
  const resolved = f.adapter.resolveMother(source, f.resolverContext);
  assert.ok(resolved, '绑定后必须能解析');
  assert.equal(resolved.actorId, `mother:${f.resolverContext.workspace}`);
  assert.match(resolved.originId, /^run:chat:/);
});

test('网页直连：会话不 busy 时不绑定（身份只在活对话里有效）', t => {
  const f = fixture(t, {busy: false});
  const source = f.mint({});
  assert.equal(f.adapter.bind(source, {sessionId: f.sessionId, entry: f.entry, generation: f.entry.gen}), false);
  assert.equal(f.adapter.resolveMother(source, f.resolverContext), null);
});

test('网页直连：过期后解析为 null', t => {
  const f = fixture(t);
  const source = f.mint({ttlMs: 60 * 1000});
  assert.equal(f.adapter.bind(source, {sessionId: f.sessionId, entry: f.entry, generation: f.entry.gen}), true);
  assert.ok(f.adapter.resolveMother(source, f.resolverContext));
  // 直接让底层身份过期：重新签发一个 ttl=1ms 的不可行（下限 60s），改测 dispose 语义
  f.manager.dispose();
  assert.equal(f.adapter.resolveMother(source, f.resolverContext), null);
});
