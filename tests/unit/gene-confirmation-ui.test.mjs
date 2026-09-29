import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const chat = fs.readFileSync(new URL('../../frontend/src/components/ChatArea.tsx', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../../frontend/src/api.ts', import.meta.url), 'utf8');

test('session subscription admits confirmation events while chat is idle', () => {
  const filter = api.split('\n').find(line => line.includes('dataLines.length') && line.includes('eventType'));
  assert.ok(filter.includes("'confirm'"), 'session SSE must not discard confirmation events');
  const subscription = chat.slice(chat.indexOf('const off = streamSession(currentSessionId'), chat.indexOf('return () => { alive = false; off()'));
  assert.ok(subscription.includes("event?.type === 'confirm'"));
  assert.ok(subscription.indexOf("event?.type === 'confirm'") < subscription.indexOf('if (!primed) return'), 'unexpired cards must also survive subscription replay');
  assert.ok(subscription.includes("data?.toolName === 'gene-governance'"));
  assert.ok(subscription.includes('data.sessionId === currentSessionId'));
  assert.ok(subscription.includes('data.expiresAt > Date.now()'), 'expired replay must not reopen a card');
  assert.ok(subscription.includes('setConfirm('));
});

test('gene confirmation publishes a deadline and clears expired cards', () => {
  const approval = fs.readFileSync(new URL('../../engine/gene-approval.mjs', import.meta.url), 'utf8');
  const emit = approval.split('\n').find(line => line.includes("push(sessionId, 'confirm'"));
  assert.ok(emit.includes('expiresAt'));
  assert.ok(chat.includes('confirm?.expiresAt'));
  assert.ok(chat.includes('confirm.expiresAt - Date.now()'));
});
