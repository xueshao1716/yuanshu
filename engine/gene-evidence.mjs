// Integrity/provenance checks, not an assertion that the source's claims are true.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { driftEvidence } from './gene-observations.mjs';

export function verifyGeneEvidence(root, proposal, observations, gene) {
  const refs = proposal.evidence;
  if (!Array.isArray(refs) || !refs.length || refs.length > 32) return false;
  const eventRefs = refs.filter(ref => typeof ref === 'string' && ref.startsWith('gene-event:'));
  const ids = new Set(eventRefs.map(ref => ref.split(' ')[0].slice('gene-event:'.length)));
  const selected = (observations.events || []).filter(event => ids.has(event.id));
  const from = Math.min(...selected.map(event => event.at));
  const to = Math.max(...selected.map(event => event.at));
  const span = { events: (observations.events || []).filter(event => event.at >= from && event.at <= to) };
  const events = driftEvidence(span, proposal.gene, gene);
  // An automatic proposal must retain the complete qualified time span.
  if (eventRefs.length && (new Set(eventRefs).size !== eventRefs.length || eventRefs.length < 3 || !events.length ||
    !eventRefs.includes(events[0]) || !eventRefs.includes(events.at(-1)))) return false;
  return refs.every(ref => {
    if (typeof ref !== 'string' || ref.length > 4096) return false;
    if (ref.startsWith('gene-event:')) return events.includes(ref);
    const match = /^source-file:(.+) sha256:([a-f0-9]{64})$/.exec(ref);
    if (!match) return false;
    try {
      const relative = match[1].replaceAll('\\', '/');
      if (path.isAbsolute(relative) || /^[a-z]:/i.test(relative) || relative.split('/').some(p => p.startsWith('.') || p.includes(':'))) return false;
      if (!/\.(md|txt|jsonl|json)$/i.test(relative)) return false;
      const base = fs.realpathSync(root);
      const file = fs.realpathSync(path.resolve(base, relative));
      const local = path.relative(base, file);
      if (local.startsWith('..') || path.isAbsolute(local)) return false;
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size === 0 || stat.size > 2 * 1024 * 1024) return false;
      return createHash('sha256').update(fs.readFileSync(file)).digest('hex') === match[2];
    } catch { return false; }
  });
}
