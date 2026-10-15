// ===== http.test.mjs —— 统一 HTTP 客户端单测（原生 fetch 版）=====
// 验证与旧 python 子进程版的关键行为对齐：
//   非 2xx 也 resolve（fallback 链依赖）、默认 UA、超时文案 "timeout"、二进制完整性、回环直连。
import { test } from "node:test";
import assert from "node:assert";
import http from "node:http";
import { httpJsonFetch, httpBufferFetch } from "../../engine/http.mjs";

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}

test("http.mjs 统一 HTTP 客户端", async (t) => {
  const seen = {};
  const { srv, base } = await startServer((req, res) => {
    seen.url = req.url;
    seen.method = req.method;
    seen.ua = req.headers["user-agent"];
    seen.ct = req.headers["content-type"];
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.body = body;
      if (req.url === "/json") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: 1 })); return; }
      if (req.url === "/notfound") { res.statusCode = 404; res.end("nope"); return; }
      if (req.url === "/bin") { res.end(Buffer.from([0x00, 0xff, 0x10, 0x92])); return; }
      if (req.url === "/slow") { setTimeout(() => res.end("late"), 3000); return; }
      res.end("hello");
    });
  });
  t.after(() => new Promise((r) => srv.close(r)));

  await t.test("GET 200：status/ok/json 接口形状", async () => {
    const r = await httpJsonFetch(`${base}/json`);
    assert.equal(r.status, 200);
    assert.equal(r.ok, true);
    assert.deepEqual(await r.json(), { ok: 1 });
    assert.equal(await r.text(), JSON.stringify({ ok: 1 }));
  });

  await t.test("非 2xx 也 resolve（调用方 fallback 链依赖此行为）", async () => {
    const r = await httpJsonFetch(`${base}/notfound`);
    assert.equal(r.status, 404);
    assert.equal(r.ok, false);
    assert.equal(await r.text(), "nope");
    assert.equal(await r.json(), null); // 非 JSON body → null 而非抛错
  });

  await t.test("默认补浏览器 UA；自定义 UA 不被覆盖", async () => {
    await httpJsonFetch(`${base}/json`);
    assert.match(seen.ua || "", /^Mozilla\/5\.0/);
    await httpJsonFetch(`${base}/json`, { headers: { "User-Agent": "pi-web-test" } });
    assert.equal(seen.ua, "pi-web-test");
  });

  await t.test("POST：method/body/headers 透传", async () => {
    const r = await httpJsonFetch(`${base}/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
    assert.equal(r.status, 200);
    assert.equal(seen.method, "POST");
    assert.equal(seen.body, JSON.stringify({ a: 1 }));
    assert.equal(seen.ct, "application/json");
  });

  await t.test("超时：reject 且错误文案为 timeout", async () => {
    await assert.rejects(() => httpJsonFetch(`${base}/slow`, { timeout: 300 }), (err) => err.message === "timeout");
  });

  await t.test("连接失败（端口未监听）：reject", async () => {
    await assert.rejects(() => httpJsonFetch("http://127.0.0.1:1/x", { timeout: 2000 }));
  });

  await t.test("死代理自动降级直连：env 代理指向不存在的端口仍能请求成功", async () => {
    // 复刻 2026-08-20 真机事故：Clash 退出后 https_proxy 残留 → 全量 fetch failed
    // （本测试进程没有代理 env，直接注入再验证本地服务可达——活性探测 1.2s 内判死，降级直连）
    process.env.PI_WEB_TEST_FORCE_PROXY = "http://127.0.0.1:1"; // 端口 1 必然不通
    const origHttps = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = "http://127.0.0.1:1";
    try {
      const r = await httpJsonFetch(`${base}/json`, { timeout: 8000 });
      assert.equal(r.status, 200); // 走了直连而不是死代理
    } finally {
      process.env.HTTPS_PROXY = origHttps;
      delete process.env.PI_WEB_TEST_FORCE_PROXY;
    }
  });

  await t.test("二进制版：字节完整（不走文本 decode）", async () => {
    const r = await httpBufferFetch(`${base}/bin`);
    assert.equal(r.status, 200);
    const buf = r.buffer();
    assert.ok(Buffer.isBuffer(buf));
    assert.deepEqual([...buf], [0x00, 0xff, 0x10, 0x92]);
  });
});

test('境内模型域名直连，不走本机代理；境外仍走代理', async () => {
  const { isDomesticHost } = await import('../../engine/http.mjs');
  for (const h of ['api.stepfun.com', 'open.bigmodel.cn', 'fast.aieyra.cn', 'stepfun.com']) assert.equal(isDomesticHost(h), true, h);
  for (const h of ['api.openai.com', 'us-api.tokenhub.com', 'notstepfun.com', 'api-top.com']) assert.equal(isDomesticHost(h), false, h);
});
