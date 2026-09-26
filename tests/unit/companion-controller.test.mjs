import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(new URL('../../frontend/src/' + path, import.meta.url), 'utf8');

test('companion status uses shared authenticated remote API and no global task poll', () => {
  const source = read('components/xiaoyu/useWidgetStatus.ts');
  assert.ok(source.includes("import { api } from '../../api'"));
  assert.ok(!source.includes('fetch('));
  assert.ok(!source.includes('/api/tasks'));
});
test('emotion cache and receiver are scoped to server and authentication', () => {
  const source = read('lib/useXiaoyuEmotion.ts');
  assert.ok(source.includes('[EMO_LIVE_KEY, base, token]'));
  assert.ok(source.includes('useMemo(() => createEmotionReceiver(), [base, token])'));
  assert.ok(source.includes('authed ?'));
  assert.ok(!source.includes('mutate(EMO_LIVE_KEY)'));
});
test('companion invalidates stale interactions on stream disconnect and bounds bubbles', () => {
  const source = read('components/xiaoyu/useCompanion.ts');
  assert.ok(source.includes('isConversationEvent(ev)'));
  assert.ok(source.includes('const invalidate = () =>'));
  assert.ok(source.includes('abort.current?.abort()'));
  const widget = read('components/XiaoyuWidget.tsx');
  assert.ok(widget.includes('style={panelPosition(motion.position, motion.view, 200)}'));
});

test('companion facts preferences and context are scoped to the API server', () => {
  const source = read('components/xiaoyu/useCompanion.ts');
  assert.ok(source.includes("['companion-facts', sessionId, base, token]"));
  assert.ok(source.includes("['companion-preferences', base, token]"));
  assert.ok(source.includes('[sessionId, base, token, active, messageEpoch]'));
});
