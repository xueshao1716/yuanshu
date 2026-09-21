import test from 'node:test'
import assert from 'node:assert/strict'
import { stageMeaning, deliveryDecision } from '../../engine/team-delivery-contract.mjs'

const ready = (overrides = {}) => ({
  execution: 'completed',
  artifactDigest: 'sha256:current',
  evidence: { source: 'runtime', artifactDigest: 'sha256:current', passed: true },
  acceptance: { status: 'accepted', artifactDigest: 'sha256:current' },
  ...overrides,
})

test('S8.5 means finalize only for the explicit multi-ai 20.0 profile', () => {
  assert.equal(stageMeaning('multi-ai', '20.0', 'S8.5'), 'finalize')
})

test('S8.5 means feedback only for the explicit multi-ai 25.0 profile', () => {
  assert.equal(stageMeaning('multi-ai', '25.0', 'S8.5'), 'feedback')
})

for (const [profile, version, stage] of [
  ['multi-ai', '26.0', 'S8.5'],
  ['multi-ai', '19.0', 'S8.5'],
  ['unknown', '25.0', 'S8.5'],
  ['multi-ai', '25.0', 'S9'],
  ['multi-ai', 25, 'S8.5'],
  [undefined, undefined, undefined],
]) {
  test(`unknown stage combination returns null: ${profile}/${version}/${stage}`, () => {
    assert.equal(stageMeaning(profile, version, stage), null)
  })
}

test('missing input is not ready', () => {
  assert.equal(deliveryDecision(null), 'not_ready')
  assert.equal(deliveryDecision(), 'not_ready')
})

for (const execution of [undefined, 'queued', 'running', 'failed', 'cancelled']) {
  test(`execution ${execution} is not ready regardless of later gates`, () => {
    assert.equal(deliveryDecision(ready({ execution, artifactDigest: null })), 'not_ready')
  })
}

for (const artifactDigest of [undefined, null, 123, {}, '', ' \t\n']) {
  test(`invalid artifact digest (${JSON.stringify(artifactDigest)}) means missing artifact`, () => {
    assert.equal(deliveryDecision(ready({ artifactDigest, evidence: null })), 'missing_artifact')
  })
}

test('missing verification evidence is unverified', () => {
  assert.equal(deliveryDecision(ready({ evidence: undefined })), 'unverified')
  assert.equal(deliveryDecision(ready({ evidence: null })), 'unverified')
})

for (const source of [undefined, 'model', 'user', 'Runtime']) {
  test(`evidence source ${source} is unverified even when passed`, () => {
    const input = ready()
    input.evidence.source = source
    assert.equal(deliveryDecision(input), 'unverified')
  })
}

test('stale or missing evidence digest is unverified before checking quality', () => {
  for (const artifactDigest of [undefined, 'sha256:old', ' sha256:current ']) {
    assert.equal(deliveryDecision(ready({
      evidence: { source: 'runtime', artifactDigest, passed: false },
    })), 'unverified')
  }
})

test('failed runtime quality takes precedence over acceptance rejection', () => {
  const input = ready({ acceptance: { status: 'rejected' } })
  input.evidence.passed = false
  assert.equal(deliveryDecision(input), 'quality_failed')
})

for (const passed of [undefined, null, 'true', 1, {}, []]) {
  test(`non-boolean passed (${JSON.stringify(passed)}) is unverified`, () => {
    const input = ready()
    input.evidence.passed = passed
    assert.equal(deliveryDecision(input), 'unverified')
  })
}

test('rejected acceptance is rejected even without a current acceptance digest', () => {
  assert.equal(deliveryDecision(ready({ acceptance: { status: 'rejected' } })), 'rejected')
})

for (const acceptance of [undefined, null, {}, { status: 'pending' }, { status: true }]) {
  test(`non-accepted decision (${JSON.stringify(acceptance)}) awaits acceptance`, () => {
    assert.equal(deliveryDecision(ready({ acceptance })), 'awaiting_acceptance')
  })
}

test('accepted decision with stale or missing artifact digest is stale', () => {
  for (const artifactDigest of [undefined, null, 'sha256:old', ' sha256:current ']) {
    assert.equal(deliveryDecision(ready({
      acceptance: { status: 'accepted', artifactDigest },
    })), 'acceptance_stale')
  }
})

test('completed artifact with matching passed runtime evidence and acceptance is ready', () => {
  assert.equal(deliveryDecision(ready()), 'ready_to_publish')
})

test('delivery decisions are deterministic and leave the input unchanged', () => {
  const input = ready()
  const before = structuredClone(input)
  Object.freeze(input.evidence)
  Object.freeze(input.acceptance)
  Object.freeze(input)
  assert.equal(deliveryDecision(input), 'ready_to_publish')
  assert.equal(deliveryDecision(input), 'ready_to_publish')
  assert.deepEqual(input, before)
})
