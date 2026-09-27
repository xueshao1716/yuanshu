// 聚合接口的响应级 TTL 缓存（2026-09-20 抽出，2026-09-20 修键）
//
// 由来：/api/stats/providers 要扫全部会话文件（实测 5.3s）、/api/run/overview 9.5s，
// 而前端每 5–8 秒轮一次 → 页面永远在等。这里把"同样的聚合结果"缓存 TTL 秒，
// 只对**明确列出的只读 GET** 生效（不碰流式/写接口），并带 X-Cache: HIT/MISS 便于核对。
//
// ⚠️ 键必须带上查询串（2026-09-20 修的真实事故）：
//   /api/run/overview 的返回内容**依赖 ?session=**（只列该会话的 run）。原来键是固定字符串
//   "run-overview"，于是"第一个请求的结果"被发给了所有会话——实测同一时刻用
//   session=A / session=B / 不传 三种方式请求，拿到的是同一份 A 的数据。
//   前端按当前会话在 recent 里找自己的 run，找不到就整块不渲染 →
//   聊天页底部的「运行状态 / 调了哪些工具 / 怎么交互」显示直接消失。
//   所以：**只要 handler 的输出受某个参数影响，这个参数就必须进键**。
export function createWithCache({ maxKeys = 64 } = {}) {
  const store = new Map();
  const limit = Number.isFinite(maxKeys) ? Math.max(0, Math.floor(maxKeys)) : 64;

  return function withCache(ttlMs, key, handler, { bypass = () => false } = {}) {
    return async (res, req, url, m) => {
      if (bypass(req, url)) return handler(res, req, url, m);
      const cacheKey = key + (url?.search || "");
      const hit = store.get(cacheKey);
      if (hit && Date.now() < hit.expiresAt) {
        try {
          res.writeHead(200, {
            ...hit.headers,
            "X-Cache": "HIT",
            "X-Cache-Age": String(Math.round((Date.now() - hit.at) / 1000)),
          });
        } catch {}
        return res.end(hit.body);
      }
      // 按会话分键之后条目会变多：顺手把过期的清掉，别无限堆
      for (const [k, v] of store) if (Date.now() >= v.expiresAt) store.delete(k);
      const parts = [];
      const headers = {};
      const append = (b, encoding) => {
        if (b != null) parts.push(Buffer.isBuffer(b) ? b : Buffer.from(b, encoding));
      };
      const shim = {
        // MISS 的头必须在 writeHead 之前设：handler 走的是 writeHead(code, headers)，
        // 一旦真的发出去再 setHeader 会被吞掉，"X-Cache: MISS" 就永远看不见了（只剩 HIT 可见）。
        writeHead: (...a) => {
          const h = typeof a[1] === "string" ? a[2] : a[1];
          if (Array.isArray(h)) {
            for (let i = 0; i < h.length; i += 2) headers[h[i]] = h[i + 1];
          } else Object.assign(headers, h);
          res.setHeader("X-Cache", "MISS");
          return res.writeHead(...a);
        },
        setHeader: (k, v) => { headers[k] = v; return res.setHeader(k, v); },
        getHeader: (...a) => { try { return res.getHeader(...a); } catch { return undefined; } },
        write: (b, encoding) => { append(b, encoding); return true; },
        end: (b, encoding) => {
          append(b, encoding);
          const body = Buffer.concat(parts);
          if (res.statusCode === 200 && ttlMs > 0 && limit > 0) {
            const at = Date.now();
            store.delete(cacheKey);
            const savedHeaders = {};
            for (const [name, value] of Object.entries({ ...headers, ...res.getHeaders?.() })) {
              if (/^x-cache(?:-age)?$/i.test(name)) continue;
              const previous = Object.keys(savedHeaders).find(k => k.toLowerCase() === name.toLowerCase());
              if (previous) delete savedHeaders[previous];
              savedHeaders[name] = value;
            }
            store.set(cacheKey, { at, expiresAt: at + ttlMs, body, headers: savedHeaders });
            while (store.size > limit) store.delete(store.keys().next().value);
          }
          try { res.setHeader("X-Cache", "MISS"); } catch {}
          res.end(body);
        },
        get statusCode() { return res.statusCode; },
        set statusCode(v) { res.statusCode = v; },
        get headersSent() { return res.headersSent; },
      };
      return handler(shim, req, url, m);
    };
  };
}
