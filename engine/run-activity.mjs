import fs from 'node:fs';
import path from 'node:path';

const ACTIVE = new Set(['queued', 'running', 'stopping', 'recovering']);
const fingerprint = s => [s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');

// Display observations only. Admission and recovery still read durable claims
// independently. Keep compact metadata, never full conversation checkpoints.
export function createRunActivityReader(runsDir) {
  const cache = new Map();
  return async () => {
    const names = (await fs.promises.readdir(runsDir)).filter(name => name.endsWith('.json'));
    const present = new Set(names);
    for (const name of cache.keys()) if (!present.has(name)) cache.delete(name);
    const observed = [];
    // Bound disk concurrency; each batch gives the chat event loop a turn.
    for (let offset = 0; offset < names.length; offset += 8) {
      const batch = await Promise.all(names.slice(offset, offset + 8).map(async name => {
        const file = path.join(runsDir, name);
        const stamp = fingerprint(await fs.promises.stat(file, { bigint: true }));
        const cached = cache.get(name);
        if (cached?.stamp === stamp) return cached.activity;
        const run = JSON.parse(await fs.promises.readFile(file, 'utf8'));
        if (!run || typeof run.id !== 'string' || !run.id.trim()
            || typeof run.sessionId !== 'string' || !run.sessionId.trim()
            || typeof run.status !== 'string' || !run.status.trim()) throw new Error('invalid_run_observation');
        if (fingerprint(await fs.promises.stat(file, { bigint: true })) !== stamp) throw new Error('run_changed_during_observation');
        const activity = { id: run.id, sessionId: run.sessionId, status: run.status };
        cache.set(name, { stamp, activity });
        return activity;
      }));
      observed.push(...batch.filter(run => ACTIVE.has(run.status)).map(run => ({ ...run })));
    }
    return observed;
  };
}
