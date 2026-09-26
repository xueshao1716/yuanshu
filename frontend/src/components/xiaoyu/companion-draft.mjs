const KEY = 'yuanshu-companion-draft';
export function queueDraft(storage, sessionId, text, now = Date.now()) {
  if (!sessionId || typeof text !== 'string' || !text.trim() || text.length > 500) return false;
  try { storage.setItem(KEY, JSON.stringify({ sessionId, text: text.trim(), at: now })); return true; } catch { return false; }
}
export function takeDraft(storage, sessionId, now = Date.now()) {
  try {
    const value = JSON.parse(storage.getItem(KEY) || 'null');
    if (!value) return null;
    if (!Number.isFinite(value.at) || now - value.at > 300000 || now < value.at) { storage.removeItem(KEY); return null; }
    if (!sessionId || value.sessionId !== sessionId) return null;
    storage.removeItem(KEY);
    return typeof value.text === 'string' && value.text.length <= 500 ? value.text : null;
  } catch { return null; }
}
export function mergeDraft(existing, next) { return existing ? `${existing}\n${next}` : next; }
