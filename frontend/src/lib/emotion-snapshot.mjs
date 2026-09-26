export function acceptEmotionSnapshot(current, next, authoritative = false) {
  if (!next || typeof next.serverEpoch !== 'string' || !Number.isSafeInteger(next.revision) || next.revision < 0 || !Number.isFinite(next.servedAt)) return current;
  if (!current) return authoritative ? next : current;
  if (current.serverEpoch !== next.serverEpoch) return authoritative ? next : current;
  if (next.revision < current.revision || next.revision === current.revision && next.servedAt < current.servedAt) return current;
  return next;
}
export function emotionConnectionStatus(snapshot, now = Date.now(), receivedAt = snapshot?.servedAt) {
  if (!snapshot) return 'unavailable';
  if (!Number.isFinite(receivedAt) || now - receivedAt > 60000) return 'stale';
  return snapshot.status;
}
// Old in-flight GETs must not restore a previous server epoch.
export function createEmotionReceiver() {
  let issued = 0, applied = 0, value = null, receivedAt = null;
  return {
    begin: () => ++issued,
    receive(ticket, snapshot, now = Date.now()) {
      if (ticket < applied) return value;
      const accepted = acceptEmotionSnapshot(value, snapshot, true);
      if (accepted === snapshot) { applied = ticket; value = snapshot; receivedAt = now; }
      return value;
    },
    read: () => ({ value, receivedAt }),
  };
}
