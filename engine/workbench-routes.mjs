// Register once at startup, behind the server's existing authentication gate.
// Dependencies are injected: importing this module never starts jobs or reads a workspace.
export function createWorkbenchRoutes({ withCache, boardApi, historyApi, handleEmotion, emotion, json, readBody }) {
  const capture = async (fn) => {
    const parts = [];
    const shim = {
      writeHead: () => {}, setHeader: () => {}, getHeader: () => undefined,
      write: (b) => { parts.push(b); return true; },
      end: (b) => { if (b) parts.push(b); },
      get statusCode() { return 200; }, set statusCode(_v) {}, get headersSent() { return false; },
    };
    try { await fn(shim); } catch (e) { return { __error: String((e && e.message) || e).slice(0, 100) }; }
    try { return JSON.parse(parts.join('')); } catch { return null; }
  };

  return [
    ['GET', '/api/board/bootstrap', withCache(60000, 'board-bootstrap', res => boardApi.bootstrap(res))],
    ['GET', '/api/emotion/summary', withCache(20000, 'emotion-summary', async res => {
      const base = new URL('http://local/api/emotion');
      const [live, tide, feelings] = await Promise.all([
        capture(x => handleEmotion(x, base)),
        capture(x => json(x, 200, { tide: emotion.getTide(300) })),
        capture(x => json(x, 200, { feelings: emotion.getFeelings(50) })),
      ]);
      return json(res, 200, { emotion: live, tide: tide && tide.tide, feelings: feelings && feelings.feelings, at: new Date().toISOString() });
    })],
    ['GET', '/api/history', res => historyApi.list(res)],
    ['POST', '/api/history/rollback', async (res, req) => historyApi.rollback(res, await readBody(req, 8))],
  ];
}
