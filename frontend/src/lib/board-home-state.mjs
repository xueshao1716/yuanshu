// The last conversation is the one most recently used, not most recently created.
export function chooseResumeSession(sessions) {
  const time = s => Date.parse(s.updatedAt) || Date.parse(s.createdAt) || 0;
  return sessions.reduce((latest, s) => !latest || time(s) > time(latest) ? s : latest, null);
}
