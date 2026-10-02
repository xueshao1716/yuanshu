// Read-only reconciliation: matching current state is not proof of who wrote it.
const normalized = policy => ({...policy, schedule:policy.schedule??null,
  timeoutMs:policy.timeoutMs??60000,motherLearning:policy.motherLearning??false});
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value==='object'
    ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value;
export function policyReadback(command, overview) {
  if (!Number.isSafeInteger(overview?.revision) || overview.revision<=command.body.expectedRevision)
    return {state:'stale',message:'仍未读到更新后的版本'};
  const intended=command.body.payload?.policy,stored=overview?.policy;
  if (!intended || !stored || JSON.stringify(canonical(normalized(intended)))!==JSON.stringify(canonical(normalized(stored))))
    return {state:'mismatch',message:'设置与本次确认不一致'};
  return {state:'matched',message:`已核对实际设置，当前版本 ${overview.revision}`};
}
