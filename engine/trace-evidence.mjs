// Verification is evidence about an attempt, never a second attempt.
export function evidenceNodes(trace) {
  const out = [];
  for (const raw of trace?.nodes || []) {
    const n = { ...raw };
    if (n.action === '独立验证') {
      const target = n.parent ? out.find(x => x.id === n.parent) : out.at(-1);
      if (target) {
        target.cost = (Number(target.cost) || 0) + (Number(n.cost) || 0);
        target.score = n.outcome === 'PASS' ? 1 : 0;
        target.outcome = n.outcome;
        target.verification = n.outcome;
        target.terminal = true;
      }
      continue;
    }
    if (trace?.kind === 'fix-attempt') {
      n.score = 0;
      if (n.outcome === 'done') n.outcome = 'UNVERIFIED';
    }
    out.push(n);
  }
  return out;
}

export function verifiedSkillEpisode(ep) {
  const v = ep?.verification;
  return Boolean(ep?.runId && v?.verdict === 'PASS' &&
    ['human', 'independent'].includes(v.source) && v.reference && v.skillValidated === true);
}
