import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = p => fs.readFileSync(new URL('../../frontend/src/' + p, import.meta.url), 'utf8');
test('expanded tide uses the parent shared snapshot and a portrait, never cartoon or invented measurements', () => {
  const chat = read('components/ChatArea.tsx');
  assert.ok(chat.includes('<MoodPanel'), 'tide must open the linked portrait panel');
  assert.ok(chat.includes('emotion={companionEmotion}'));
  const panel = read('components/MoodPanel.tsx');
  assert.ok(panel.includes('PortraitState'));
  assert.ok(!panel.includes('XiaoyuAvatar'));
  assert.ok(!panel.includes('useCompanion('));
  assert.ok(panel.includes('typeof value === \'number\''));
  assert.ok(panel.includes("'暂无'"));
  assert.ok(panel.includes('observedAt'));
  assert.ok(panel.includes('showModal()'));
  assert.ok(panel.includes('onCancel='));
});
test('tide and widget receive a single parent-owned behavior controller', () => {
  const chat = read('components/ChatArea.tsx');
  const widget = read('components/XiaoyuWidget.tsx');
  const panel = read('components/MoodPanel.tsx');
  assert.ok(chat.includes('useCompanion(!companionHidden || orbPanelOpen)'));
  assert.ok(chat.includes('action={companion.action}'));
  assert.ok(chat.includes('<XiaoyuWidget companion={companion}'));
  assert.ok(!widget.includes('useCompanion(!hidden)'));
  assert.ok(panel.includes('<PortraitState action={action}'));
});
