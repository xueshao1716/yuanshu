// ===== watch-api.mjs —— 值班程序的 HTTP 接口（2026-11-07）=====
//
// 四个接口（与工具 watch_create/watch_list/watch_pause/watch_delete 一一对应）：
//   GET    /api/watches                 列出所有值班 + 限流参数
//   POST   /api/watches                 新建（body: {name, kind, spec, prompt, intervalMs, cooldownMs, dailyCap}）
//   POST   /api/watches/<id>/pause      暂停（body {paused:false} 则恢复）
//   DELETE /api/watches/<id>            删除
//
// 这里只做「参数进出 + 调用 duty」，真正的判定/限流/落盘都在 engine/watch-duty.mjs。

export function createWatchRoutes({ duty, json, readBody } = {}) {
  const getDuty = () => (typeof duty === "function" ? duty() : duty);
  const missing = (res) => json(res, 503, { ok: false, error: "值班程序未初始化（服务刚启动或初始化失败）" });

  return [
    ["GET", "/api/watches", (res) => {
      const d = getDuty();
      if (!d) return missing(res);
      try { return json(res, 200, { ok: true, watches: d.list(), summary: d.summary() }); }
      catch (e) { return json(res, 500, { ok: false, error: String(e?.message || e).slice(0, 200) }); }
    }],
    ["POST", "/api/watches", async (res, req) => {
      const d = getDuty();
      if (!d) return missing(res);
      try {
        const body = await readBody(req, 1);
        const out = d.create(body || {});
        return json(res, out.ok ? 200 : 400, out);
      } catch (e) { return json(res, 500, { ok: false, error: String(e?.message || e).slice(0, 200) }); }
    }],
    ["POST", /^\/api\/watches\/([^/]+)\/pause$/, async (res, req, url, m) => {
      const d = getDuty();
      if (!d) return missing(res);
      try {
        const body = await readBody(req, 1).catch(() => ({}));
        const out = body?.paused === false ? d.resume(decodeURIComponent(m[1])) : d.pause(decodeURIComponent(m[1]));
        return json(res, out.ok ? 200 : 404, out);
      } catch (e) { return json(res, 500, { ok: false, error: String(e?.message || e).slice(0, 200) }); }
    }],
    ["DELETE", /^\/api\/watches\/([^/]+)$/, (res, req, url, m) => {
      const d = getDuty();
      if (!d) return missing(res);
      try {
        const out = d.remove(decodeURIComponent(m[1]));
        return json(res, out.ok ? 200 : 404, out);
      } catch (e) { return json(res, 500, { ok: false, error: String(e?.message || e).slice(0, 200) }); }
    }],
  ];
}
