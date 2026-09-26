import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as emotion from '../../engine/emotion.mjs';
import { createEmotionDisplay } from '../../engine/emotion-display.mjs';
import { acceptEmotionSnapshot, emotionConnectionStatus, createEmotionReceiver } from '../../frontend/src/lib/emotion-snapshot.mjs';

test('display is non-consuming, private and versioned; legacy consumption remains', () => {
  emotion.init(fs.mkdtempSync(path.join(os.tmpdir(), 'companion-emotion-')));
  const display = createEmotionDisplay({ peek: emotion.peekLatestObservation, serverEpoch: 'test' });
  assert.equal(display.read().status, 'unavailable');
  emotion.updateEmotion('display-session', '快点，我赶时间 private path');
  const a = display.read(), b = display.read();
  assert.deepEqual(a.state, b.state);
  assert.equal(a.revision, b.revision);
  assert.equal(a.scope, 'global-latest');
  assert.ok(a.state.tags.includes('user_urgent'));
  assert.ok(!JSON.stringify(a).includes('private path'));
  assert.ok(!JSON.stringify(a).includes('display-session'));
  assert.ok(emotion.getSnapshot('display-session').tags.includes('user_urgent'));
  assert.deepEqual(emotion.getSnapshot('display-session').tags, []);
  assert.deepEqual(display.read().state.tags, a.state.tags, 'display tags survive legacy consumers');
  emotion.clearEmotion('display-session');
});

test('historical timestamp is preserved and malicious labels are removed', () => {
  let observation = { source: 'private', observedAt: 1000, sourceKind: 'historical', state: {
    valence: .3, arousal: .4, dominance: .5, intensity: .2,
    primary: '<secret>', secondary: 'happy', tags: ['user_urgent','private path'], residue: { last_event: 'private path' },
  } };
  let now = 2000;
  const display = createEmotionDisplay({ peek: () => observation, now: () => now, serverEpoch: 'a' });
  const a = display.read(); now = 3000;
  assert.equal(display.read().revision, a.revision);
  assert.equal(a.observedAt, 1000);
  assert.equal(a.status, 'historical');
  assert.equal(a.state.primary, null);
  assert.deepEqual(a.state.tags, ['user_urgent']);
  observation = { ...observation, source: 'other' };
  assert.equal(display.read().revision, a.revision + 1);
});

test('ordering ignores late responses and connection freshness is separate from observation age', () => {
  const current = { serverEpoch: 'a', revision: 4, servedAt: 2000, status: 'historical' };
  assert.equal(acceptEmotionSnapshot(current, { ...current, revision: 3 }), current);
  assert.equal(acceptEmotionSnapshot(current, { ...current, serverEpoch: 'b' }), current);
  assert.equal(acceptEmotionSnapshot(current, { ...current, serverEpoch: 'b' }, true).serverEpoch, 'b');
  assert.equal(emotionConnectionStatus(current, 62001), 'stale');
  assert.equal(emotionConnectionStatus(current, 3000), 'historical');
});

test('late GET cannot revert an epoch; freshness uses the receiving device clock', () => {
  const receiver = createEmotionReceiver();
  const old = receiver.begin(), fresh = receiver.begin();
  const b = { serverEpoch: 'b', revision: 1, servedAt: 999999999, status: 'observed' };
  receiver.receive(fresh, b, 1000);
  assert.equal(receiver.receive(old, { ...b, serverEpoch: 'a' }, 2000), b);
  assert.equal(receiver.read().receivedAt, 1000);
  assert.equal(emotionConnectionStatus(b, 62000, 1000), 'stale');
});

test('probe and synthetic states never become observations; persisted history retains age', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-history-'));
  emotion.init(root);
  emotion.getSnapshot('synthetic');
  emotion.updateEmotion('eval-probe', '快点');
  emotion.updateFromOutput('unobserved', 'hello');
  assert.equal(emotion.peekLatestObservation(), null);
  fs.mkdirSync(path.join(root, '记忆'), { recursive: true });
  fs.writeFileSync(path.join(root, '记忆/情绪潮汐.jsonl'), JSON.stringify({ ts: '2026-09-01T00:00:00Z', key: 'old', v: .2, a: .3, d: .4, p: 'calm', i: .2 }) + '\n');
  const observation = emotion.peekLatestObservation();
  assert.equal(observation.sourceKind, 'historical');
  assert.equal(observation.observedAt, Date.parse('2026-09-01T00:00:00Z'));
});
