// Read-only projection of already-associated records; never a source recheck.
export function experienceObservation(run, job) {
  const lineage = {
    agentId: run.cultivation.agentId,
    designId: run.cultivation.designId ?? null,
    runId: run.id,
    knowledgeJobId: run.cultivation.knowledgeJobId,
  };
  if (job?.resolution) {
    lineage.resolutionJobId = job.resolution.jobId;
    lineage.entryId = job.resolution.entryId;
  }
  const latest = new Map();
  // The ledger's append order is authoritative, not wall-clock timestamps.
  for (const row of job?.learning ?? []) latest.set(row.scope, {
    scope: row.scope, decision: row.decision, version: row.version,
    at: row.at, entryId: row.entryId, actor: {kind: row.actor?.kind ?? null},
  });
  return {
    lineage, linkState: job ? 'linked' : 'invalidated',
    generatedRole: 'model_generated', resolutionRecorded: !!job?.resolution,
    sourceCurrent: 'not_checked', latestDecisions: [...latest.values()],
    userAcceptance: null,
  };
}
