import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const file = new URL('../../scripts/team-checklist.mjs', import.meta.url);
test('checklist normalization exists independently of paid runner', () => assert.ok(fs.existsSync(file)));
test('only explicit, unique boolean passes with no reported issue count', async () => {
  const { normalizeChecklist } = await import(file.href);
  const specs = ['V-01', 'V-02', 'V-03', 'V-04', 'V-05'].map(id => ({ id }));
  const got = normalizeChecklist(specs, [{id:'V-01',pass:true}, {id:'V-02',pass:'true'}, {id:'V-03',pass:true}, {id:'V-03',pass:true}, {id:'V-04',pass:true}, {id:'OTHER',pass:true}], [{where:'V-04 镜头2',severity:'block'}]);
  assert.deepEqual(got.map(i => i.pass), [true,false,false,false,false]);
  assert.equal(got[4].status, 'unverified');
  assert.equal(got.length, 5);
});
test('missing and failed reviewer cannot manufacture passing checks', async () => {
  const { normalizeChecklist } = await import(file.href);
  const specs = [{id:'V-01'}, {id:'V-02'}];
  assert.ok(normalizeChecklist(specs, [], []).every(i => i.pass === false));
  assert.ok(normalizeChecklist(specs, [{id:'V-01',pass:true}], [], false).every(i => i.pass === false));
});
test('runner patch uses configured token and evidence-based checklist', () => {
  const runner = fs.readFileSync(new URL('../../scripts/team-run-live.mjs', import.meta.url), 'utf8');
  assert.ok(runner.includes('loadTeamRuntimeConfig()'));
  const config = fs.readFileSync(new URL('../../scripts/team-runtime-config.mjs', import.meta.url), 'utf8');
  assert.ok(config.includes('env.YUANSHU_TOKEN ?? env.PI_WEB_TOKEN'));
  assert.ok(runner.includes('normalizeChecklist(checklistSpec.items'));
  assert.ok(runner.includes('JSON.stringify(checklistSpec.items)'));
  assert.ok(!runner.includes('pass: true, note:'));
});
