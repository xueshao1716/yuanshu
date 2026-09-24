import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as media from '../../engine/media-embed.mjs';
import { resumePersistenceState, sdkSafeAssistantBlocks } from '../../engine/yuanshu-session.mjs';
const msg = (role, content) => ({ type: 'message', message: { role, content } });
const url = '/api/ws/file?path=' + encodeURIComponent('生成物/图.png');

test('resume recognizes previously persisted SDK-safe media in this user turn', () => {
  const entries = [msg('user', '出图'), msg('assistant', sdkSafeAssistantBlocks([
    { type: 'image', url }, { type: 'audio', url: 'https://media.example/a.mp3' },
    { type: 'video', url: 'https://media.example/v.mp4' },
  ]))];
  const state = resumePersistenceState(entries, '出图', true);
  assert.ok(state.mediaKeys instanceof Set);
  assert.equal(state.mediaKeys.size, 3);
  assert.ok(state.mediaKeys.has(media.mediaDeliveryKey(url)));
  assert.ok(state.mediaKeys.has(media.mediaDeliveryKey('https://media.example/v.mp4')));
});

test('new turns and other user messages do not inherit delivered media', () => {
  const entries = [msg('user', '出图'), msg('assistant', `![图片](${url})`), msg('user', '出图')];
  for (const [message, resume] of [['出图', true], ['别的任务', true], ['出图', false]]) {
    assert.equal(resumePersistenceState(entries, message, resume).mediaKeys?.size, 0);
  }
});

test('media identity normalizes workspace paths but preserves external URL identity', () => {
  assert.equal(typeof media.mediaDeliveryKey, 'function');
  assert.equal(media.mediaDeliveryKey(url + '&token=old'), media.mediaDeliveryKey('生成物/图.png'));
  assert.notEqual(media.mediaDeliveryKey('https://one.example/a.png'), media.mediaDeliveryKey('https://two.example/a.png'));
  assert.notEqual(media.mediaDeliveryKey('https://one.example/a.png?v=1'), media.mediaDeliveryKey('https://one.example/a.png?v=2'));
});

test('media delivery seeds its dedupe set from the persisted turn, not the reuse flag', () => {
  const source = fs.readFileSync(new URL('../../engine/unified-chat.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('new Set(persistedTurn.mediaKeys)'));
  assert.ok(source.includes('mediaDeliveryKey(mr.url)'));
  assert.equal(source.includes('if (mr.__effectReused) continue'), false);
});
