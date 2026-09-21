/** Explicit profile semantics only; unknown versions and stages are not inferred. */
export function stageMeaning(profileId, profileVersion, stageKey) {
  if (profileId !== 'multi-ai' || stageKey !== 'S8.5') return null
  if (profileVersion === '20.0') return 'finalize'
  if (profileVersion === '25.0') return 'feedback'
  return null
}

/**
 * Pure semantic decision, not an authorization boundary or evidence authenticator.
 * Evidence and acceptance use artifactDigest to bind to the current artifact.
 */
export function deliveryDecision(input) {
  if (input?.execution !== 'completed') return 'not_ready'
  const { artifactDigest, evidence, acceptance } = input
  if (typeof artifactDigest !== 'string' || !artifactDigest.trim()) return 'missing_artifact'
  if (evidence?.source !== 'runtime' || evidence.artifactDigest !== artifactDigest) return 'unverified'
  if (evidence.passed === false) return 'quality_failed'
  if (evidence.passed !== true) return 'unverified'
  if (acceptance?.status === 'rejected') return 'rejected'
  if (acceptance?.status !== 'accepted') return 'awaiting_acceptance'
  if (acceptance.artifactDigest !== artifactDigest) return 'acceptance_stale'
  return 'ready_to_publish'
}
