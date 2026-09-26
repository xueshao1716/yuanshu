// Share identical interactions; a disconnect only releases its own subscription.
export function coalesceCompanionRequests(run) {
  const pending = new Map();
  return function decide(input, signal) {
    if (signal?.aborted) return Promise.resolve({ status: 'cancelled' });
    const key = JSON.stringify([input?.sessionId, input?.contextEpoch, input?.interactionId]);
    let entry = pending.get(key);
    if (!entry) {
      const controller = new AbortController();
      entry = { controller, users: 0, settled: false };
      pending.set(key, entry);
      entry.promise = Promise.resolve().then(() => run(input, controller.signal)).finally(() => {
        entry.settled = true;
        if (pending.get(key) === entry) pending.delete(key);
      });
    }
    entry.users++;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (callback, result) => {
        if (finished) return;
        finished = true; signal?.removeEventListener('abort', abort);
        entry.users--;
        if (!entry.users && !entry.settled) {
          entry.controller.abort();
          if (pending.get(key) === entry) pending.delete(key);
        }
        callback(result);
      };
      const abort = () => finish(resolve, { status: 'cancelled' });
      signal?.addEventListener('abort', abort, { once: true });
      entry.promise.then(value => finish(resolve, value), error => finish(reject, error));
      if (signal?.aborted) abort();
    });
  };
}
