import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = file => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
test('team controls expose scoped stop/resume with error and duplicate-submit handling', () => {
  const controls = read('frontend/src/components/TeamRunControls.tsx');
  for (const term of ['TeamRunApi.stop', 'TeamRunApi.resume', 'disabled={busy}', 'role="alert"', '不会自动重跑', '停止后续步骤']) assert.ok(controls.includes(term), term);
  const server = read('server.mjs');
  assert.ok(server.includes('signal: controller.signal'));
  assert.ok(server.includes("res.off('close', onClose)"));
});
test('server delegates to repository launcher and exposes independent launch state', () => {
  const source = read('server.mjs');
  assert.ok(source.includes('createTeamLauncher({ wsRoot: CONFIG.cwd'));
  assert.ok(source.includes('teamApi.start(res, req,'));
  assert.ok(source.includes('if (isTeamRequest(body))'));
  assert.ok(source.includes('createTeamChat({'));
  assert.ok(source.includes('getLaunch: () => teamLauncher.status()'));
  assert.ok(!source.includes('ageMs < 20 * 60 * 1000'));
  assert.ok(!source.includes('node 工程/多AI角色扮演系统/scripts/team-run.mjs'));
});

test('team entry starts a managed session task and links back to conversation', () => {
  const source = read('frontend/src/components/TeamRunStart.tsx');
  for (const term of ['TeamRunApi.start', 'clientRequestId', 'disabled={busy', 'maxLength={300}', '10 秒', 'selectSession', "nav('chat')"]) assert.ok(source.includes(term), term);
  assert.ok(read('frontend/src/components/TeamRunView.tsx').includes('<TeamRunStart'));
  assert.ok(read('frontend/src/components/TeamRunStatus.tsx').includes('launch?.sessionId'));
  const chat = read('frontend/src/components/ChatArea.tsx');
  assert.ok(chat.includes('RunApi.overview(currentSessionId)'));
  assert.ok(chat.includes("case 'subagent_started':"));
});
test('runner snapshot associates launch and never assumes external role dependencies', () => {
  const source = read('scripts/team-run-live.mjs');
  assert.ok(source.includes('launchId: process.env.YUANSHU_TEAM_LAUNCH_ID'));
  assert.ok(source.includes("profile: { id: 'yuanshu-video-legacy', version: '2' }"));
  assert.ok(!source.includes('label}-retry'));
  assert.ok(source.includes('uncertain stage:'));
});
test('view separates launch from historical snapshot and draft from acceptance', () => {
  const source = read('frontend/src/components/TeamRunView.tsx');
  assert.ok(source.includes('<TeamRunStatus launch={data?.launch}'));
  assert.ok(!source.includes('node 工程/多AI角色扮演系统/scripts/team-run.mjs'));
  assert.ok(source.includes("run.mode === 'dry-run'"));
  const status = read('frontend/src/components/TeamRunStatus.tsx');
  for (const term of ['launch?.status', 'profile', 'delivery', '待审区', '不是本次启动的结果', '未知']) assert.ok(status.includes(term), term);
});

test('video and final prompts request the fields their own checklist reviews', () => {
  const source = read('scripts/team-run-live.mjs');
  for (const name of ['VIDEO:', 'ARBIT_FINAL:']) {
    const line = source.split('\n').find(line => line.trimStart().startsWith(name));
    for (const field of ['consistencyKey', 'negative', 'aspect', 'text_handling']) assert.ok(line.includes(`"${field}"`), `${name} ${field}`);
    assert.ok(!line.includes('不要 bgm/negative/platform'));
  }
});
