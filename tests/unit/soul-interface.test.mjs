import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const root = new URL('../../frontend/src/', import.meta.url);
const source = p => fs.existsSync(new URL(p, root)) ? fs.readFileSync(new URL(p, root), 'utf8') : '';
test('soul center is reachable through desktop, mobile and system', () => {
  assert.ok(source('AppLayout.tsx').includes("route: 'soul'"));
  assert.ok(source('nav.ts').includes("soul: '灵魂培养'"));
  assert.ok(source('components/MobileMoreMenu.tsx').includes("route: 'soul'"));
  assert.ok(source('pages/System.tsx').includes('#/soul'));
});
test('soul center reuses live settings and local human approval', () => {
  assert.ok(source('soul/VoiceAppearance.tsx').includes('<SpeechSettings'));
  assert.ok(source('soul/VoiceAppearance.tsx').includes('useCompanionContext'));
  assert.ok(source('soul/Confirmations.tsx').includes('ConfirmApi.answer'));
  assert.ok(source('soul/Confirmations.tsx').includes('canApprove'));
  assert.ok(source('soul/PersonaEditor.tsx').includes('expectedRevision'));
  assert.ok(source('soul/PersonaEditor.tsx').includes('查看差异'));
  assert.ok(!source('soul/LiveSections.tsx').includes('<TeamRunView'));
});

test('supporting sections summarize shared data and link to the real owning pages', () => {
  const live = source('soul/LiveSections.tsx');
  assert.ok(!live.includes('<LearningIntakePanel'));
  assert.ok(live.includes("useSWR('skills'"));
  assert.ok(live.includes("useSWR('aibody-overview'"));
  assert.ok(live.includes('href="#/team"'));
  assert.ok(live.includes('href="#/apps"'));
  assert.ok(live.includes('href="#/review"'));
  assert.ok(source('AppLayout.tsx').includes('initialView="team"'));
  assert.ok(source('AppLayout.tsx').includes("route: 'team'"));
  assert.ok(source('hooks/useHashRoute.tsx').includes("'team'"));
  const voice = source('soul/VoiceAppearance.tsx');
  assert.ok(voice.includes('href="#/chat"'));
  assert.ok(voice.includes('GALLERIES.map'));
  assert.ok(voice.includes('companion.chooseSkin(g.id)'));
  assert.ok(voice.includes('imageForSkin(g.id)'));
  assert.ok(voice.includes('companion.setHidden(!e.target.checked)'));
  assert.ok(!voice.includes('localStorage'), 'use the existing shared stores, not another settings copy');
});

test('only editable sections stay mounted and confirmation polling follows active governance', () => {
  const soul = source('pages/Soul.tsx');
  assert.ok(soul.includes("const draftSections: Section[] = ['identity', 'genes', 'history']"));
  assert.ok(soul.includes('visited.filter(id => id === section || draftSections.includes(id))'));
  assert.ok(soul.includes("active={draftSections.includes(section) || section === 'voice' || busy}"));
  const confirmation = source('soul/Confirmations.tsx');
  assert.ok(confirmation.includes('active && sessionId'));
  assert.ok(confirmation.includes('busy ? 1000 : 10000'));
  assert.ok(confirmation.includes("useSWR('sessions'"));
});
test('persona draft diff ignores metadata and normalizes list lines', async () => {
  assert.ok(source('soul/draft.mjs'), '缺少人格草稿辅助模块');
  const { personaPatch, listLines } = await import(new URL('soul/draft.mjs', root));
  assert.deepEqual(listLines('a\n\n b '), ['a', 'b']);
  assert.deepEqual(personaPatch({name:'old',tone:['a'],updatedAt:'a'}, {name:'new',tone:['a'],updatedAt:'b'}), {name:'new'});
  assert.deepEqual(personaPatch({name:'same'}, {name:'same'}), {});
});
test('multiline draft keeps blank lines while typing and normalizes only for comparison', async () => {
  const { normalizeDraft } = await import(new URL('soul/draft.mjs', root));
  const draft = {name:'name', tone:'first\n\nsecond\n'};
  assert.deepEqual(normalizeDraft(draft), {name:'name', tone:['first','second']});
  assert.equal(draft.tone, 'first\n\nsecond\n');
});

test('dirty persona guards SPA navigation and newly pending confirmation is brought into view', () => {
  assert.ok(source('hooks/useHashRoute.tsx').includes('yuanshu:before-route'));
  assert.ok(source('pages/Soul.tsx').includes('yuanshu:before-route'));
  assert.ok(source('soul/Confirmations.tsx').includes('scrollIntoView'));
  assert.ok(!source('soul/PersonaEditor.tsx').includes('当前实际注入'));
});

test('memory results expose readable content and source before optional raw details', () => {
  assert.ok(source('soul/Memory.tsx').includes('hit.text'));
  assert.ok(source('soul/Memory.tsx').includes('hit.name'));
  assert.ok(source('soul/Overview.tsx').includes('ArrowRight'));
});
