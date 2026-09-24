import test from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../../scripts/live-eval-team-result.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});

test('successful model review proves the team pipeline, not content acceptance', () => {
  assert.equal(typeof mod.teamLiveOutcome, 'function');
  // The live sample passed model review while still promising two dishes after a cut to one.
  const outcome = mod.teamLiveOutcome({ status: 'completed', reviewable: true, assistantMessages: 1, issues: [] });
  assert.equal(outcome.pipelinePassed, true);
  assert.equal(outcome.contentQualityPassed, null);
  assert.equal(outcome.humanAccepted, false);
  assert.equal(outcome.scope, 'real_model_text_pipeline_not_content_acceptance');
});

test('missing, failed or inconsistent pipeline facts cannot pass', () => {
  assert.equal(typeof mod.teamLiveOutcome, 'function');
  for (const input of [{}, { status: 'failed', reviewable: true, assistantMessages: 1, issues: [] },
    { status: 'completed', reviewable: false, assistantMessages: 1, issues: [] },
    { status: 'completed', reviewable: true, assistantMessages: 2, issues: [] },
    { status: 'completed', reviewable: true, assistantMessages: 1, issues: ['evidence changed'] }]) {
    assert.equal(mod.teamLiveOutcome(input).pipelinePassed, false);
  }
});

test('caller or model supplied approval flags never become human acceptance', () => {
  assert.equal(typeof mod.teamLiveOutcome, 'function');
  const outcome = mod.teamLiveOutcome({ status: 'completed', reviewable: true, assistantMessages: 1,
    issues: [], humanAccepted: true, contentQualityPassed: true, pass: true });
  assert.equal(outcome.humanAccepted, false);
  assert.equal(outcome.contentQualityPassed, null);
});
