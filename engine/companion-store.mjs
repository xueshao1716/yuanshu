import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from './atomic-io.mjs';
export function createCompanionStore({ root, now = Date.now }) {
  const file = path.join(root, '.yuanshu', 'companion.json');
  const load = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return { dnd: false, history: [] }; }
  };
  const prune = data => (Array.isArray(data.history) ? data.history : []).filter(item => item.at >= now() - 7 * 86400000).slice(-1000);
  return {
    preferences(patch) {
      const data = load();
      if (patch) {
        if (typeof patch.dnd !== 'boolean') throw new Error('invalid_preferences');
        data.dnd = patch.dnd; data.history = prune(data); atomicWriteJson(file, data);
      }
      return { dnd: data.dnd === true };
    },
    record(item) {
      const data = load();
      // No prompts, session message copies or arbitrary model output persisted.
      const entry = { at: now(), sessionId: item.sessionId, interactionId: item.interactionId,
        status: item.status, action: item.action, decisionId: item.decisionId, evidenceIds: item.evidenceIds };
      data.history = [...prune(data), entry].slice(-1000); atomicWriteJson(file, data);
    },
    history(sessionId) { return prune(load()).filter(item => sessionId && item.sessionId === sessionId); },
    // 2026-10-18：记录"最后一次看到用户"。前台每 5 秒轮询 facts，这里按分钟节流写盘；
    // 久不互动时靠它判断要不要把话推到应用外面（微信/通知）。
    touchSeen({ throttleMs = 60000 } = {}) {
      const data = load(), t = now();
      const previous = Number.isFinite(data.seenAt) ? data.seenAt : 0;
      if (previous && t - previous < throttleMs) return { seenAt: previous, gapMs: 0 };
      // 关键：把"这次隔了多久"在覆盖 seenAt 之前算出来，并在**同一次响应**里交回去。
      // 否则前端一打开就把 seenAt 刷成现在，"久别回来"永远判不出来（2026-10-19 真机踩到）。
      // 不落盘暂存：落盘会让同一段间隔被下一次轮询再消费一遍。
      const gapMs = previous ? Math.max(0, t - previous) : 0;
      data.seenAt = t;
      data.history = prune(data);
      atomicWriteJson(file, data);
      return { seenAt: t, gapMs };
    },
    seen() {
      const data = load();
      return {
        seenAt: Number.isFinite(data.seenAt) ? data.seenAt : 0,
        nudgeAt: Number.isFinite(data.nudgeAt) ? data.nudgeAt : 0,
      };
    },
    markNudge(at = now()) {
      const data = load(); data.nudgeAt = at; data.history = prune(data); atomicWriteJson(file, data);
      return { nudgeAt: at };
    },
  };
}
